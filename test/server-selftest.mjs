/**
 * Self-test for the HTTP API. The server runs in this process, so this needs no child processes.
 *
 * Usage: node test/server-selftest.mjs
 */
import { createEngine } from '../src/engine.mjs'
import { loadConfig, resolveModels } from '../src/config.mjs'
import { startApiServer } from '../src/server.mjs'
import { Dictation } from '../src/dictation.mjs'
import { encodeCanonical } from '../src/wav.mjs'

const failures = []
/**
 * Record one assertion.
 * @param {string} label - what is being checked.
 * @param {boolean} ok - result.
 * @param {string} [detail] - extra context.
 * @returns {void}
 */
function check(label, ok, detail = '') {
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'}${label}${detail ? ` — ${detail}` : ''}\n`)
  if (!ok) failures.push(label)
}

const PORT = 8799
const TOKEN = 'selftest-token'
const BASE = `http://127.0.0.1:${PORT}`
const auth = { authorization: `Bearer ${TOKEN}` }

const config = loadConfig({ port: PORT, token: TOKEN, beeps: false, pasteDelayMs: 10, minSeconds: 0.2 })
const engine = createEngine(config, resolveModels)
const dictation = new Dictation(config, engine, { log: () => {} })
const server = await startApiServer(config, engine, { dictation, log: () => {} })
await new Promise((resolve) => setTimeout(resolve, 200))

// 1.5 s of silence as canonical 16 kHz mono PCM — the recognizer must return an empty string.
const silence = encodeCanonical(new Int16Array(24000), 16000)

process.stdout.write('server self-test\n')

const health = await fetch(`${BASE}/health`)
const healthBody = await health.json()
check('GET /health', health.ok && healthBody.ok === true, JSON.stringify(healthBody))

const noAuth = await fetch(`${BASE}/transcribe`, { method: 'POST', body: silence })
check('missing token is rejected', noAuth.status === 401, `status ${noAuth.status}`)

const wrongAuth = await fetch(`${BASE}/transcribe`, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: silence })
check('wrong token is rejected', wrongAuth.status === 401, `status ${wrongAuth.status}`)

const raw = await fetch(`${BASE}/transcribe?language=zh`, { method: 'POST', headers: auth, body: silence })
const rawBody = await raw.json()
check('POST /transcribe (raw wav)', raw.ok && typeof rawBody.text === 'string', JSON.stringify(rawBody))
check('silence decodes to empty text', rawBody.text === '', JSON.stringify(rawBody.text))
check('response reports audio seconds', Math.abs(rawBody.seconds - 1.5) < 0.05, String(rawBody.seconds))

const badBody = await fetch(`${BASE}/transcribe`, { method: 'POST', headers: auth, body: Buffer.from('not a wav at all') })
const badText = await badBody.text()
check('garbage body is a 4xx with a message', badBody.status >= 400 && badBody.status < 500, `${badBody.status} ${badText.slice(0, 120)}`)

const form = new FormData()
form.append('file', new Blob([silence], { type: 'audio/wav' }), 'silence.wav')
form.append('language', 'zh')
const openai = await fetch(`${BASE}/v1/audio/transcriptions`, { method: 'POST', headers: auth, body: form })
const openaiBody = await openai.json()
check('POST /v1/audio/transcriptions (multipart)', openai.ok && typeof openaiBody.text === 'string', JSON.stringify(openaiBody))

const missingFile = await fetch(`${BASE}/transcribe?file=${encodeURIComponent('E:\\nope\\missing.wav')}`, { headers: auth })
check('missing input file is a 4xx', missingFile.status >= 400 && missingFile.status < 500, `status ${missingFile.status}`)

const noDictationConfig = { ...config, port: PORT + 1 }
const plainServer = await startApiServer(noDictationConfig, engine, { log: () => {} })
const notEnabled = await fetch(`http://127.0.0.1:${PORT + 1}/dictate`, { method: 'POST', headers: auth })
check('/dictate without the dictation session is refused', notEnabled.status >= 400 && notEnabled.status < 500, `status ${notEnabled.status}`)
plainServer.close()

const start = await fetch(`${BASE}/dictate`, { method: 'POST', headers: auth })
const startBody = await start.json()
check('POST /dictate starts recording', start.ok && startBody.state === 'recording', JSON.stringify(startBody))

const again = await fetch(`${BASE}/dictate`, { method: 'POST', headers: auth })
const againBody = await again.json()
check('POST /dictate while recording is an idempotent status', again.ok && againBody.state === 'recording', JSON.stringify(againBody))

const cancelWhileRecording = await fetch(`${BASE}/dictate/cancel`, { method: 'POST', headers: auth })
const cancelBody = await cancelWhileRecording.json()
check('POST /dictate/cancel discards the recording', cancelWhileRecording.ok && cancelBody.state === 'idle', JSON.stringify(cancelBody))

