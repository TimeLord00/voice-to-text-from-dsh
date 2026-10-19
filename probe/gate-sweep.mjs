/**
 * Gate sweep: how many 20 ms frames stand out from a recording's own noise floor, at several margins?
 *
 * The speech-activity gate in src/wav.mjs decides whether a recording is worth decoding, and its two
 * knobs (`speechMarginDb`, `minSpeechFrames`) trade "quiet speech is thrown away" against "room tone is
 * decoded into an invented sentence". This probe prints the whole curve instead of a single verdict, so
 * the defaults can be chosen from measurements.
 *
 * Usage:
 *   node probe/gate-sweep.mjs <file.wav> [more.wav ...]
 *   node probe/gate-sweep.mjs --synth            # room tone + a synthetic quiet voice at the same peak
 *   node probe/gate-sweep.mjs --cue              # room tone while the start cue plays
 *
 * Every real file goes through the real pipeline (toCanonicalWav -> canonicalToFloat), so what is
 * measured is exactly what the recognizer would have received.
 */
import { readFileSync, rmSync } from 'node:fs'
import { basename } from 'node:path'
import { Microphone, tempRecordingPath, playCue, MIC_FORMAT } from '../src/win32.mjs'
import { toCanonicalWav, canonicalToFloat, TARGET_RATE, speechActivity } from '../src/wav.mjs'
import { loadConfig } from '../src/config.mjs'

const MARGINS = [4, 6, 8, 10, 12, 16, 20]
const FRAME_MS = 20
const config = loadConfig({})

/** @param {Float32Array} samples @returns {{levels: number[], peak: number}} */
function frameLevels(samples) {
  const frame = Math.round((TARGET_RATE * FRAME_MS) / 1000)
  const levels = []
  let peak = 0
  for (let start = 0; start + frame <= samples.length; start += frame) {
    let energy = 0
    for (let index = start; index < start + frame; index += 1) {
      energy += samples[index] * samples[index]
      const magnitude = Math.abs(samples[index])
      if (magnitude > peak) peak = magnitude
    }
    levels.push(Math.sqrt(energy / frame))
  }
  return { levels, peak }
}

const dbfs = (value) => (value > 0 ? 20 * Math.log10(value) : Number.NEGATIVE_INFINITY)

/** @param {number[]} levels @param {number} marginDb @returns {{active: number, longestMs: number, totalMs: number}} */
function sweep(levels, marginDb) {
  const sorted = [...levels].sort((a, b) => a - b)
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? 0
  const threshold = floor * 10 ** (marginDb / 20)
  let active = 0
  let longest = 0
  let run = 0
  for (const level of levels) {
    if (level > threshold && level > 0.001) {
      active += 1
      run += 1
      if (run > longest) longest = run
    } else run = 0
  }
  return { active, longestMs: longest * FRAME_MS, totalMs: active * FRAME_MS }
}

/** @param {string} label @param {Float32Array} samples */
function report(label, samples) {
  const { levels, peak } = frameLevels(samples)
  const sorted = [...levels].sort((a, b) => a - b)
  const pick = (q) => dbfs(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0)
  let energy = 0
  for (const value of samples) energy += value * value
  const rms = Math.sqrt(energy / Math.max(1, samples.length))
  process.stdout.write(`\n${label}\n`)
  process.stdout.write(`  ${(samples.length / TARGET_RATE).toFixed(2)}s  peak ${dbfs(peak).toFixed(1)} dBFS  rms ${dbfs(rms).toFixed(1)} dBFS\n`)
  process.stdout.write(`  frame levels: floor(p10) ${pick(0.1).toFixed(1)}  p50 ${pick(0.5).toFixed(1)}  p90 ${pick(0.9).toFixed(1)}  max ${pick(0.999).toFixed(1)} dBFS  (${levels.length} frames)\n`)
  process.stdout.write(`  margin   active frames   longest run   total\n`)
  for (const margin of MARGINS) {
    const { active, longestMs, totalMs } = sweep(levels, margin)
    process.stdout.write(`  ${String(margin).padStart(4)} dB ${String(active).padStart(13)} ${String(`${longestMs} ms`).padStart(14)} ${String(`${totalMs} ms`).padStart(8)}\n`)
  }
  // The verdict line comes from the shipped gate itself, not from this probe's copy of the maths.
  const verdict = speechActivity(samples, { sampleRate: TARGET_RATE, marginDb: config.speechMarginDb, minFrames: config.minSpeechFrames })
  process.stdout.write(`  verdict at the shipped defaults (${config.speechMarginDb} dB / ${config.minSpeechFrames} frames): `
    + `${verdict.hasSpeech ? 'DECODED' : 'refused as room tone'} `
    + `(strict run ${verdict.longestRunFrames}, relaxed run ${verdict.relaxedRunFrames})\n`)
}

