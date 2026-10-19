/**
 * One dictation session: microphone in, text out, clipboard and paste on the way.
 *
 * The class is state, not UI: the keyboard listener (src/dictate.mjs's `runDictation`) and the HTTP
 * bridge (`POST /dictate`) drive the same `begin`/`finish`/`discard` transitions, so both paths
 * behave identically, including beeps, auto-stop and error handling.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './config.mjs'
import { Microphone, beep, clearClipboard, clipboardHasData, copyText, cueStatus, foregroundWindowTitle, readClipboardText, sendPaste, targetIsProtected, tempRecordingPath } from './win32.mjs'
import { canonicalToFloat, describeCanonical, speechActivity, toCanonicalWav } from './wav.mjs'
import { explainNoSpeech } from './engine.mjs'

/** States a dictation session can be in. */
export const DictationState = { Idle: 'idle', Recording: 'recording', Transcribing: 'transcribing' }

/**
 * Drive the microphone and the recognizer for one process.
 */
export class Dictation {
  /**
   * @param {object} config - effective configuration.
   * @param {import('./engine.mjs').SpeechEngine} engine - loaded recognizer.
   * @param {{log?: (line: string) => void, beeps?: boolean, paste?: boolean, clipboard?: boolean,
   *   restoreClipboard?: boolean, restoreDelayMs?: number, onText?: (result: object) => void,
   *   onState?: (state: string) => void, readClipboard?: () => (string|null),
   *   writeClipboard?: (text: string, options?: object) => boolean, clearClipboard?: () => boolean,
   *   pasteKeys?: () => boolean, clipboardHasData?: () => boolean,
   *   targetIsProtected?: () => boolean}} [options]
   *   feedback and delivery switches; `onState` reports every transition, which is how the floating
   *   button (src/overlay.mjs) knows when to change colour. The clipboard functions are injectable so
   *   the delivery rules can be tested without touching the real clipboard; they default to the Win32
   *   implementations in src/win32.mjs.
   */
  constructor(config, engine, options = {}) {
    this.config = config
    this.engine = engine
    this.log = options.log ?? (() => {})
    this.beeps = options.beeps ?? config.beeps
    this.paste = options.paste ?? true
    this.clipboard = options.clipboard ?? true
    // Delivery must not leave the recognized text behind in the clipboard: the paste needs it for a
    // moment, so the contents from just before the write are put back right after (see `deliver`).
    this.restoreClipboard = options.restoreClipboard ?? config.restoreClipboard !== false
    this.restoreDelayMs = options.restoreDelayMs ?? config.restoreDelayMs ?? 150
    this.readClipboard = options.readClipboard ?? readClipboardText
    this.writeClipboard = options.writeClipboard ?? copyText
    this.clearClipboard = options.clearClipboard ?? clearClipboard
    this.pasteKeys = options.pasteKeys ?? sendPaste
    this.clipboardHasData = options.clipboardHasData ?? clipboardHasData
    this.targetIsProtected = options.targetIsProtected ?? targetIsProtected
    this.foregroundTitle = options.foregroundTitle ?? foregroundWindowTitle
    this.state = DictationState.Idle
    this.microphone = null
    this.autoStopTimer = null
    this.lastResult = null
    this.onText = options.onText ?? null
    this.onState = options.onState ?? null
    /** Set once, so a device that always refuses the cue does not spam the log. @type {boolean} */
    this.cueProblemLogged = false
    /** Whether a `finish()` call is in flight; a state of `transcribing` without this is a wedge. @type {boolean} */
    this.finishing = false
  }

  /**
   * Move to a new state, telling the observer once.
   * @param {string} state - one of {@link DictationState}.
   * @returns {void}
   */
  setState(state) {
    if (this.state === state) return
    this.state = state
    if (this.onState) {
      try {
        this.onState(state)
      } catch (error) {
        this.log(`state observer failed: ${error.message}`)
      }
    }
  }

  /** @returns {boolean} whether a recording is in progress. */
  get recording() {
    return this.state === DictationState.Recording
  }

