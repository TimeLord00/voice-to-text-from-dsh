/**
 * Resident dictation: two global hotkeys, an optional floating button, a microphone and a clipboard.
 *
 * This is the "use it in other applications" half of the tool. The process sits in the tray-less
 * background, owns two hotkeys, and on the second press pushes the recognized text into whatever
 * window has focus. With `overlay: true` it also shows the microphone button from src/overlay.mjs,
 * which drives exactly the same `begin`/`finish`/`discard` transitions — the hotkeys and the button
 * are two front ends on one session, so they can never disagree about what is recording.
 */
import { Dictation, describeDelivery, warmUpMicrophone } from './dictation.mjs'
import { MicButton } from './overlay.mjs'
import { Hotkeys, beep, warmUpAudio } from './win32.mjs'

/**
 * Start the dictation loop.
 * @param {object} config - effective configuration.
 * @param {import('./engine.mjs').SpeechEngine} engine - recognizer (loaded here so the first press is fast).
 * @param {{log?: (line: string) => void, paste?: boolean, clipboard?: boolean, beeps?: boolean,
 *   overlay?: boolean, hotkeysOptional?: boolean, onResult?: (result: object) => void,
 *   onQuit?: () => void}} [options]
 *   feedback and delivery switches; `overlay` mounts the floating microphone button, and
 *   `hotkeysOptional` keeps the session alive when another application already owns a hotkey.
 * @returns {{dictation: Dictation, hotkeys: Hotkeys, button: MicButton|null, stop: () => void,
 *   whenIdle: (timeoutMs?: number) => Promise<boolean>, hotkeyErrors: {description: string,
 *   message: string}[], busy: boolean}} running session.
 */