/** Room tone captured now, plus a synthetic "quiet voice" built on top of it. */
function synthesize() {
  const microphone = new Microphone()
  microphone.open()
  microphone.start()
  const until = Date.now() + 3000
  while (Date.now() < until) { /* the recorder runs on its own thread */ }
  const saved = microphone.save(tempRecordingPath())
  microphone.close()
  const room = canonicalToFloat(toCanonicalWav(readFileSync(saved.path), saved.format))
  rmSync(saved.path, { force: true })
  report('captured room tone (this machine, right now)', room)

  // A voice at the level the user's failing attempts reached: voiced syllable bursts whose 20 ms frames
  // sit roughly 10 dB above the room floor, with gaps of the length real speech leaves between syllables
  // (a 150 ms gap would break every run and make the measurement look worse than a real voice).
  for (const scale of [0.02, 0.045, 0.09]) {
    const voiced = Float32Array.from(room)
    const syllable = Math.round(TARGET_RATE * 0.25)
    const gap = Math.round(TARGET_RATE * 0.05)
    let position = Math.round(TARGET_RATE * 0.3)
    let syllableIndex = 0
    while (position + syllable < voiced.length) {
      const fundamental = [140, 175, 210, 160][syllableIndex % 4]
      for (let index = 0; index < syllable; index += 1) {
        const t = index / TARGET_RATE
        const envelope = Math.sin(Math.PI * (index / syllable)) ** 2
        const carrier = Math.sin(2 * Math.PI * fundamental * t)
          + 0.5 * Math.sin(2 * Math.PI * fundamental * 2 * t)
          + 0.3 * Math.sin(2 * Math.PI * fundamental * 3 * t)
        voiced[position + index] += scale * envelope * carrier
      }
      position += syllable + gap
      syllableIndex += 1
    }
    report(`room tone + synthetic quiet voice (scale ${scale})`, voiced)
  }

  const clicked = Float32Array.from(room)
  clicked[Math.round(TARGET_RATE * 1.2)] = 0.045
  report('room tone + a single sample click (peak -27 dBFS, no speech structure)', clicked)
}

/** Room tone captured while the start cue plays — what an empty room sounds like to the gate. */
function withCue() {
  for (const order of ['during', 'before']) {
    const microphone = new Microphone()
    microphone.open()
    // The shipped order plays the cue right after the recorder starts; the alternative plays it first.
    if (order === 'before') playCue('start', config.beepVolume)
    microphone.start()
    if (order === 'during') playCue('start', config.beepVolume)
    const until = Date.now() + 2500
    while (Date.now() < until) { /* the recorder runs on its own thread */ }
    const saved = microphone.save(tempRecordingPath())
    microphone.close()
    const room = canonicalToFloat(toCanonicalWav(readFileSync(saved.path), saved.format))
    rmSync(saved.path, { force: true })
    report(`room tone with the start cue played ${order} the recording (volume ${config.beepVolume})`, room)
  }
}

const args = process.argv.slice(2)
if (args.length === 0 || args[0] === '--synth') synthesize()
else if (args[0] === '--cue') withCue()
else {
  for (const file of args) {
    report(`${basename(file)}`, canonicalToFloat(toCanonicalWav(readFileSync(file))))
  }
}
