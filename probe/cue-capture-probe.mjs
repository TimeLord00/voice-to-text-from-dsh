/**
 * Why a cue before a recording can stall the recorder.
 *
 * Symptom being chased: `vtt listen --seconds 2` (beeps on) printed its "recording" line and then never
 * finished; the same command with `--no-beeps` completed in seconds. This probe replays the sequence with
 * one playback technique per mode, times every native step, and prints where each mode stops.
 *
 *   none          record only (baseline)
 *   cue-before    PlaySound(SND_MEMORY | SND_ASYNC) before the recorder starts — what the tool does now
 *   cue-after     the recorder starts first, the cue follows
 *   cue-file      PlaySound(SND_FILENAME | SND_ASYNC) from a temporary wav
 *   cue-sync      PlaySound from a file without SND_ASYNC (returns when the sound is over)
 *   message-beep  MessageBeep instead of PlaySound
 *   mci-cue       the cue played through MCI, the same API the recorder uses
 *   cue-sync-mem  PlaySound(SND_MEMORY) without SND_ASYNC before the recorder starts (proposed fix)
 *   cue-sync-open the same blocking playback while the recorder is already running
 *
 * A 30 s watchdog prints the step that never returned and exits 9, so a stall cannot hang the caller.
 *
 * Usage: node probe\cue-capture-probe.mjs [mode|all]
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import koffi from 'koffi'
import { Microphone, mci, playCue } from '../src/win32.mjs'
import { renderCue } from '../src/sound.mjs'

const MODES = ['none', 'cue-before', 'cue-after', 'cue-file', 'cue-sync', 'message-beep', 'mci-cue', 'cue-sync-mem', 'cue-sync-open']
const SND_ASYNC = 0x0001
const SND_NODEFAULT = 0x0002
const SND_MEMORY = 0x0004
const SND_FILENAME = 0x00020000

const winmm = koffi.load('winmm.dll')
const user32 = koffi.load('user32.dll')
const PlaySoundW = winmm.func('int PlaySoundW(void *sound, void *module, unsigned int flags)')
const MessageBeep = user32.func('int MessageBeep(unsigned int type)')

const mode = process.argv[2] ?? 'all'
let step = 'start'
let watchdog = null

function log(message) {
  process.stdout.write(`${message}\n`)
}

function timed(label, fn) {
  step = label
  const started = Date.now()
  const value = fn()
  const suffix = value === undefined ? '' : `  -> ${value}`
  log(`    ${label.padEnd(20)} ${String(Date.now() - started).padStart(6)} ms${suffix}`)
  return value
}

async function sleep(ms) {
  step = `sleep ${ms}`
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function run(which) {
  log(`\n=== ${which} ===`)
  const dir = mkdtempSync(join(tmpdir(), 'vtt-cue-'))
  const cueFile = join(dir, 'cue.wav')
  writeFileSync(cueFile, renderCue('start', { volume: 0.7 }))
  // A stable image for SND_MEMORY: the pointer has to stay valid for the call.
  const cueMemory = renderCue('start', { volume: 0.7 })
  // A stable UTF-16 buffer for SND_FILENAME: the pointer has to stay valid for the call.
  const cuePath = Buffer.from(`${cueFile}\0`, 'utf16le')
  const output = join(dir, 'recorded.wav')
  const microphone = new Microphone()
  let outcome = 'ok'
  try {
    if (which === 'cue-before') timed('play cue (memory)', () => playCue('start', 0.7))
    if (which === 'cue-file') timed('play cue (file)', () => PlaySoundW(koffi.address(cuePath), null, SND_FILENAME | SND_ASYNC | SND_NODEFAULT))
    if (which === 'cue-sync') timed('play cue (sync)', () => PlaySoundW(koffi.address(cuePath), null, SND_FILENAME | SND_NODEFAULT))
    if (which === 'message-beep') timed('MessageBeep', () => MessageBeep(0x40))
    if (which === 'cue-sync-mem') timed('play cue (sync mem)', () => PlaySoundW(koffi.address(cueMemory), null, SND_MEMORY | SND_NODEFAULT))
    if (which === 'mci-cue') {
      timed('mci open', () => mci(`open "${cueFile}" type waveaudio alias vttcueprobe`).rc)
      timed('mci play', () => mci('play vttcueprobe').rc)
      await sleep(250)
      timed('mci close', () => mci('close vttcueprobe').rc)
    }
    timed('microphone.start', () => microphone.start())
    if (which === 'cue-after') timed('play cue (memory)', () => playCue('start', 0.7))
    if (which === 'cue-sync-open') timed('play cue (sync mem)', () => PlaySoundW(koffi.address(cueMemory), null, SND_MEMORY | SND_NODEFAULT))
    await sleep(1200)
    timed('microphone.save', () => {
      const saved = microphone.save(output)
      return `${saved.seconds.toFixed(2)}s ${saved.format.sampleRate}Hz`
    })
  } catch (error) {
    outcome = `error: ${error?.message ?? error}`
  } finally {
    try {
      timed('microphone.close', () => {
        microphone.close()
        return 'closed'
      })
    } catch (error) {
      log(`    close failed: ${error?.message ?? error}`)
    }
    rmSync(dir, { recursive: true, force: true })
  }
  log(`  outcome: ${outcome}`)
  return outcome
}

const wanted = mode === 'all' ? MODES : [mode]
for (const which of wanted) {
  if (!MODES.includes(which)) {
    log(`unknown mode "${which}"; known: ${MODES.join(', ')}`)
    process.exit(2)
  }
}
watchdog = setTimeout(() => {
  log(`\n  HANG: "${step}" did not return within 30000 ms`)
  process.exit(9)
}, 30000)
for (const which of wanted) await run(which)
clearTimeout(watchdog)
log('\nno mode stalled')
