/**
 * Self-test for the audio pieces: the speech-activity gate that decides whether a recording is worth
 * decoding, the synthesized dictation cues, and the one interaction between them that must never break —
 * a cue played just before the recorder opens. That last one deadlocked the WinMM mapper once (an
 * asynchronous PlaySound still in flight makes `mciSendStringW('record')` never return), so it is proven
 * through `probe/cue-capture-probe.mjs` in a child process with a timeout: a hang fails the suite instead
 * of hanging it.
 *
 * The gate and cue cases are pure functions, so most of this needs no microphone and no models.
 *
 * Usage: node test/audio-selftest.mjs
 */
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { speechActivity } from '../src/wav.mjs'
import { CUE_KINDS, SAMPLE_RATE, cueDurationMs, cueSamples, encodePcm16Wav, renderCue } from '../src/sound.mjs'
import { DEFAULT_CUE_VOLUME } from '../src/sound.mjs'
import { loadConfig } from '../src/config.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
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
 * Report something this machine cannot answer either way, without failing the suite.
 * @param {string} label - what could not be measured.
 * @param {string} detail - why.
 * @returns {void}
 */
function note(label, detail) {
  process.stdout.write(`  NOTE ${label} — ${detail}\n`)
}

const RATE = 16000

/**
 * Deterministic white noise with a fixed frame level, so the gate sees a stationary floor.
 * @param {number} ms - length in milliseconds.
 * @param {number} amplitude - peak of the uniform noise.
 * @returns {Float32Array} samples.
 */
function noise(ms, amplitude) {
  const samples = new Float32Array(Math.round((RATE * ms) / 1000))
  let seed = 12345
  for (let index = 0; index < samples.length; index += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    samples[index] = amplitude * ((seed / 0x3fffffff) - 1)
  }
  return samples
}

/**
 * Noise with one sustained tone in the middle: the shape of "somebody said one word".
 *
 * The tone is flat across the middle with short ramps, because a real syllable holds its level (that is
 * what makes a run of frames), and `levelDb` is stated relative to the noise RMS so the tests can say
 * "12 dB above the floor" and mean it.
 * @param {number} totalMs - total length.
 * @param {number} amplitude - noise peak.
 * @param {number} burstMs - burst length.
 * @param {number} levelDb - burst level above the noise RMS, in dB.
 * @returns {Float32Array} samples.
 */
function noiseWithBurst(totalMs, amplitude, burstMs, levelDb) {
  const samples = noise(totalMs, amplitude)
  const start = Math.round((RATE * (totalMs - burstMs)) / 2000)
  const length = Math.round((RATE * burstMs) / 1000)
  const noiseRms = amplitude / Math.sqrt(3)
  const tone = noiseRms * 10 ** (levelDb / 20) * Math.SQRT2
  const ramp = Math.max(1, Math.round(length * 0.15))
  for (let index = 0; index < length; index += 1) {
    let envelope = 1
    if (index < ramp) envelope = index / ramp
    else if (index >= length - ramp) envelope = (length - index) / ramp
    samples[start + index] += tone * envelope * Math.sin((2 * Math.PI * 180 * index) / RATE)
  }
  return samples
}

process.stdout.write('audio self-test\n\nspeech-activity gate\n')

// 0.003 peak uniform noise sits near -57 dBFS, the same order as this machine's room tone.
const floor = -57
const quiet = speechActivity(noise(2000, 0.003))
check('stationary noise is refused', quiet.hasSpeech === false, JSON.stringify({ peak: quiet.peakDbfs.toFixed(1), floor: quiet.floorDbfs.toFixed(1), run: quiet.longestRunFrames }))
check('measured floor matches the injected level', Math.abs(quiet.floorDbfs - floor) < 4, `${quiet.floorDbfs.toFixed(1)} dBFS`)
check('a single loud sample is not speech', speechActivity(withClick(noise(2000, 0.003))).hasSpeech === false)

