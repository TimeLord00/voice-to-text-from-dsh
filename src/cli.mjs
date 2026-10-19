/**
 * Command line interface.
 *
 * The commands are deliberately small and composable: `record` writes a canonical WAV, `transcribe`
 * turns one into text, `listen` is the two of them in a row, `dictate` adds a global hotkey and
 * `serve` exposes the same recognizer over HTTP. Every command supports `--json` where a script
 * would want to parse the result.
 */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createEngine, explainNoSpeech } from './engine.mjs'
import { DEFAULTS, LANGUAGES, ROOT, loadConfig, readConfigFile, resolveModels } from './config.mjs'
import { Dictation, keepRecording } from './dictation.mjs'
import { runDictation } from './dictate.mjs'
import { formatChecks, runDoctor } from './doctor.mjs'
import { fetchModels, modelStatus, verifyModels } from './models.mjs'
import { startApiServer } from './server.mjs'
import { Microphone, beep, copyText, sendPaste, tempRecordingPath } from './win32.mjs'
import { describeCanonical, toCanonicalWav } from './wav.mjs'

const VERSION = '0.1.0'

/** Source files whose timestamp identifies the running build. */
const STAMP_FILES = ['cli.mjs', 'overlay.mjs', 'tray.mjs', 'win32-gui.mjs', 'dictate.mjs', 'dictation.mjs', 'win32.mjs']

/**
 * Identify the code that is running, from the version and the newest source timestamp.
 *
 * This exists because of a real field report: a button that "disappeared and could not be brought back"
 * turned out to be an old process from a previous build, and nothing in the log said which build it was.
 * Reading timestamps rather than asking git keeps it working in a copy without a repository.
 * @returns {string} one log line naming the version and when the source last changed.
 */
function codeStamp() {
  let newest = 0
  for (const name of STAMP_FILES) {
    try {
      const at = statSync(join(ROOT, 'src', name)).mtimeMs
      if (at > newest) newest = at
    } catch {
      // A missing file only means the stamp is older than it could be.
    }
  }
  const when = newest ? new Date(newest).toLocaleString('sv-SE').slice(0, 16) : 'unknown'
  return `voice-to-text ${VERSION} (source last changed ${when})`
}

/** Flag names that map onto configuration keys. */
const CONFIG_FLAGS = {
  language: 'language',
  precision: 'precision',
  threads: 'threads',
  hotkey: 'hotkey',
  cancelHotkey: 'cancelHotkey',
  maxSeconds: 'maxSeconds',
  minSeconds: 'minSeconds',
  segmentSeconds: 'segmentSeconds',
  vadThreshold: 'vadThreshold',
  minSpeechSeconds: 'minSpeechSeconds',
  minSilenceSeconds: 'minSilenceSeconds',
  speechMarginDb: 'speechMarginDb',
  minSpeechFrames: 'minSpeechFrames',
  port: 'port',
  token: 'token',
  beeps: 'beeps',
  beepVolume: 'beepVolume',
  keepRecordings: 'keepRecordings',
  pasteDelayMs: 'pasteDelayMs',
  idleTimeoutMs: 'idleTimeoutMs',
}

/**
 * Run the command line.
 * @param {string[]} argv - arguments after the executable.
 * @returns {Promise<number>} process exit code.
 */
export async function main(argv) {
  const { command, positional, flags } = parseArgs(argv)
  const overrides = {}
  for (const [flag, key] of Object.entries(CONFIG_FLAGS)) {
    if (flags[flag] !== undefined) overrides[key] = flags[flag]
  }
  if (flags.modelDir) overrides.models = { modelDir: String(flags.modelDir) }
  if (flags.vadPath) overrides.models = { ...overrides.models, vadPath: String(flags.vadPath) }
  if (flags.language && !LANGUAGES.includes(String(flags.language))) {
    throw new Error(`unsupported language "${flags.language}"; expected one of ${LANGUAGES.join(', ')}`)
  }

  switch (command) {
    case 'help': case undefined: printHelp(); return 0
    case 'version': process.stdout.write(`${VERSION}\n`); return 0
    case 'transcribe': return commandTranscribe(positional, flags)
    case 'record': return commandRecord(positional, flags)
    case 'listen': return commandListen(positional, flags, overrides)
    case 'dictate': return commandDictate(flags, overrides)
    case 'overlay': case 'button': return commandOverlay(flags, overrides)
    case 'serve': return commandServe(flags, overrides)
    case 'models': case 'fetch-models': return commandModels(flags, overrides, command === 'fetch-models')
    case 'doctor': return commandDoctor(flags, overrides)
    case 'config': return commandConfig(flags, overrides)
    default:
      process.stderr.write(`unknown command "${command}"\n\n`)
      printHelp()
      return 2
  }
}

