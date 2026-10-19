/**
 * Where exactly does the access violation come from, and does deferring remove it?
 *
 * `vtt overlay` drives dictation from its window procedure, so the first inference ran inside a koffi
 * callback frame after the MCI recorder had just been torn down; the process died with 0xC0000005.
 * These modes reproduce that combination and test the proposed fix — never do the heavy work on the
 * callback's stack, hop back to a plain event-loop tick first with setImmediate.
 *
 * node probe\callback-engine.mjs <mode> [repeats]
 *   mode: no-mic-callback | mic-callback | mic-deferred | timer-callback
 */
import { readFileSync, rmSync } from 'node:fs'
import { createEngine } from '../src/engine.mjs'
import { loadConfig, resolveModels } from '../src/config.mjs'
import { Hotkeys, Microphone, tempRecordingPath } from '../src/win32.mjs'
import { LayeredWindow, dispatchMessage, postMessage } from '../src/win32-gui.mjs'
import { encodeCanonical, toCanonicalWav } from '../src/wav.mjs'

const WM_MOUSEMOVE = 0x0200
const mode = process.argv[2] ?? 'mic-callback'
const repeats = Number(process.argv[3] ?? 1)
const config = loadConfig({})

/**
 * One run: optionally record 0.8s with MCI, then transcribe from inside (or deferred out of) a window
 * procedure.
 * @returns {Promise<void>} resolves after the pump settles.
 */
async function run() {
  const engine = createEngine(config, resolveModels)
  engine.load()
  let canonical = encodeCanonical(new Int16Array(16000), 16000)

  if (mode.startsWith('mic')) {
    const microphone = new Microphone()
    microphone.start()
    const until = Date.now() + 800
    while (Date.now() < until);
    const path = tempRecordingPath()
    const saved = microphone.save(path)
    const raw = readFileSync(path)
    canonical = toCanonicalWav(raw, saved.format)
    rmSync(path, { force: true })
    microphone.close()
  }

  const transcribe = (where) => {
    const result = engine.transcribe(canonical, config.language)
    process.stdout.write(`${where} ok (${result.inferenceSeconds}s)\n`)
  }

  if (mode === 'timer-callback') transcribe('timer')

  const window = new LayeredWindow({
    title: 'callback probe',
    onMessage: (event) => {
      if (event !== 'move') return
      if (mode.endsWith('deferred')) {
        // The proposed fix: leave the callback's stack before touching MCI or ONNX Runtime.
        setImmediate(() => transcribe('deferred'))
        return
      }
      transcribe('in-callback')
    },
  })
  window.create(8, 8)
  const pump = new Hotkeys()
  pump.dispatch = (message) => dispatchMessage(message)
  pump.start()
  postMessage(window.handle, WM_MOUSEMOVE, 0, 0)
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 900))
  window.dispose()
  pump.dispose()
}

for (let index = 1; index <= repeats; index += 1) {
  process.stdout.write(`run ${index}/${repeats} (${mode}) ... `)
  await run()
  process.stdout.write('survived\n')
}