  /**
   * Play one dictation cue, and say so when the audio device refuses it.
   *
   * A cue can go missing in two very different ways, and the log has to tell them apart: the device can
   * refuse our buffer (then Windows' own scheme sound plays, which is itself silent when that scheme
   * entry is set to (None)), or the buffer can play into an endpoint that is still waking up from power
   * save. {@link playCue} handles the second case with a silent pre-roll; this records the first one.
   * @param {'start'|'stop'|'done'|'error'} kind - which cue to play.
   * @returns {boolean} whether our own cue played.
   */
  cue(kind) {
    if (!this.beeps) return false
    const played = beep(kind, this.config.beepVolume)
    if (!played && !this.cueProblemLogged) {
      this.cueProblemLogged = true
      this.log(`! the audio device refused the ${kind} cue (${cueStatus().error ?? 'unknown reason'})`)
      this.log('  the Windows system sound was used instead, and that is silent when its scheme entry is (None)')
      this.log('  check the default output device in 声音设置; --no-beeps turns the cues off')
    }
    return played
  }

  /** @returns {number} seconds recorded so far. */
  get elapsedSeconds() {
    return this.microphone?.elapsedSeconds ?? 0
  }

  /**
   * Start recording. Safe to call while already recording (it is then a no-op).
   * @returns {{state: string, seconds: number}} new state.
   */
  begin() {
    if (this.state === DictationState.Recording) return { state: this.state, seconds: this.elapsedSeconds }
    if (this.state === DictationState.Transcribing) {
      // Only a `finish()` that is actually running may refuse a new recording. A state left behind by a
      // failed transcription refuses every later recording forever — the floating button then stays
      // yellow with three dots and answers each click with an error cue — so a begin() that arrives with
      // nothing in flight recovers instead of blocking.
      if (this.finishing) throw new Error('Still transcribing the previous recording')
      this.log('! the previous transcription did not finish cleanly; recovering')
      this.setState(DictationState.Idle)
    }
    this.engine.load()
    this.microphone ??= new Microphone()
    const startedAt = Date.now()
    this.microphone.start()
    const captureMs = Date.now() - startedAt
    this.setState(DictationState.Recording)
    this.cue('start')
    // How long the device took to start streaming: the user's "the first time it cannot hear me" is a
    // question about exactly this number, so it belongs in the log rather than in a support round trip.
    this.log(`● recording (max ${this.config.maxSeconds}s, capture live after ${captureMs}ms)`)
    this.autoStopTimer = setTimeout(() => {
      this.log(`auto-stop after ${this.config.maxSeconds}s`)
      this.finish().catch((error) => this.log(`transcription failed: ${error.message}`))
    }, this.config.maxSeconds * 1000)
    this.autoStopTimer.unref?.()
    return { state: this.state, seconds: 0 }
  }

  /**
   * Stop recording, transcribe and deliver the text to the focused window.
   *
   * Every exit from this method leaves the machine idle. That is a hard rule, not tidiness: a state stuck
   * on `transcribing` refuses every later recording with "Still transcribing the previous recording",
   * and with the floating button it shows as an icon that stays yellow with three dots while every click
   * only produces the error cue. A double click that produced a 0.3 s recording was enough to do exactly
   * that in the field, because the too-short branch threw and the state was never reset.
   * @returns {Promise<{text: string, seconds: number, inferenceMs: number, pasted: boolean, clipboard: boolean, target: string, peakDbfs: number}>}
   *   the transcription result; `peakDbfs` is the capture level, which is what tells a quiet microphone
   *   apart from a silent one when nothing was recognized. A recording shorter than `minSeconds` comes
   *   back with `text: ''` and `discarded: true` instead of throwing — it is a change of mind, not a
   *   failure.
   */
  async finish() {
    if (this.state !== DictationState.Recording) throw new Error('Not recording')
    clearTimeout(this.autoStopTimer)
    this.autoStopTimer = null
    this.finishing = true
    this.setState(DictationState.Transcribing)
    const seconds = this.elapsedSeconds
    const path = tempRecordingPath()
    let format = null
    try {
      let canonical
      try {
        if (seconds < this.config.minSeconds) {
          this.microphone.discard()
          this.cue('error')
          this.log(`✕ discarded ${seconds.toFixed(1)}s (shorter than ${this.config.minSeconds}s); press again and speak a little longer`)
          return {
            text: '',
            audioSeconds: seconds,
            inferenceSeconds: 0,
            segments: 0,
            discarded: true,
            pasted: false,
            clipboard: false,
            target: foregroundWindowTitle(),
          }
        }
        const saved = this.microphone.save(path)
        format = saved.format
        canonical = toCanonicalWav(readFileSync(path), format)
      } finally {
        rmSync(path, { force: true })
        this.microphone.close()
      }
      const size = describeCanonical(canonical)
      // A level report costs one pass over the samples and answers the most common field question —
      // "why did it say nothing?" — the moment the result comes back, instead of leaving the user to
      // wonder whether the microphone was even heard.
      const peakDbfs = speechActivity(canonicalToFloat(canonical)).peakDbfs
      if (this.config.keepRecordings) this.log(`  kept the recording at ${keepRecording(canonical)}`)
      this.log(`… transcribing ${size.seconds.toFixed(1)}s of audio (peak ${peakDbfs.toFixed(1)} dBFS)`)
      const result = this.engine.transcribe(canonical, this.config.language)
      // The engine refuses to decode a recording that is nothing but its own noise floor. That refusal is
      // correct but opaque — "nothing was recognized" for a user who just spoke is the complaint that
      // started this — so the measurement behind the decision goes into the log, including the detector's
      // second opinion when the model happened to be resident.
      if (!result.text && result.reason === 'no-speech-activity') {
        for (const line of explainNoSpeech(result, this.config)) this.log(`  ${line}`)
      }
      const delivery = await this.deliver(result.text)
      this.setState(DictationState.Idle)
      this.lastResult = { ...result, ...delivery, format, peakDbfs }
      this.cue(result.text ? 'done' : 'error')
      if (this.onText) this.onText(this.lastResult)
      return this.lastResult
    } finally {
      // Safety net for anything unforeseen above (a device error, a failed decode, a throwing paste):
      // the caller logs the message, but the state must never be left half-way through a transition.
      this.finishing = false
      if (this.state !== DictationState.Idle) this.setState(DictationState.Idle)
    }
  }

