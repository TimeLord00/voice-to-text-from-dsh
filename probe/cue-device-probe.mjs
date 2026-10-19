/**
 * Why does a cue sometimes not play?
 *
 * Plays the shipped cues through the raw `PlaySoundW` while walking through the states a dictation
 * session actually goes through — idle, capture running, capture just stopped, repeated back to back —
 * and prints the return value plus the time each blocking call took. Nothing here uses the wrapper in
 * src/win32.mjs, so the measurement is of the OS and the audio device, not of our own fallback logic.
 *
 * Run: node probe\cue-device-probe.mjs
 *
 * What the columns mean:
 *   rc     PlaySoundW's return value; 0 means the device refused the buffer (our wrapper then falls
 *          back to MessageBeep, which plays a Windows scheme sound — and is silent if that scheme
 *          entry is set to (None))
 *   ms     how long the call blocked; a cue that plays takes about its own length, an immediate
 *          failure returns in ~0 ms
 */
import koffi from 'koffi'
import { CUE_KINDS, renderCue } from '../src/sound.mjs'
import { Microphone } from '../src/win32.mjs'

const winmm = koffi.load('winmm.dll')
const PlaySoundW = winmm.func('int PlaySoundW(void *sound, void *module, unsigned int flags)')
const waveOutGetNumDevs = winmm.func('unsigned int waveOutGetNumDevs()')

const SND_NODEFAULT = 0x0002
const SND_MEMORY = 0x0004

/** @param {string} kind @returns {number} milliseconds the blocking play took, or -1 on refusal */
function playOnce(kind) {
  const wav = renderCue(kind) // keep the buffer alive for the whole call
  const started = process.hrtime.bigint()
  const rc = PlaySoundW(wav, null, SND_MEMORY | SND_NODEFAULT)
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  report.rc = rc
  return rc === 0 ? -1 : ms
}

const report = { rc: 0 }

/** @param {string} label @param {() => void} body */
function scenario(label, body) {
  const rows = []
  for (const kind of CUE_KINDS) {
    const ms = playOnce(kind)
    rows.push(`${kind}: rc=${report.rc} ${ms < 0 ? 'REFUSED' : `${ms.toFixed(0)}ms`}`)
  }
  console.log(`\n${label}\n  ${rows.join('\n  ')}`)
}

console.log(`output devices reported by winmm: ${waveOutGetNumDevs()}`)

scenario('A. idle — no recorder open', () => {})

const microphone = new Microphone()
microphone.open()
microphone.start()
console.log('\n(recorder is live)')
scenario('B. capture running — this is where the start cue plays', () => {})
microphone.stop()
microphone.close()

scenario('C. immediately after the recorder closed — where stop/done/error play', () => {})

scenario('D. four times in a row, to see whether a sleeping device eats the first try', () => {})

const silence = Buffer.alloc(44 + 2205 * 2)
silence.write('RIFF', 0, 'ascii')
silence.writeUInt32LE(36 + 2205 * 2, 4)
silence.write('WAVE', 8, 'ascii')
silence.write('fmt ', 12, 'ascii')
silence.writeUInt32LE(16, 16)
silence.writeUInt16LE(1, 20)
silence.writeUInt16LE(1, 22)
silence.writeUInt32LE(44100, 24)
silence.writeUInt32LE(88200, 28)
silence.writeUInt16LE(2, 32)
silence.writeUInt16LE(16, 34)
silence.write('data', 36, 'ascii')
silence.writeUInt32LE(2205 * 2, 40)
const before = process.hrtime.bigint()
const wakeRc = PlaySoundW(silence, null, SND_MEMORY | SND_NODEFAULT)
const wakeMs = Number(process.hrtime.bigint() - before) / 1e6
console.log(`\nE. 50 ms of silence as a wake-up pre-roll: rc=${wakeRc} ${wakeMs.toFixed(0)}ms`)
scenario('   the same cues right after the pre-roll', () => {})

console.log('\nnote: this session is low integrity, so a refusal here can also be the sandbox rather than the device')