/**
 * Split argv into a command, positional arguments and flags.
 * @param {string[]} argv - raw arguments.
 * @returns {{command: string|undefined, positional: string[], flags: Record<string, any>}} parsed form.
 */
export function parseArgs(argv) {
  const positional = []
  const flags = {}
  let index = 0
  while (index < argv.length) {
    const arg = argv[index]
    if (arg === '--') {
      positional.push(...argv.slice(index + 1))
      break
    }
    if (arg === '-h') { flags.help = true; index += 1; continue }
    if (arg === '-j') { flags.json = true; index += 1; continue }
    if (arg === '-l' || arg === '-o' || arg === '-s' || arg === '-p') {
      const names = { '-l': 'language', '-o': 'out', '-s': 'seconds', '-p': 'port' }
      flags[names[arg]] = coerce(argv[index + 1])
      index += 2
      continue
    }
    if (arg.startsWith('--no-')) { flags[camel(arg.slice(5))] = false; index += 1; continue }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=')
      if (equals > 2) {
        flags[camel(arg.slice(2, equals))] = coerce(arg.slice(equals + 1))
        index += 1
        continue
      }
      const name = camel(arg.slice(2))
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('-')) {
        flags[name] = coerce(next)
        index += 2
        continue
      }
      flags[name] = true
      index += 1
      continue
    }
    positional.push(arg)
    index += 1
  }
  const [command, ...rest] = positional
  return { command, positional: rest, flags }
}

/**
 * Convert a kebab-case flag into camelCase.
 * @param {string} name - flag name.
 * @returns {string} camelCase name.
 */
function camel(name) {
  return name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
}

/**
 * Turn a flag value into a number or boolean when it looks like one.
 * @param {string} value - raw flag value.
 * @returns {string|number|boolean} coerced value.
 */
function coerce(value) {
  if (value === undefined) return true
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return value
}

/**
 * `vtt transcribe <file>`: file to text.
 * @param {string[]} positional - positional arguments.
 * @param {Record<string, any>} flags - parsed flags.
 * @returns {Promise<number>} exit code.
 */
