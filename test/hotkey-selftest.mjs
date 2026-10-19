/**
 * Self-test for the dictation path that needs no human at the microphone.
 *
 * It runs the real hotkey loop and triggers it two ways:
 *
 *   - synthesized key presses (keybd_event), when this session accepts them;
 *   - otherwise a WM_HOTKEY posted straight to the thread, which is exactly what Windows posts on a
 *     real key press, so every line of our own code is still exercised.
 *
 * Recognition itself is empty (nothing is speaking), so the assertions are about state transitions,
 * timing and delivery, not about words.
 *
 * Usage: node test/hotkey-selftest.mjs
 */
import koffi from 'koffi'
import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DictationState } from '../src/dictation.mjs'
import { runDictation } from '../src/dictate.mjs'
import { createEngine } from '../src/engine.mjs'
import { loadConfig, resolveModels } from '../src/config.mjs'
import { copyText } from '../src/win32.mjs'

const HOTKEY = 'ctrl+alt+f12'
const CANCEL = 'ctrl+alt+f11'
const WM_HOTKEY = 0x0312
const KEYUP = 0x0002
const MOD_KEYS = { ctrl: 0x11, alt: 0x12, shift: 0x10, win: 0x5b }
const VK = { f11: 0x7a, f12: 0x7b, escape: 0x1b }

const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')
const keybd_event = user32.func('void keybd_event(unsigned char key, unsigned char scan, unsigned int flags, size_t extra)')
const PostThreadMessageW = user32.func('int PostThreadMessageW(unsigned int threadId, unsigned int message, size_t wParam, intptr_t lParam)')
const GetCurrentThreadId = kernel32.func('unsigned int GetCurrentThreadId()')

/**
 * Press and release a hotkey combination through the real input stack.
 * @param {string} hotkey - text such as `ctrl+alt+f12`.
 * @returns {void}
 */
function pressHotkey(hotkey) {
  const keys = hotkey.split('+').map((part) => MOD_KEYS[part] ?? VK[part]).filter(Boolean)
  for (const key of keys) keybd_event(key, 0, 0, 0)
  for (const key of [...keys].reverse()) keybd_event(key, 0, KEYUP, 0)
}

/**
 * Check whether a synthesized key press reaches the global hotkey system.
 *
 * There is no reliable way to ask Windows: GetLastInputInfo also ticks for the user's own input, and
 * a fullscreen game with kernel anti-cheat swallows injected keys without reporting an error. So the
 * only honest test is to press the key and see whether the handler ran.
 * @param {object} dictation - live dictation session.
 * @returns {boolean} true when the synthesized press started a recording.
 */
function synthesizedPressWorks(dictation) {
  pressHotkey(HOTKEY)
  const started = Date.now()
  while (Date.now() - started < 900) { /* spin so the message pump gets a turn */ }
  return dictation.recording
}

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

/**
 * Wait for a number of milliseconds.
 * @param {number} ms - delay.
 * @returns {Promise<void>} resolves after the delay.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const config = loadConfig({ hotkey: HOTKEY, cancelHotkey: CANCEL, beeps: false, minSeconds: 0.3, maxSeconds: 20, pasteDelayMs: 10 })
const engine = createEngine(config, resolveModels)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(ROOT, 'bin', 'vtt.mjs')
const CHILD_LOG = join(ROOT, 'test-output', 'dictate-resident.log')

/**
 * Launch the real `vtt dictate` command, so this file covers the entry point a user actually runs and
 * not only the library API. Output goes to a file: this sandbox refuses piped stdio.
 * @returns {import('node:child_process').ChildProcess} the child, or one that reports an error.
 */
function spawnDictate() {
  const args = [ENTRY, 'dictate', '--no-beeps', '--hotkey', 'ctrl+alt+f10', '--cancel-hotkey', 'ctrl+alt+f9']
  try {
    const fd = openSync(CHILD_LOG, 'w')
    const child = spawn(process.execPath, args, { stdio: ['ignore', fd, fd], windowsHide: true })
    closeSync(fd)
    return child
  } catch (error) {
    const child = spawn(process.execPath, args, { stdio: 'ignore', windowsHide: true })
    child.once('spawn', () => process.stdout.write(`  (child output unavailable: ${error.message})\n`))
    return child
  }
}

process.stdout.write('hotkey self-test\n')

let seen = null
const session = runDictation(config, engine, {
  paste: false,
  clipboard: true,
  beeps: false,
  log: (line) => process.stdout.write(`    | ${line}\n`),
  onResult: (result) => { seen = result },
})