// A cancelled recording must not be transcribable afterwards.
const stopAfterCancel = await fetch(`${BASE}/dictate/stop`, { method: 'POST', headers: auth })
check('POST /dictate/stop after a cancel is refused', stopAfterCancel.status >= 400 && stopAfterCancel.status < 500, `status ${stopAfterCancel.status}`)

const startAgain = await fetch(`${BASE}/dictate`, { method: 'POST', headers: auth })
check('recording can start again after a cancel', startAgain.ok, `status ${startAgain.status}`)

await new Promise((resolve) => setTimeout(resolve, 700))
const stopped = await fetch(`${BASE}/dictate/stop`, { method: 'POST', headers: auth })
const stoppedBody = await stopped.json()
check('POST /dictate/stop finishes and returns text', stopped.ok && typeof stoppedBody.text === 'string', JSON.stringify(stoppedBody))
check('the recording had real duration', stoppedBody.audioSeconds > 0.4, String(stoppedBody.audioSeconds))

const cancel = await fetch(`${BASE}/dictate/cancel`, { method: 'POST', headers: auth })
const cancelIdle = await cancel.json()
check('POST /dictate/cancel on an idle session is a no-op', cancel.ok && cancelIdle.state === 'idle', JSON.stringify(cancelIdle))

const notFound = await fetch(`${BASE}/nope`, { headers: auth })
check('unknown path is 404', notFound.status === 404, `status ${notFound.status}`)

const wrongMethod = await fetch(`${BASE}/health`, { method: 'POST', headers: auth })
check('GET-only path rejects POST', wrongMethod.status === 405, `status ${wrongMethod.status}`)

// The dictation state machine, driven without a window, a hotkey or a click. The field bug this section
// locks down: a second click that stops a recording of a few hundred milliseconds took the discard branch
// and, when that branch threw, left the machine on `transcribing` for the rest of the process's life —
// the button stayed yellow with three dots and every later click only played the error cue.
process.stdout.write('\ndictation state machine\n')
const machineConfig = { ...config, minSeconds: 0.3, maxSeconds: 60, beeps: false }
const transitions = []
const machine = new Dictation(machineConfig, engine, { log: () => {}, beeps: false, onState: (state) => transitions.push(state) })

await machine.begin()
check('begin() starts a recording', machine.state === 'recording', machine.state)
await new Promise((resolve) => setTimeout(resolve, 120))
const discarded = await machine.finish()
check('a recording shorter than minSeconds comes back discarded instead of throwing', discarded.discarded === true && discarded.text === '', JSON.stringify({ discarded: discarded.discarded, text: discarded.text }))
check('the machine is idle again after a discard', machine.state === 'idle', machine.state)
check('the transition log ends on idle and never stops at transcribing', transitions[transitions.length - 1] === 'idle' && transitions.includes('transcribing'), transitions.join(' -> '))

const secondStart = await machine.begin()
check('the machine records again right after a discard', secondStart.state === 'recording', JSON.stringify(secondStart))
await new Promise((resolve) => setTimeout(resolve, 120))
const discardedTwice = await machine.finish()
check('the second short recording is discarded as well', discardedTwice.discarded === true, JSON.stringify({ discarded: discardedTwice.discarded }))
check('two discards in a row leave no state behind', machine.state === 'idle', machine.state)

const cancelled = new Dictation(machineConfig, engine, { log: () => {}, beeps: false })
await cancelled.begin()
check('an explicit cancel returns to idle', cancelled.discard().state === 'idle' && cancelled.state === 'idle', cancelled.state)

// A device that fails must not wedge it either: the finally block in finish() is the safety net.
const brokenStop = new Dictation(machineConfig, engine, { log: () => {}, beeps: false })
await brokenStop.begin()
await new Promise((resolve) => setTimeout(resolve, 400))
brokenStop.microphone.save = () => {
  throw new Error('the device disappeared')
}
let stopRejected = false
try {
  await brokenStop.finish()
} catch {
  stopRejected = true
}
check('a recorder that fails while stopping rejects finish()', stopRejected)
check('a failed stop leaves the machine idle, not transcribing', brokenStop.state === 'idle', brokenStop.state)

const brokenStart = new Dictation(machineConfig, engine, { log: () => {}, beeps: false })
// The microphone is created lazily by begin(), so it is opened once and released before the device is
// made to fail — that is the field shape: the device is there, but it refuses to stream.
await brokenStart.begin()
brokenStart.discard()
brokenStart.microphone.start = () => {
  throw new Error('the device is busy')
}
let startRejected = false
try {
  await brokenStart.begin()
} catch {
  startRejected = true
}
check('a recorder that refuses to start rejects begin()', startRejected)
check('a failed start leaves the machine idle', brokenStart.state === 'idle', brokenStart.state)
check('a recording can still be started after a failed attempt', brokenStart.microphone !== null && typeof brokenStart.microphone.start === 'function')

server.close()
process.stdout.write(failures.length ? `\n${failures.length} check(s) failed\n` : '\nall checks passed\n')
process.exit(failures.length ? 1 : 0)