async function commandTranscribe(positional, flags) {
  const file = positional[0]
  if (!file) throw new Error('usage: vtt transcribe <file.wav> [--language zh] [--copy] [--paste] [--json]')
  if (!existsSync(file)) throw new Error(`file not found: ${file}`)
  const config = loadConfig(flagsToConfig(flags))
  const engine = createEngine(config, resolveModels)
  const bytes = readFileSync(file)
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error(`${file} is not a RIFF/WAVE file. Only WAV is supported (no MP3/M4A decoder is bundled); `
      + 'convert it first, for example with ffmpeg -i input.mp3 -ar 16000 -ac 1 output.wav')
  }
  const canonical = toCanonicalWav(bytes)
  const result = engine.transcribe(canonical, config.language)
  const delivery = deliver(result.text, flags)
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ file: resolve(file), text: result.text, seconds: result.audioSeconds, inferenceMs: Math.round(result.inferenceSeconds * 1000), segments: result.segments, peakDbfs: Number(result.peakDbfs.toFixed(1)), reason: result.reason ?? null, ...delivery }, null, 2)}\n`)
  } else {
    process.stdout.write(`${result.text}\n`)
    // Same report as `vtt listen`: an empty result is otherwise indistinguishable from a silent file.
    // When the gate refused, its explanation already begins with the measured level.
    if (result.reason === 'no-speech-activity') {
      for (const line of explainNoSpeech(result, config)) process.stdout.write(`  ${line}\n`)
    } else {
      process.stdout.write(`  level ${result.peakDbfs.toFixed(1)} dBFS\n`)
    }
  }
  return result.text ? 0 : 3
}

/**
 * `vtt record`: microphone to canonical WAV file.
 * @param {string[]} positional - positional arguments.
 * @param {Record<string, any>} flags - parsed flags.
 * @returns {Promise<number>} exit code.
 */
async function commandRecord(positional, flags) {
  const seconds = Number(flags.seconds ?? positional[0] ?? 5)
  const out = resolve(String(flags.out ?? positional[1] ?? defaultRecordingName()))
  const microphone = new Microphone()
  const scratch = tempRecordingPath()
  try {
    process.stdout.write(`recording ${seconds}s ...\n`)
    microphone.start()
    await sleep(seconds * 1000)
    const saved = microphone.save(scratch)
    const canonical = toCanonicalWav(readFileSync(saved.path), saved.format)
    writeFileSync(out, canonical)
    rmSyncSafe(scratch)
    const size = describeCanonical(canonical)
    if (flags.json) process.stdout.write(`${JSON.stringify({ file: out, seconds: Number(size.seconds.toFixed(2)), kilobytes: size.kilobytes, captured: saved.format }, null, 2)}\n`)
    else process.stdout.write(`wrote ${out} (${size.seconds.toFixed(2)}s, ${size.kilobytes} KB, 16 kHz mono)\n`)
    return 0
  } finally {
    microphone.close()
  }
}

/**
 * `vtt listen`: record once, transcribe, deliver.
 * @param {string[]} positional - positional arguments.
 * @param {Record<string, any>} flags - parsed flags.
 * @param {object} overrides - configuration overrides from flags.
 * @returns {Promise<number>} exit code.
 */
async function commandListen(positional, flags, overrides) {
  const seconds = Number(flags.seconds ?? positional[0] ?? 5)
  const config = loadConfig(overrides)
  const engine = createEngine(config, resolveModels)
  const microphone = new Microphone()
  try {
    process.stdout.write(`loading the speech model ...\n`)
    const started = Date.now()
    engine.load()
    process.stdout.write(`model ready in ${((Date.now() - started) / 1000).toFixed(1)}s\n`)
    if (config.keepRecordings) {
      // Never a silent setting: this is the user's own voice being written to disk.
      process.stdout.write('! keepRecordings is on: the recording is also written to recordings\\\n')
    }
    process.stdout.write(`● recording ${seconds}s — speak now\n`)
    microphone.start()
    // After the recorder is live, never before: the cue blocks for its own length (see playCue), and
    // starting the device first is what keeps the first syllable of the sentence from being lost.
    if (config.beeps) beep('start', config.beepVolume)
    await sleep(seconds * 1000)
    const saved = microphone.save(tempRecordingPath())
    const canonical = toCanonicalWav(readFileSync(saved.path), saved.format)
    rmSyncSafe(saved.path)
    if (config.keepRecordings) process.stdout.write(`  kept the recording at ${keepRecording(canonical)}\n`)
    const result = engine.transcribe(canonical, config.language)
    const delivery = deliver(result.text, flags)
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ text: result.text, seconds: result.audioSeconds, inferenceMs: Math.round(result.inferenceSeconds * 1000), segments: result.segments, peakDbfs: Number(result.peakDbfs.toFixed(1)), reason: result.reason ?? null, ...delivery }, null, 2)}\n`)
    } else {
      process.stdout.write(`${result.text || '(no speech recognized)'}\n`)
      // The measurement behind an empty result, so "the microphone was not heard" and "the gate refused a
      // quiet recording" do not look identical from the outside. The explanation's first line already
      // carries the level, so the standalone report is only printed when the gate let the audio through.
      if (result.reason === 'no-speech-activity') {
        for (const line of explainNoSpeech(result, config)) process.stdout.write(`  ${line}\n`)
      } else {
        process.stdout.write(`  level ${result.peakDbfs.toFixed(1)} dBFS\n`)
      }
      if (delivery.pasted) process.stdout.write(`(pasted into ${delivery.target || 'the focused window'})\n`)
      else if (delivery.clipboard) process.stdout.write('(copied to the clipboard)\n')
    }
    return result.text ? 0 : 3
  } finally {
    microphone.close()
  }
}

