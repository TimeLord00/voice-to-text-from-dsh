/**
 * Measure what the user described as "the first time you speak it cannot hear you — there is a
 * start-up step".
 *
 * Two candidate causes, both measurable:
 *  1. `open` + `record` on the waveaudio device is slow, so speech that happens right after the click
 *     is simply not being captured yet;
 *  2. MCI prepends silence or drops the beginning of the buffer.
 *
 * The probe also answers a design question: may the device stay open between recordings (which would
 * make the second and later recordings instant), or must every recording close and reopen it?
 *
 * Run: node probe\mic-latency.mjs
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Microphone } from '../src/win32.mjs'
import { decodeWav, toCanonicalWav } from '../src/wav.mjs'

const dir = mkdtempSync(join(tmpdir(), 'vtt-latency-'))
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/**
 * Record for a while and report the timings plus the shape of the captured buffer.
 * @param {Microphone} mic - the microphone.
 * @param {string} label - label for the report.
 * @param {number} seconds - how long to record.
 * @param {{open?: boolean, close?: boolean}} [options] - whether to open first and close after.
 * @returns {{openMs: number, startMs: number, stopMs: number, saveMs: number, seconds: number,
 *   leadingZeros: number, peak: number}} measurements.
 */
async function measure(mic, label, seconds, options = {}) {
  const file = join(dir, `${label}.wav`)
  let openMs = 0
  let startMs = 0
  let stopMs = 0
  let saveMs = 0
  if (options.open !== false) {
    let at = Date.now()
    mic.open()
    openMs = Date.now() - at
  }
  let at = Date.now()
  mic.start()
  startMs = Date.now() - at
  await sleep(seconds * 1000)
  at = Date.now()
  const measured = mic.stop()
  stopMs = Date.now() - at
  at = Date.now()
  mic.save(file)
  saveMs = Date.now() - at
  if (options.close !== false) mic.close()

  const canonical = toCanonicalWav(readFileSync(file))
  const audio = decodeWav(canonical)
  const samples = audio.samples
  let leadingZeros = 0
  while (leadingZeros < samples.length && samples[leadingZeros] === 0) leadingZeros += 1
  let peak = 0
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
  const report = {
    openMs, startMs, stopMs, saveMs, seconds: measured, leadingZeros, peak,
  }
  process.stdout.write(`${label}: open=${openMs}ms start=${startMs}ms stop=${stopMs}ms save=${saveMs}ms `
    + `audio=${measured.toFixed(2)}s leading-silence=${(leadingZeros / 16000).toFixed(3)}s peak=${peak.toFixed(4)}\n`)
  return report
}

const mic = new Microphone()
process.stdout.write('--- cold, one recording per open (what the tool does today) ---\n')
const cold = await measure(mic, 'cold-1', 1.5)
await measure(mic, 'cold-2', 1.5, { open: true, close: true })

process.stdout.write('\n--- can the device stay open between recordings? ---\n')
const file2 = join(dir, 'reuse.wav')
mic.open()
let at = Date.now()
mic.start()
const warmStart = Date.now() - at
await sleep(1200)
mic.stop()
mic.save(file2)
let second = null
try {
  at = Date.now()
  mic.start()
  second = Date.now() - at
  await sleep(1200)
  const seconds2 = mic.stop()
  mic.save(join(dir, 'reuse-2.wav'))
  const audio2 = decodeWav(toCanonicalWav(readFileSync(join(dir, 'reuse-2.wav'))))
  let peak2 = 0
  for (const sample of audio2.samples) peak2 = Math.max(peak2, Math.abs(sample))
  process.stdout.write(`second record without reopening: start=${second}ms audio=${seconds2.toFixed(2)}s peak=${peak2.toFixed(4)} -> REUSE WORKS\n`)
} catch (error) {
  process.stdout.write(`second record without reopening failed: ${error?.message ?? error} -> MUST REOPEN\n`)
}
process.stdout.write(`first start with an already-open device: ${warmStart}ms\n`)
mic.close()

rmSync(dir, { recursive: true, force: true })
process.stdout.write(`\ncold open cost: ${cold.openMs}ms, capture began ${cold.startMs}ms after record\n`)
