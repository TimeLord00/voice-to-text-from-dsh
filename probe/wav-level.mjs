/**
 * Probe: report the level of a recording so "no speech recognized" can be told apart from
 * "the microphone is silent".
 *
 *   node probe\wav-level.mjs recordings\2026-10-19T04-05-13.wav
 *
 * Prints peak/RMS in dBFS, the share of samples that are exactly zero, and how many 20 ms frames
 * rise more than 20 dB above the file's own noise floor (a rough speech-activity count).
 */
import { readFileSync } from 'node:fs'
import { parseWav, decodeWav } from '../src/wav.mjs'

const path = process.argv[2]
if (!path) {
  console.error('usage: node probe\\wav-level.mjs <file.wav>')
  process.exit(2)
}

const bytes = readFileSync(path)
const header = parseWav(bytes)
const { samples, sampleRate, channels, bitsPerSample } = decodeWav(bytes)
const format = `${sampleRate} Hz, ${channels}ch, ${bitsPerSample}-bit`

let peak = 0
let sum = 0
let zeros = 0
for (const sample of samples) {
  const magnitude = Math.abs(sample)
  if (magnitude > peak) peak = magnitude
  sum += sample * sample
  if (sample === 0) zeros += 1
}
const rms = Math.sqrt(sum / samples.length)
const dbfs = (value) => (value <= 0 ? '-inf' : (20 * Math.log10(value)).toFixed(1))

// 20 ms frames: how many stand out from the quietest 10% of frames?
const frame = Math.max(1, Math.round(sampleRate * 0.02))
const levels = []
for (let start = 0; start + frame <= samples.length; start += frame) {
  let energy = 0
  for (let i = start; i < start + frame; i += 1) energy += samples[i] * samples[i]
  levels.push(Math.sqrt(energy / frame))
}
const sorted = [...levels].sort((a, b) => a - b)
const floor = sorted[Math.floor(sorted.length * 0.1)] ?? 0
const active = levels.filter((level) => level > floor * 10 && level > 0.001).length

console.log(`file      ${path}`)
console.log(`format    ${format} (dataOffset ${header.dataOffset}, ${header.dataSize} bytes)`)
console.log(`duration  ${(samples.length / sampleRate).toFixed(2)}s, ${samples.length} samples`)
console.log(`peak      ${peak.toFixed(4)} (${dbfs(peak)} dBFS)`)
console.log(`rms       ${rms.toFixed(4)} (${dbfs(rms)} dBFS)`)
console.log(`zeros     ${((zeros / samples.length) * 100).toFixed(1)}% of samples are exactly 0`)
console.log(`frames    ${active}/${levels.length} 20ms frames stand out above the noise floor (${dbfs(floor)} dBFS)`)
console.log(peak === 0 ? 'verdict   digital silence — the microphone delivered nothing' : active < 3 ? 'verdict   steady noise only — no speech-shaped activity' : 'verdict   activity detected — audio looks like speech or other sound')