  /**
   * Deliver recognized text: clipboard, a synthetic Ctrl+V, and then the clipboard back the way it was.
   *
   * The clipboard is the only way into an arbitrary foreign window, so "do not leave my text behind" is
   * implemented as a restore rather than as an alternative transport: the contents are captured
   * immediately before the write and put back right after the paste. Four guards keep that honest:
   * the snapshot is taken as late as possible (something copied during the recording is still the
   * newest content), the text is only put back when the clipboard still holds exactly our own text (a
   * copy made while the paste was in flight wins), nothing is put back when the paste did not happen at
   * all — then the text stays where the user can paste it by hand — and nothing is put back when the
   * focused window is at a higher integrity level, because Windows ignores synthetic input there and the
   * clipboard is the user's only way to get the text.
   *
   * @param {string} text - recognized text.
   * @returns {Promise<{pasted: boolean, clipboard: boolean, target: string, restored: boolean,
   *   cleared: boolean, keptText: boolean, keptOther: boolean, targetProtected: boolean}>} what actually
   *   happened.
   */
  async deliver(text) {
    const target = this.foregroundTitle()
    const result = { pasted: false, clipboard: false, target, restored: false, cleared: false, keptText: false, keptOther: false, targetProtected: false }
    if (!text) return result
    const restore = this.restoreClipboard
    const previous = this.clipboard && restore ? this.readClipboard() : null
    // Only text can be read back and restored. What is left when the clipboard held an image or files is
    // reported instead of being silently dropped.
    const hadOther = this.clipboard && restore && previous === null ? this.clipboardHasData() : false
    const copied = this.clipboard ? this.writeClipboard(text, restore ? { excludeFromHistory: true } : undefined) : false
    result.clipboard = copied
    if (this.paste && copied) {
      // Let the target window settle before injecting the keystroke; the loop stays responsive
      // because finish() is asynchronous.
      await sleep(this.config.pasteDelayMs)
      result.pasted = this.pasteKeys()
    }
    if (!copied || !restore) {
      result.keptText = copied
      return result
    }
    if (this.readClipboard() !== text) {
      result.keptOther = true
      result.keptText = true
      return result
    }
    if (!result.pasted) {
      // Nothing reached the target window, so the text is deliberately left on the clipboard: taking it
      // away here would leave the user with no way to use what was just recognized.
      result.keptText = true
      return result
    }
    if (this.targetIsProtected()) {
      // Windows blocks synthetic input from a lower integrity level, so the Ctrl+V was probably ignored.
      // Taking the text off the clipboard here would leave the user with nothing to paste by hand.
      result.targetProtected = true
      result.keptText = true
      this.log('! the focused window runs with higher privileges, so Windows may have ignored the paste;')
      this.log('  the text is left on the clipboard so you can press Ctrl+V yourself')
      return result
    }
    // The target application reads the clipboard while handling the injected Ctrl+V, which happens after
    // sendPaste() returns, so the restore waits a moment before pulling the text away.
    await sleep(this.restoreDelayMs)
    if (previous !== null) {
      result.restored = this.writeClipboard(previous)
      if (!result.restored) this.log('! the clipboard could not be put back; it still holds the recognized text')
    } else {
      result.cleared = this.clearClipboard()
      if (!result.cleared) this.log('! the clipboard could not be emptied; it still holds the recognized text')
      else if (hadOther) this.log('! the clipboard held something that is not text; it was emptied after the paste')
    }
    return result
  }