const ids = [...session.hotkeys.handlers.keys()]
const startId = ids[0]
const cancelId = ids[1]

/** How this run triggers the hotkeys; decided by the calibration press below. */
let mode = synthesizedPressWorks(session.dictation) ? 'synthesized' : 'posted'
process.stdout.write(`  (trigger mode: ${mode === 'synthesized' ? 'synthesized key presses' : 'posted WM_HOTKEY — this session drops synthesized input'})\n`)

/**
 * Fire one hotkey.
 * @param {string} hotkey - hotkey text.
 * @param {number} id - registered hotkey id, used for the posted-message path.
 * @returns {Promise<void>} resolves once the handler had a chance to run.
 */
async function fire(hotkey, id) {
  if (mode === 'synthesized') pressHotkey(hotkey)
  else PostThreadMessageW(GetCurrentThreadId(), WM_HOTKEY, id, 0)
  await sleep(400)
}

await sleep(200)
check('two hotkeys are registered', ids.length === 2, `ids ${ids.join(', ')}`)

if (mode === 'posted') {
  // The calibration press never arrived, so nothing was started: press again properly, then assert.
  await fire(HOTKEY, startId)
}
check('a hotkey press starts recording', session.dictation.recording, session.dictation.state)

// --- cancel ------------------------------------------------------------------
await sleep(900)
await fire(CANCEL, cancelId)
check('the cancel hotkey discards the recording', session.dictation.state === DictationState.Idle, session.dictation.state)

// --- a complete session ------------------------------------------------------
copyText('sentinel-before-dictation')
await fire(HOTKEY, startId)
check('a later press starts recording again', session.dictation.recording, session.dictation.state)
await sleep(1400)
const before = Date.now()
await fire(HOTKEY, startId)
for (let i = 0; i < 100 && !seen; i += 1) await sleep(100)
check('the second press finishes the session', Boolean(seen), seen ? `after ${Date.now() - before}ms` : 'no result within 10s')
if (seen) {
  check('audio was captured', seen.audioSeconds > 0.5, `${seen.audioSeconds.toFixed(2)}s`)
  check('session is idle again', session.dictation.state === DictationState.Idle, session.dictation.state)
  check('delivery ran and reported its state', seen.pasted === false && (seen.clipboard === true || seen.text === ''), `text=${JSON.stringify(seen.text)} clipboard=${seen.clipboard}`)
}

// --- the loop must stay usable ------------------------------------------------
seen = null
await fire(HOTKEY, startId)
check('the loop still works after a completed session', session.dictation.recording, session.dictation.state)
session.dictation.discard()

// --- the real command must stay resident --------------------------------------
// Regression guard for a bug that only the entry point could show: `dictate` awaits a promise that
// resolves on Ctrl+C, and a pending promise does not keep Node alive. The banner printed and the
// process exited immediately, so the first real double-click launcher failure came from here.
session.stop()
let childError = null
const child = spawnDictate()
child.on('error', (error) => { childError = error })
await sleep(4500)
if (childError) {
  process.stdout.write(`  --  skipping the resident check: could not launch the command (${childError.code ?? childError.message})\n`)
} else {
  const alive = child.exitCode === null && child.signalCode === null
  check('the dictate command stays resident', alive, alive ? 'still running after 4.5s' : `exited early with code ${child.exitCode}`)
  try {
    const banner = readFileSync(CHILD_LOG, 'utf8')
    check('it announced the model and its hotkeys', banner.includes('model ready') && banner.includes('ctrl+alt+f10'),
      JSON.stringify(banner.split('\n').filter(Boolean).slice(0, 3).join(' | ')))
  } catch (error) {
    process.stdout.write(`  --  banner not readable: ${error.message}\n`)
  }
  child.kill()
  await sleep(400)
}

// Prove that stopping released every live handle: with the dictation session stopped, this process
// must exit on its own. process.exit() would hide a leaked timer, so instead an unref'd watchdog —
// harmless when the event loop drains, fatal when it does not — reports the leak.
const watchdog = setTimeout(() => {
  process.stdout.write('\nFAIL the process is still alive after stopping: a live handle was left behind\n')
  process.exit(1)
}, 5000)
watchdog.unref()
process.stdout.write(failures.length ? `\n${failures.length} check(s) failed\n` : '\nall checks passed\n')
process.exitCode = failures.length ? 1 : 0