/**
 * `vtt dictate`: resident hotkey dictation.
 * @param {Record<string, any>} flags - parsed flags.
 * @param {object} overrides - configuration overrides from flags.
 * @returns {Promise<number>} exit code (resolves when the user presses Ctrl+C).
 */
async function commandDictate(flags, overrides) {
  const config = loadConfig(overrides)
  const engine = createEngine(config, resolveModels)
  const session = runDictation(config, engine, {
    paste: flags.paste !== false,
    clipboard: flags.clipboard !== false,
    beeps: flags.beeps !== false,
    // `--overlay` adds the floating button to the hotkeys; `vtt overlay` is the button-first version.
    overlay: flags.overlay === true,
    onResult: flags.json ? (result) => process.stdout.write(`${JSON.stringify(result)}\n`) : undefined,
  })
  return new Promise((resolvePromise) => {
    // A promise that is merely pending does not keep Node alive. Hold the process open explicitly so
    // `dictate` stays resident even if no hotkey ended up registered (the message pump normally keeps
    // it alive on its own); without this the banner printed and the process exited at once.
    const keepAlive = setInterval(() => {}, 1 << 30)
    let done = false
    const shutdown = async () => {
      if (done) return
      done = true
      process.stdout.write('\nstopping ...\n')
      // A transcription already in flight owns the recognized text; let it land before tearing down.
      await session.whenIdle()
      clearInterval(keepAlive)
      session.stop()
      resolvePromise(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  })
}

/**
 * `vtt overlay`: resident dictation with the floating microphone button.
 *
 * With `--stop` it does not start anything: it looks for a running button and posts WM_CLOSE to it,
 * which is how a button started without a console window gets shut down again.
 * @param {Record<string, any>} flags - parsed flags.
 * @param {object} overrides - configuration overrides from flags.
 * @returns {Promise<number>} exit code (resolves when the button is closed or Ctrl+C is pressed).
 */
async function commandOverlay(flags, overrides) {
  const { buttonProcessId, findButtonWindow, reviveButtonWindow, stopButton } = await import('./win32-gui.mjs')
  const target = logTarget(flags)
  if (flags.stop) {
    // Asking is the normal path; when Windows refuses to deliver the message across privilege levels
    // the only useful answer is to end the process that owns the window, and to say which one it was.
    const result = await stopButton({ force: flags.force !== false })
    const message = result.closed
      ? result.method === 'message'
        ? 'asked the floating button to close'
        : `ended the process that owned the floating button (pid ${result.pid})`
      : result.found
        ? `a floating button is running (pid ${result.pid}) but could not be closed from here; end that node.exe in Task Manager`
        : 'no floating button is running'
    if (flags.json) process.stdout.write(`${JSON.stringify(result)}\n`)
    else process.stdout.write(`${message}\n`)
    return 0
  }
  // One button per desktop: a second copy would draw a second icon on top of the first. It is not an
  // error though — a button that stepped aside, or one that is running out of sight, is exactly when
  // the user double-clicks the shortcut again, so ask the running instance to show itself.
  let guardLogged = false
  if (findButtonWindow()) {
    const revived = reviveButtonWindow()
    // The launcher runs without a console, so this has to go into the log file as well.
    const log = createLogSink(target, { truncate: false })
    guardLogged = true
    if (revived) {
      log('a floating button is already running: asked it to show itself again')
      if (flags.json) process.stdout.write(`${JSON.stringify({ alreadyRunning: true, revived: true })}\n`)
      return 0
    }
    // A window that answers nothing belongs to another user or to a higher privilege level (Windows
    // refuses the post), so it is not this session's button and it may well be an invisible leftover.
    // Refusing to start would leave the user with nothing at all, which is the report this guards.
    log('another floating button is running but cannot be reached from here (another user or a higher privilege level); starting a second one')
  }
  const config = loadConfig(overrides)
  const engine = createEngine(config, resolveModels)
  // A fresh log per run, except when the guard above already wrote into it — truncating here would
  // erase the one line that explains why a second button is starting at all.
  const log = createLogSink(target, { truncate: !guardLogged })
  // What is running, as the first line of the log: telling a stale instance from a current one used to
  // take a support round trip.
  log(codeStamp())
  return new Promise((resolvePromise) => {
    let session = null
    let done = false
    // A pending promise does not keep Node alive; hold the process open explicitly. See the note in
    // commandDictate for the bug this prevents.
    const keepAlive = setInterval(() => {}, 1 << 30)
    const finish = async (code = 0) => {
      if (done) return
      done = true
      // Let a transcription that is already running finish: it holds the recognized text, and the
      // recorder is still closing the audio device on its behalf.
      await session?.whenIdle()
      clearInterval(keepAlive)
      session?.stop()
      resolvePromise(code)
    }
    try {
      session = runDictation(config, engine, {
        paste: flags.paste !== false,
        clipboard: flags.clipboard !== false,
        beeps: flags.beeps !== false,
        overlay: true,
        // The button is this command's interface, so a hotkey another application already owns (the DSH
        // speech-to-text plugin uses ctrl+alt+space) must not stop the button from appearing.
        hotkeysOptional: true,
        log,
        onQuit: () => {
          log('button closed')
          finish(0)
        },
        onResult: flags.json ? (result) => log(JSON.stringify(result)) : undefined,
      })
    } catch (error) {
      // Releasing the keep-alive matters here: a startup failure used to leave the process alive for
      // ever with nothing on screen and no console to explain it.
      clearInterval(keepAlive)
      throw error
    }
    if (!session.button) {
      // The button is the whole point of this command, so a missing one is a failure even though the
      // hotkeys came up.
      finish(1)
      return
    }
    process.on('SIGINT', () => {
      log('stopping ...')
      finish(0)
    })
    process.on('SIGTERM', () => finish(0))
  })
}

/**
 * Where `--log` should write.
 * `--log` on its own means `overlay.log` in the package folder; `--log <file>` means that file.
 * @param {Record<string, any>} flags - parsed flags.
 * @returns {string|null} absolute log path, or null to log to stdout only.
 */
function logTarget(flags) {
  if (!flags.log) return null
  return flags.log === true ? join(ROOT, 'overlay.log') : resolve(String(flags.log))
}

/**
 * Build the overlay's log sink.
 *
 * A button started by the hidden launcher (`start-overlay.vbs`) has no console to print to, so the log
 * file is the only way to see what it did. The file is truncated when the button starts, but only
 * then: a refused second launch appends, so the previous session's log survives.
 * @param {string|null} file - absolute path, or null for stdout only.
 * @param {{truncate?: boolean}} [options] - `truncate: false` keeps the existing contents.
 * @returns {(line: string) => void} sink that stamps and writes one line.
 */
function createLogSink(file, options = {}) {
  if (!file) return (line) => { process.stdout.write(`${line}\n`) }
  if (options.truncate !== false) writeFileSync(file, '')
  return (line) => {
    const stamped = `[${new Date().toISOString()}] ${line}`
    process.stdout.write(`${stamped}\n`)
    try {
      appendFileSync(file, `${stamped}\n`)
    } catch (error) {
      process.stdout.write(`! cannot write ${file}: ${error.message}\n`)
    }
  }
}

/**
 * `vtt serve`: HTTP API, optionally with the dictation bridge mounted.
 * @param {Record<string, any>} flags - parsed flags.
 * @param {object} overrides - configuration overrides from flags.
 * @returns {Promise<number>} exit code.
 */
async function commandServe(flags, overrides) {
  const config = loadConfig(overrides)
  const engine = createEngine(config, resolveModels)
  const log = (line) => process.stdout.write(`${line}\n`)
  let dictation = null
  if (flags.dictate) {
    dictation = new Dictation(config, engine, { log, paste: flags.paste !== false, clipboard: flags.clipboard !== false })
  }
  log('loading the speech model ...')
  engine.load()
  const started = await startApiServer(config, engine, { dictation, log })
  log(`listening on ${started.url}${config.token ? ' (bearer token required)' : ''}`)
  log('routes: GET /health, POST /transcribe, POST /v1/audio/transcriptions' + (dictation ? ', POST /dictate, POST /dictate/stop, POST /dictate/cancel' : ''))
  log('press Ctrl+C to stop')
  return new Promise((resolvePromise) => {
    const shutdown = async () => {
      log('stopping ...')
      dictation?.dispose()
      await started.close()
      resolvePromise(0)
    }
    process.on('SIGINT', () => { shutdown().then(() => process.exit(0)) })
    process.on('SIGTERM', () => { shutdown().then(() => process.exit(0)) })
  })
}

/**
 * `vtt models`: show, verify or download the weights.
 * @param {Record<string, any>} flags - parsed flags.
 * @param {object} overrides - configuration overrides from flags.
 * @param {boolean} fetchByDefault - true when invoked as `fetch-models`.
 * @returns {Promise<number>} exit code.
 */
async function commandModels(flags, overrides, fetchByDefault) {
  const config = loadConfig(overrides)
  const status = modelStatus(config)
  if (flags.fetch || fetchByDefault) {
    const results = await fetchModels(config, { log: (line) => process.stdout.write(`${line}\n`), force: Boolean(flags.force) })
    if (flags.json) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
    return 0
  }
  if (flags.verify) {
    const results = await verifyModels(config)
    for (const result of results) process.stdout.write(`  ${result.ok ? 'ok  ' : 'FAIL'}${result.key.padEnd(18)}${result.detail}\n`)
    return results.every((result) => result.ok) ? 0 : 4
  }
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ precision: config.precision, resolved: status.resolved, files: status.files.map(({ key, path, present }) => ({ key, path, present })) }, null, 2)}\n`)
    return status.resolved ? 0 : 4
  }
  process.stdout.write(`precision: ${config.precision}\n`)
  for (const file of status.files) {
    const size = file.present ? `${(statSync(file.path).size / 1048576).toFixed(0)} MB` : 'missing'
    process.stdout.write(`  ${file.present ? 'ok  ' : 'MISS'}${file.key.padEnd(18)}${size.padEnd(10)}${file.path}\n`)
  }
  process.stdout.write(status.resolved
    ? `\nreusing ${status.resolved.source}: ${status.resolved.modelDir}\n`
    : '\nno complete model set; run "vtt models --fetch" (about 241 MB)\n')
  return status.resolved ? 0 : 4
}

/**
 * `vtt doctor`: diagnose the machine.
 * @param {Record<string, any>} flags - parsed flags.
 * @param {object} overrides - configuration overrides from flags.
 * @returns {Promise<number>} exit code.
 */
async function commandDoctor(flags, overrides) {
  const config = loadConfig(overrides)
  const engine = createEngine(config, resolveModels)
  const report = await runDoctor(config, engine)
  if (flags.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else {
    process.stdout.write('voice-to-text doctor\n')
    process.stdout.write(`${formatChecks(report.checks)}\n`)
    process.stdout.write(`\n${report.ok ? 'ready' : 'problems found'}\n`)
  }
  return report.ok ? 0 : 5
}

/**
 * `vtt config`: show or create configuration.
 * @param {Record<string, any>} flags - parsed flags.
 * @param {object} overrides - configuration overrides from flags.
 * @returns {Promise<number>} exit code.
 */
async function commandConfig(flags, overrides) {
  const path = join(ROOT, 'config.json')
  if (flags.init) {
    if (existsSync(path) && !flags.force) throw new Error(`${path} already exists; pass --force to overwrite`)
    writeFileSync(path, `${JSON.stringify(DEFAULTS, null, 2)}\n`)
    process.stdout.write(`wrote ${path}\n`)
  }
  const config = loadConfig(overrides)
  if (flags.json) process.stdout.write(`${JSON.stringify({ path, file: readConfigFile(), effective: config }, null, 2)}\n`)
  else {
    process.stdout.write(`config file: ${existsSync(path) ? path : `${path} (not created; "vtt config --init" writes one)`}\n\n`)
    for (const [key, value] of Object.entries(config)) {
      const fromFile = Object.hasOwn(readConfigFile(), key)
      process.stdout.write(`  ${key.padEnd(22)}${JSON.stringify(value).padEnd(28)}${fromFile ? 'config.json' : 'default'}\n`)
    }
  }
  return 0
}

/**
 * Convert flags into configuration overrides.
 * @param {Record<string, any>} flags - parsed flags.
 * @returns {object} configuration overrides.
 */
function flagsToConfig(flags) {
  const overrides = {}
  for (const [flag, key] of Object.entries(CONFIG_FLAGS)) {
    if (flags[flag] !== undefined) overrides[key] = flags[flag]
  }
  return overrides
}

/**
 * Copy and/or paste recognized text according to flags.
 * @param {string} text - recognized text.
 * @param {Record<string, any>} flags - parsed flags.
 * @returns {{clipboard: boolean, pasted: boolean}} what was done.
 */
function deliver(text, flags) {
  if (!text) return { clipboard: false, pasted: false }
  if (!flags.copy && !flags.paste) return { clipboard: false, pasted: false }
  const copied = copyText(text)
  const pasted = copied && flags.paste ? sendPaste() : false
  return { clipboard: copied, pasted }
}

/**
 * Default filename for `vtt record`.
 * @returns {string} path in the current directory.
 */
function defaultRecordingName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `recording-${stamp}.wav`
}

/**
 * Remove a file, ignoring failures.
 * @param {string} path - file to delete.
 * @returns {void}
 */
function rmSyncSafe(path) {
  try {
    rmSync(path, { force: true })
  } catch {
    // A leftover temporary file is not worth failing a successful transcription over.
  }
}

/**
 * Wait for a number of milliseconds.
 * @param {number} ms - milliseconds to wait.
 * @returns {Promise<void>} resolves after the delay.
 */
function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/** Print the usage text. */
function printHelp() {
  process.stdout.write(`voice-to-text ${VERSION} — local speech to text (SenseVoice + Silero VAD, CPU)