  /** Abandon the current recording without transcribing anything. */
  discard() {
    if (this.state !== DictationState.Recording) return { state: this.state, seconds: 0 }
    clearTimeout(this.autoStopTimer)
    this.autoStopTimer = null
    const seconds = this.elapsedSeconds
    this.microphone?.discard()
    this.microphone?.close()
    this.setState(DictationState.Idle)
    this.cue('stop')
    this.log(`✕ discarded ${seconds.toFixed(1)}s`)
    return { state: this.state, seconds }
  }

  /** Release the microphone and the auto-stop timer. */
  dispose() {
    clearTimeout(this.autoStopTimer)
    this.autoStopTimer = null
    this.microphone?.close()
    this.microphone = null
    this.setState(DictationState.Idle)
  }
}

/**
 * One phrase describing what happened to the recognized text, shared by the report line of every
 * command so the delivery rules read the same everywhere.
 * @param {object} [delivery] - a `deliver()` (or `finish()`) result.
 * @returns {string} human-readable summary, without the surrounding parentheses.
 */
export function describeDelivery(delivery = {}) {
  const where = delivery.target || 'the focused window'
  if (delivery.pasted) {
    if (delivery.restored) return `pasted into ${where}, clipboard restored`
    if (delivery.cleared) return `pasted into ${where}, clipboard emptied`
    if (delivery.keptOther) return `pasted into ${where}, clipboard kept (it changed meanwhile)`
    if (delivery.targetProtected) return `pasted into ${where} (elevated window: the key press may have been ignored), text left on the clipboard`
    if (delivery.keptText) return `pasted into ${where}, text left on the clipboard`
    return `pasted into ${where}`
  }
  if (delivery.clipboard) return 'copied to the clipboard'
  return 'not delivered'
}

/**
 * Wait without blocking the event loop.
 * @param {number} ms - milliseconds to wait.
 * @returns {Promise<void>} resolved after the delay.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Block the thread for a few milliseconds; the capture warm-up happens before the button exists, so
 * there is nothing else to do while the device comes up.
 * @param {number} ms - milliseconds to wait.
 * @returns {void}
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Start and stop the capture device once, before the user can click anything.
 *
 * The user reported that the first thing he says after starting the tool is not recorded: "there is a
 * start-up step". The measured cost of opening the waveaudio device is small on this machine (76 ms
 * cold, 30 ms warm), but a sleeping USB or Bluetooth microphone can take far longer, and that cost
 * would land on the first recording only. Spending it at start-up instead makes the first click as fast
 * as every later one, and the measured number is logged so the claim stays checkable.
 * @param {(line: string) => void} [log] - log sink.
 * @returns {number} milliseconds the warm-up took.
 */
export function warmUpMicrophone(log = () => {}) {
  const microphone = new Microphone()
  const startedAt = Date.now()
  try {
    microphone.open()
    microphone.start()
    sleepSync(180)
    microphone.stop()
    microphone.discard()
    microphone.close()
    const spent = Date.now() - startedAt
    log(`microphone ready in ${spent}ms`)
    return spent
  } catch (error) {
    log(`! the microphone did not answer: ${error?.message ?? error}`)
    try {
      microphone.close()
    } catch {
      // The device may never have opened; there is nothing to release.
    }
    return Date.now() - startedAt
  }
}

/**
 * Write a copy of the canonical recording into `recordings/` so a wrong or empty result can be
 * diagnosed afterwards (level, noise, clipping). Only used when `keepRecordings` is on, because a
 * dictation tool should not silently leave the user's voice on disk.
 * @param {Buffer} canonical - 16 kHz mono PCM WAV.
 * @returns {string} absolute path of the kept file.
 */
export function keepRecording(canonical) {
  const dir = join(ROOT, 'recordings')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.wav`)
  writeFileSync(path, canonical)
  return path
}