const word = speechActivity(noiseWithBurst(2000, 0.003, 220, 20))
check('a 220 ms word 20 dB above the floor is decoded', word.hasSpeech === true, JSON.stringify({ run: word.longestRunFrames, runMs: word.longestRunMs }))
check('the word appears as one run of at least 4 frames', word.longestRunFrames >= 4, `${word.longestRunFrames} frames`)

const blip = speechActivity(noiseWithBurst(2000, 0.003, 60, 20))
check('a 60 ms blip is too short to count', blip.hasSpeech === false, `${blip.longestRunFrames} frames`)

// The loudest room tone measured on this machine: a 240 ms run of frames 10 dB above its own floor. It was
// decoded by the previous 10 dB default and the model answered it with an invented sentence, so it is a
// regression case, not a hypothetical one.
const loudRoom = speechActivity(noiseWithBurst(2000, 0.003, 240, 10))
check('room tone with a 240 ms run at +10 dB is refused', loudRoom.hasSpeech === false, `${loudRoom.longestRunFrames} / ${loudRoom.relaxedRunFrames} frames`)
check('room tone just under the strict margin is refused', speechActivity(noiseWithBurst(2000, 0.003, 40, 14)).hasSpeech === false)

// 12 dB, sustained: the band where a soft but continuous voice lands. The strict margin cannot see it, so it
// has to qualify through the relaxed rule (6 dB less margin over six times the run).
const murmur = speechActivity(noiseWithBurst(2000, 0.003, 800, 12))
check('an 800 ms murmur 12 dB above the floor is still decoded', murmur.hasSpeech === true, JSON.stringify({ run: murmur.relaxedRunFrames, runMs: murmur.relaxedRunMs }))
check('the murmur qualifies through the relaxed rule, not the strict one', murmur.longestRunFrames < 4 && murmur.relaxedRunFrames >= 24, `${murmur.longestRunFrames} / ${murmur.relaxedRunFrames}`)
check('a short murmur is not enough for the relaxed rule', speechActivity(noiseWithBurst(2000, 0.003, 240, 12)).hasSpeech === false)
check('speech 4 dB above the floor is below both rules', speechActivity(noiseWithBurst(2000, 0.003, 300, 4)).hasSpeech === false)

check('marginDb 0 decodes everything', speechActivity(noise(1000, 0.003), { marginDb: 0 }).hasSpeech === true)
check('an empty recording is not speech', speechActivity(new Float32Array(0)).hasSpeech === false)
check('a louder margin refuses what the default accepts', speechActivity(noiseWithBurst(2000, 0.003, 220, 20), { marginDb: 24 }).hasSpeech === false)
check('the result exposes the documented measurements', ['peakDbfs', 'floorDbfs', 'medianDbfs', 'p90Dbfs', 'frames', 'activeFrames', 'longestRunFrames', 'longestRunMs', 'relaxedRunFrames', 'relaxedRunMs', 'hasSpeech']
  .every((key) => key in quiet))

const defaults = loadConfig({})
check('the shipped defaults are the tuned ones', defaults.speechMarginDb === 16 && defaults.minSpeechFrames === 4, `${defaults.speechMarginDb} dB / ${defaults.minSpeechFrames} frames`)
check('the shipped cue volume is in range', defaults.beepVolume > 0 && defaults.beepVolume <= 1, String(defaults.beepVolume))

process.stdout.write('\ndictation cues\n')
check('four cue kinds exist', CUE_KINDS.length === 4 && CUE_KINDS.join(',') === 'start,stop,done,error', CUE_KINDS.join(','))

const rendered = {}
for (const kind of CUE_KINDS) {
  const samples = cueSamples(kind)
  rendered[kind] = samples
  const ms = cueDurationMs(kind)
  const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
  check(`${kind}: 60-300 ms long`, ms >= 60 && ms <= 300, `${ms} ms`)
  check(`${kind}: audible but not clipped`, peak > 0.05 && peak <= 1, `peak ${peak.toFixed(3)}`)
  check(`${kind}: starts and ends near silence`, Math.abs(samples[0]) < 0.02 && Math.abs(samples[samples.length - 1]) < 0.02)
}

