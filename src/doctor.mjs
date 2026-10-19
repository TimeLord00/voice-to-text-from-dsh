/**
 * `vtt doctor`: one command that answers "why does not it work".
 *
 * Every check is independent and reports what it observed, so the output doubles as the bug report
 * a user can paste when something on their machine behaves differently.
 */
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { Microphone, beep, copyText, readClipboardText, shortPath, tempRecordingPath } from './win32.mjs'
import { Hotkeys } from './win32.mjs'
import { encodeCanonical } from './wav.mjs'
import { LANGUAGES, ROOT, modelPlan, resolveModels } from './config.mjs'
import { modelStatus } from './models.mjs'

/**
 * Run every diagnostic.
 * @param {object} config - effective configuration.
 * @param {import('./engine.mjs').SpeechEngine} engine - engine instance (loaded by this check).
 * @returns {Promise<{checks: Array<{name: string, ok: boolean, warn?: boolean, detail: string}>, ok: boolean}>} findings.
 */
export async function runDoctor(config, engine) {
  const checks = []
  const add = (name, ok, detail, warn = false) => checks.push({ name, ok, detail, warn: warn || undefined })

  add('platform', process.platform === 'win32', `${process.platform} ${process.arch}, node ${process.version}`)
  add('package', existsSync(ROOT), ROOT)

  const status = modelStatus(config)
  const resolved = status.resolved
  for (const file of status.files) {
    add(`model: ${file.key}`, file.present, file.present ? `${(statSync(file.path).size / 1048576).toFixed(0)} MB at ${file.path}` : `missing at ${file.path}`)
  }
  add('model resolution', Boolean(resolved), resolved ? `${resolved.source}: ${resolved.modelDir}` : 'no complete model set found; run "vtt models --fetch"')
  add('language', LANGUAGES.includes(config.language), `${config.language} (supported: ${LANGUAGES.join(', ')})`)

  if (resolved) {
    const started = Date.now()
    try {
      engine.load()
      add('recognizer', true, `loaded in ${((Date.now() - started) / 1000).toFixed(1)}s, ${config.threads} threads, ${config.precision}`)
      const silence = encodeCanonical(new Float32Array(16000))
      const whisper = engine.transcribe(silence)
      add('recognizer self-test', true, `1.0s of silence -> ${JSON.stringify(whisper.text)} in ${(whisper.inferenceSeconds * 1000).toFixed(0)}ms`)
    } catch (error) {
      add('recognizer', false, error.message)
    }
  }

  checks.push(...microphoneCheck())
  checks.push(...clipboardCheck())
  checks.push(...hotkeyCheck(config))

  const plan = modelPlan(config)
  add('model directory', true, plan.modelRoot, false)
  return { checks, ok: checks.every((check) => check.ok || check.warn) }
}

/**
 * Open the capture device, record one second and measure the signal.
 * A recording that succeeds but is digitally silent means the microphone is muted or Windows denied
 * access, which is otherwise indistinguishable from "nothing was said".
 * @returns {Array<{name: string, ok: boolean, warn?: boolean, detail: string}>} findings.
 */
