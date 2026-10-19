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
import { Microphone, beep, copyText, foregroundWindowTitle, readClipboardText, sendPaste, tempRecordingPath } from './win32.mjs'
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
   *   onText?: (result: object) => void, onState?: (state: string) => void}} [options]
   *   feedback and delivery switches; `onState` reports every transition, which is how the floating
   *   button (src/overlay.mjs) knows when to change colour.
   */
  constructor(config, engine, options = {}) {
    this.config = config
    this.engine = engine
    this.log = options.log ?? (() => {})
    this.beeps = options.beeps ?? config.beeps
    this.paste = options.paste ?? true
    this.clipboard = options.clipboard ?? true
    this.state = DictationState.Idle
    this.microphone = null
    this.autoStopTimer = null
    this.lastResult = null
    this.previousClipboard = null
    this.onText = options.onText ?? null
    this.onState = options.onState ?? null
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
    if (this.state === DictationState.Transcribing) throw new Error('Still transcribing the previous recording')
    this.engine.load()
    this.microphone ??= new Microphone()
    const startedAt = Date.now()
    this.microphone.start()
    const captureMs = Date.now() - startedAt
    this.previousClipboard = this.clipboard ? readClipboardText() : null
    this.setState(DictationState.Recording)
    if (this.beeps) beep('start', this.config.beepVolume)
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
   * @returns {Promise<{text: string, seconds: number, inferenceMs: number, pasted: boolean, clipboard: boolean, target: string, peakDbfs: number}>}
   *   the transcription result; `peakDbfs` is the capture level, which is what tells a quiet microphone
   *   apart from a silent one when nothing was recognized.
   */
  async finish() {
    if (this.state !== DictationState.Recording) throw new Error('Not recording')
    clearTimeout(this.autoStopTimer)
    this.autoStopTimer = null
    this.setState(DictationState.Transcribing)
    const seconds = this.elapsedSeconds
    const path = tempRecordingPath()
    let canonical
    let format
    try {
      if (seconds < this.config.minSeconds) {
        this.microphone.discard()
        if (this.beeps) beep('error', this.config.beepVolume)
        throw new Error(`Recording was only ${seconds.toFixed(1)}s (shorter than ${this.config.minSeconds}s); ignored`)
      }
      const saved = this.microphone.save(path)
      format = saved.format
      const raw = readFileSync(path)
      canonical = toCanonicalWav(raw, format)
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
    if (this.beeps) beep(result.text ? 'done' : 'error', this.config.beepVolume)
    if (this.onText) this.onText(this.lastResult)
    return this.lastResult
  }

  /**
   * Deliver recognized text: clipboard first, then a synthetic Ctrl+V.
   * @param {string} text - recognized text.
   * @returns {Promise<{pasted: boolean, clipboard: boolean, target: string}>} what actually happened.
   */
  async deliver(text) {
    const target = foregroundWindowTitle()
    if (!text) return { pasted: false, clipboard: false, target }
    const copied = this.clipboard ? copyText(text) : false
    let pasted = false
    if (this.paste && copied) {
      // Let the target window settle before injecting the keystroke; the loop stays responsive
      // because finish() is asynchronous.
      await new Promise((resolve) => setTimeout(resolve, this.config.pasteDelayMs))
      pasted = sendPaste()
    }
    return { pasted, clipboard: copied, target }
  }

  /** Abandon the current recording without transcribing anything. */
  discard() {
    if (this.state !== DictationState.Recording) return { state: this.state, seconds: 0 }
    clearTimeout(this.autoStopTimer)
    this.autoStopTimer = null
    const seconds = this.elapsedSeconds
    this.microphone?.discard()
    this.microphone?.close()
    if (this.clipboard && this.previousClipboard !== null) copyText(this.previousClipboard)
    this.setState(DictationState.Idle)
    if (this.beeps) beep('stop', this.config.beepVolume)
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