for (const a of CUE_KINDS) {
  for (const b of CUE_KINDS) {
    if (a >= b) continue
    const same = rendered[a].length === rendered[b].length
      && rendered[a].every((value, index) => Math.abs(value - rendered[b][index]) < 1e-6)
    check(`${a} and ${b} are different sounds`, !same)
  }
}

const wav = renderCue('start')
check('a cue renders as a RIFF/WAVE file', wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE')
check('the cue WAV is 16-bit mono PCM', wav.readUInt16LE(20) === 1 && wav.readUInt16LE(22) === 1 && wav.readUInt16LE(34) === 16)
check('the cue WAV carries its own sample rate', wav.readUInt32LE(24) === SAMPLE_RATE, `${wav.readUInt32LE(24)} Hz`)
check('the cue WAV declares the right data size', wav.readUInt32LE(40) === wav.length - 44 && wav.readUInt32LE(4) === wav.length - 8)

const loud = cueSamples('start', { volume: 1 })
const soft = cueSamples('start', { volume: DEFAULT_CUE_VOLUME / 2 })
const peakOf = (samples) => samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
check('volume scales the cue', peakOf(soft) < peakOf(rendered.start) && peakOf(rendered.start) < peakOf(loud), `${peakOf(soft).toFixed(3)} < ${peakOf(rendered.start).toFixed(3)} < ${peakOf(loud).toFixed(3)}`)
check('volume 0 is silent', peakOf(cueSamples('done', { volume: 0 })) === 0)
check('an unknown cue is an error', (() => { try { cueSamples('nope'); return false } catch { return true } })())
check('encodePcm16Wav writes the header it promises', encodePcm16Wav(new Float32Array(10), 8000).readUInt32LE(24) === 8000)

/** @param {Float32Array} samples @returns {Float32Array} the same signal with one loud sample in it. */
function withClick(samples) {
  samples[Math.round(samples.length / 2)] = 0.05
  return samples
}

process.stdout.write('\ncue playback and the recorder\n')
// The native layer is imported here rather than at the top so the pure checks above still run on a machine
// where koffi cannot load.
const { playCue } = await import('../src/win32.mjs')
let playMs = -1
let accepted = false
try {
  const startedAt = Date.now()
  accepted = playCue('start', 0.7)
  playMs = Date.now() - startedAt
} catch (error) {
  note('cue playback', `the native call failed: ${error?.message ?? error}`)
}
if (accepted) {
  check('a cue plays to its end before returning (no asynchronous playback is left behind)', playMs >= 25, `${playMs} ms for a ${cueDurationMs('start')} ms cue`)
} else {
  note('cue playback', 'the audio device refused the buffer, so the blocking guarantee could not be measured')
}

// The field bug this guards: a cue in flight when the MCI mapper opens the capture device froze the whole
// process inside a synchronous native call, so it cannot be caught from inside this process at all.
const output = join(ROOT, 'test-output')
mkdirSync(output, { recursive: true })
const logPath = join(output, 'cue-capture-check.log')
const fd = openSync(logPath, 'w')
const probe = spawnSync(process.execPath, [join(ROOT, 'probe', 'cue-capture-probe.mjs'), 'cue-sync-mem'], {
  cwd: ROOT,
  stdio: ['ignore', fd, fd],
  timeout: 25000,
  windowsHide: true,
})
closeSync(fd)
const probeLog = readFileSync(logPath, 'utf8')
check(
  'a cue followed by a recording finishes instead of deadlocking',
  probe.status === 0 && !probe.signal,
  `exit ${probe.status}${probe.signal ? ` signal ${probe.signal}` : ''}${probe.error ? ` (${probe.error.code})` : ''}`,
)
check('the probe really recorded after the cue', /outcome: ok/.test(probeLog) && /microphone\.save\s+\d+ ms/.test(probeLog))

process.stdout.write(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} FAILED: ${failures.join('; ')}`}\n`)
process.exitCode = failures.length === 0 ? 0 : 1