usage
  vtt <command> [options]

commands
  overlay [--stop]              show the floating microphone button next to the text caret and dictate
                                with the mouse; a notification-area icon toggles it too
                                (--stop asks the running button to close and, if Windows blocks the
                                message, ends the node.exe that owns it; --no-force only asks)
  dictate [--overlay]           run in the background: press ${DEFAULTS.hotkey} to record, again to transcribe
                                and paste the text into whatever application has focus
                                (--overlay also shows the floating microphone button)
  listen [--seconds 5]          record once from the microphone and print the text
  record [--seconds 5] [--out f.wav]
                                record the microphone into a canonical 16 kHz mono WAV file
  transcribe <file.wav>         transcribe an existing WAV file
  serve [--port 8791] [--dictate]
                                local HTTP API (POST /transcribe, OpenAI-compatible
                                POST /v1/audio/transcriptions, optional hotkey-free dictation bridge)
  models [--fetch] [--verify]   show, verify or download the speech models
  doctor                        check models, microphone, clipboard and hotkeys
  config [--init]               show the effective configuration

common options
  --language auto|zh|en|yue|ja|ko   recognition language hint (default ${DEFAULTS.language})
  --precision int8|fp32             model weights (default ${DEFAULTS.precision})
  --threads N                       ONNX Runtime threads (default ${DEFAULTS.threads})
  --hotkey / --cancel-hotkey        global hotkeys for dictation (default ${DEFAULTS.hotkey} / ${DEFAULTS.cancelHotkey})
  --copy / --paste                  send the text to the clipboard / paste into the focused window
  --json                            machine-readable output
  --no-beeps                        silence the start/stop/result cues
  --beep-volume 0..1                how loud those cues are (default ${DEFAULTS.beepVolume})
  --speech-margin-db N              how far a 20 ms frame must rise above the recording's own noise floor
  --min-speech-frames N             and how many frames in a row must do it (defaults ${DEFAULTS.speechMarginDb} dB,
                                    ${DEFAULTS.minSpeechFrames} frames; 0 dB decodes everything)
  --keep-recordings                 keep each recording in recordings\\ (troubleshooting; also
                                    VTT_KEEP_RECORDINGS=1 for the shortcut launchers)

The models are reused from an existing DSH speech-to-text cache when present; otherwise run
"vtt models --fetch" (~241 MB, verified against pinned SHA-256 hashes).
`)
}