export function runDictation(config, engine, options = {}) {
  const log = options.log ?? ((line) => process.stdout.write(`${line}\n`))
  const hotkeys = new Hotkeys()
  let button = null
  const dictation = new Dictation(config, engine, {
    log,
    beeps: options.beeps,
    paste: options.paste,
    clipboard: options.clipboard,
    onText: options.onResult,
    onState: (state) => button?.setState(state),
  })
  let busy = false

  log('loading the speech model ...')
  const started = Date.now()
  engine.load()
  log(`model ready in ${((Date.now() - started) / 1000).toFixed(1)}s (${config.precision}${config.language ? `, ${config.language}` : ''})`)
  if (options.warmUpMicrophone !== false) warmUpMicrophone(log)
  // Wake the output device too: an endpoint that has been idle plays the first 100-300 ms into a device
  // that is still starting up, and that is long enough to swallow a whole cue (field report: "sometimes
  // there is a sound, sometimes there is not"). A silent buffer here moves that cost off the first cue.
  warmUpAudio()

  /** Start or stop, exactly as one press of the start/stop hotkey would. */
  const toggle = () => {
    if (busy) return
    if (dictation.recording) {
      busy = true
      dictation.finish()
        .then((result) => report(log, result))
        .catch((error) => log(`! ${error.message}`))
        .finally(() => { busy = false })
      return
    }
    try {
      dictation.begin()
      // The hotkey works whether or not the button is on screen; a recording that is running without a
      // visible button is confusing, so bring it back.
      if (!button?.window?.visible) button?.reveal('hotkey')
    } catch (error) {
      log(`! ${error.message}`)
      if (dictation.beeps) beep('error', config.beepVolume)
    }
  }

  /** Throw the current recording away. */
  const cancel = () => {
    if (dictation.recording) dictation.discard()
  }

  // A hotkey conflict must not take the whole session down when the button is the interface: the DSH
  // speech-to-text plugin holds ctrl+alt+space by default, and until this tolerated the clash the
  // floating button refused to appear at all — with no console window, that looked like "it does nothing".
  const hotkeyErrors = []
  const register = (description, handler) => {
    if (!options.hotkeysOptional) return hotkeys.register(description, handler)
    try {
      return hotkeys.register(description, handler)
    } catch (error) {
      hotkeyErrors.push({ description, message: String(error?.message ?? error) })
      log(`! the global hotkey ${description} is already taken by another application`)
      return null
    }
  }
  const toggleHotkey = register(config.hotkey, toggle)
  const cancelHotkey = config.cancelHotkey ? register(config.cancelHotkey, cancel) : null
  hotkeys.start()

  if (options.overlay) {
    button = new MicButton(config, {
      log,
      onToggle: toggle,
      onCancel: cancel,
      onQuit: options.onQuit ?? (() => {}),
      pump: hotkeys,
    })
    try {
      button.mount()
      button.setState(dictation.state)
    } catch (error) {
      // A missing button must not take dictation down with it: the hotkeys still work.
      log(`! the floating button is unavailable: ${error.message}`)
      button = null
    }
  }

  log('')
  if (button) {
    log('  the microphone button follows the text caret: click to start, click again to paste')
    log('  drag it to park it; right-click cancels; middle-click hides it')
    log('  the tray icon: left-click starts and stops, right-click opens the menu (show it again, quit)')
  }
  if (toggleHotkey) log(`  ${config.hotkey.padEnd(18)} start / stop recording`)
  else log(`  ${config.hotkey.padEnd(18)} unavailable (another application owns it); pass --hotkey`)
  if (cancelHotkey) log(`  ${config.cancelHotkey.padEnd(18)} discard the recording`)
  log(`  Ctrl+C${' '.repeat(12)} quit`)
  log('  "vtt overlay --stop" closes the button from another terminal')
  log('')
  log(options.paste === false
    ? '  recognized text goes to the clipboard only'
    : '  recognized text is copied and pasted into the focused window')
  if (config.keepRecordings) {
    // The recordings are the user's own voice, so this must never be a silent setting: whoever turned it
    // on (config.json or VTT_KEEP_RECORDINGS) sees it in the banner on every start.
    log('! keepRecordings is on: every recording is also kept in "recordings\\"')
    log('  turn it off to have the audio discarded as soon as it is transcribed')
  }
  log('')

  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    button?.dispose()
    hotkeys.dispose()
    dictation.dispose()
  }

  /**
   * Wait for an in-flight transcription to land.
   *
   * Shutting down while `finish()` is halfway through means the recognized text is thrown away and the
   * recorder is torn down while the audio stack is still closing it — the overlay's quit path waits
   * here first.
   * @param {number} [timeoutMs] - longest time to wait.
   * @returns {Promise<boolean>} whether the session became idle.
   */
  const whenIdle = async (timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs
    while (busy && Date.now() < deadline) await sleep(50)
    return !busy
  }

  return {
    dictation,
    hotkeys,
    button,
    stop,
    whenIdle,
    hotkeyErrors,
    /** @returns {boolean} whether a transcription is in flight. */
    get busy() {
      return busy
    },
  }
}

/**
 * @param {number} ms - milliseconds.
 * @returns {Promise<void>} resolves after the delay.
 */
function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/**
 * Print one transcription result.
 * @param {(line: string) => void} log - output sink.
 * @param {object} result - result from {@link Dictation.finish}.
 * @returns {void}
 */
function report(log, result) {
  // A recording that was too short to be worth transcribing already logged its own line inside
  // Dictation.finish (and played the failure cue); reporting it as an empty result would suggest the
  // recognizer ran and found nothing.
  if (result.discarded) {
    log('')
    return
  }
  const seconds = result.audioSeconds.toFixed(1)
  const inference = (result.inferenceSeconds * 1000).toFixed(0)
  log(`✔ ${seconds}s audio -> ${inference}ms (${describeDelivery(result)})`)
  log(result.text ? `  ${result.text}` : '  (no speech recognized)')
  // The measurement behind an empty result — including whether the voice detector agreed — is logged by
  // Dictation.finish, which every path goes through, so this only prints the line itself.
  log('')
}