function microphoneCheck() {
  const path = tempRecordingPath()
  const microphone = new Microphone('vttdoctor')
  try {
    microphone.start()
    const until = Date.now() + 1200
    while (Date.now() < until) {
      // Blocking on purpose: the MCI mapper records on its own thread, the wait only paces the test.
    }
    const saved = microphone.save(path)
    if (!existsSync(path)) return [{ name: 'microphone', ok: false, detail: 'the capture device saved no file' }]
    const bytes = readFileSync(path)
    const stats = measurePcm(bytes, saved.format)
    const seconds = ((bytes.length - 44) / (saved.format.sampleRate * saved.format.channels * (saved.format.bitsPerSample / 8)))
    const results = [
      { name: 'microphone', ok: true, detail: `${saved.format.sampleRate} Hz, ${saved.format.channels}ch, ${saved.format.bitsPerSample}-bit, recorded ${seconds.toFixed(2)}s in ${saved.seconds.toFixed(2)}s` },
    ]
    if (stats.peak === 0) results.push({ name: 'microphone signal', ok: false, warn: true, detail: 'captured pure silence: the microphone may be muted, unplugged, or blocked in Windows privacy settings' })
    else if (stats.peak < 32) results.push({ name: 'microphone signal', ok: true, warn: true, detail: `very low level (peak ${stats.peak}/32768); check the input volume if recognition misses words` })
    else results.push({ name: 'microphone signal', ok: true, detail: `peak ${stats.peak}/32768, average ${stats.average.toFixed(0)}` })
    return results
  } catch (error) {
    return [{ name: 'microphone', ok: false, detail: error.message }]
  } finally {
    microphone.close()
    rmSync(path, { force: true })
  }
}

/**
 * Measure peak and average amplitude of 16-bit PCM data.
 * @param {Buffer} bytes - WAV bytes.
 * @param {{bitsPerSample: number, channels: number}} format - format of the data.
 * @returns {{peak: number, average: number, samples: number}} statistics.
 */
function measurePcm(bytes, format) {
  if (format.bitsPerSample !== 16) return { peak: -1, average: -1, samples: 0 }
  const total = Math.floor((bytes.length - 44) / 2)
  let peak = 0
  let sum = 0
  for (let i = 0; i < total; i += 1) {
    const value = Math.abs(bytes.readInt16LE(44 + i * 2))
    if (value > peak) peak = value
    sum += value
  }
  return { peak, average: total ? sum / total : 0, samples: total }
}

/**
 * Round-trip a sentinel string through the clipboard.
 * @returns {Array<{name: string, ok: boolean, detail: string}>} findings.
 */
function clipboardCheck() {
  const sentinel = `vtt-doctor-${Date.now()}`
  const previous = readClipboardText()
  try {
    if (!copyText(sentinel)) return [{ name: 'clipboard', ok: false, detail: 'the clipboard refused the text' }]
    const readBack = readClipboardText()
    const ok = readBack === sentinel
    if (previous !== null) copyText(previous)
    return [{ name: 'clipboard', ok, detail: ok ? `wrote and read back ${sentinel.length} characters${previous === null ? '' : ' (previous contents restored)'}` : `read back ${JSON.stringify(readBack?.slice(0, 40))}` }]
  } catch (error) {
    return [{ name: 'clipboard', ok: false, detail: error.message }]
  }
}

/**
 * Try to claim the configured hotkeys, then release them again.
 * @param {object} config - effective configuration.
 * @returns {Array<{name: string, ok: boolean, detail: string}>} findings.
 */
function hotkeyCheck(config) {
  const hotkeys = new Hotkeys()
  const results = []
  for (const [label, value] of [['hotkey', config.hotkey], ['cancel hotkey', config.cancelHotkey]]) {
    if (!value) continue
    try {
      const { canonical } = hotkeys.register(value, () => {})
      results.push({ name: label, ok: true, detail: `${canonical} is free and can be registered` })
    } catch (error) {
      results.push({ name: label, ok: false, detail: error.message })
    }
  }
  hotkeys.dispose()
  return results
}

/**
 * Render doctor findings for humans.
 * @param {Array<{name: string, ok: boolean, warn?: boolean, detail: string}>} checks - findings.
 * @returns {string} printable report.
 */
export function formatChecks(checks) {
  const width = Math.max(...checks.map((check) => check.name.length))
  return checks.map((check) => {
    const mark = check.ok ? (check.warn ? '!' : 'ok') : 'FAIL'
    return `  ${mark.padEnd(5)}${check.name.padEnd(width + 2)}${check.detail}`
  }).join('\n')
}

/** Exported for tests: the short-path helper used when MCI rejects long paths. */
export { shortPath }
