/**
 * What does SenseVoice report about a recording besides its text?
 *
 * The level gate in src/wav.mjs cannot separate quiet speech from a noisy room: on this machine the
 * captured room tone drifts by 8 dB between runs, and at its loud end it produces the same 240 ms run of
 * frames above the noise floor that quiet speech does. sherpa-onnx's result carries more than `text`:
 * `lang`, `emotion`, `event`, `timestamps` and `tokens`. The `event` tag is the model's own verdict about
 * what it heard (`<|Speech|>`, `<|BGM|>`, `<|Applause|>`, ...), so it may be a better gate than level.
 * This probe prints every field for every file, next to the level measurements, so that question can be
 * answered from measurements instead of from hope.
 *
 * Usage: node probe/sensevoice-fields.mjs <file.wav> [more.wav ...]
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { createRequire } from 'node:module'
import { loadConfig, resolveModels } from '../src/config.mjs'
import { toCanonicalWav, canonicalToFloat, speechActivity, TARGET_RATE } from '../src/wav.mjs'

const config = loadConfig({})
const paths = resolveModels(config)
if (!paths) {
  process.stdout.write('no model files found; run "vtt models --fetch" first\n')
  process.exit(4)
}
const sherpa = createRequire(import.meta.url)('sherpa-onnx-node')
const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: TARGET_RATE, featureDim: 80 },
  modelConfig: {
    senseVoice: { model: paths.model, language: config.language, useInverseTextNormalization: 1 },
    tokens: paths.tokens,
    numThreads: config.threads,
    provider: 'cpu',
    debug: 0,
  },
})

for (const file of process.argv.slice(2)) {
  const samples = canonicalToFloat(toCanonicalWav(readFileSync(file)))
  const activity = speechActivity(samples, {
    sampleRate: TARGET_RATE,
    marginDb: config.speechMarginDb,
    minFrames: config.minSpeechFrames,
  })
  const stream = recognizer.createStream()
  stream.acceptWaveform({ sampleRate: TARGET_RATE, samples })
  recognizer.decode(stream)
  const result = recognizer.getResult(stream)
  process.stdout.write(`\n${basename(file)}\n`)
  process.stdout.write(`  ${(samples.length / TARGET_RATE).toFixed(2)}s  peak ${activity.peakDbfs.toFixed(1)} dBFS  floor ${activity.floorDbfs.toFixed(1)} dBFS`
    + `  runs ${activity.longestRunFrames}/${activity.relaxedRunFrames}  gate says ${activity.hasSpeech ? 'DECODE' : 'refuse'}\n`)
  for (const key of Object.keys(result)) {
    const value = result[key]
    const shown = Array.isArray(value)
      ? `[${value.length}] ${JSON.stringify(value.slice(0, 8))}${value.length > 8 ? ' ...' : ''}`
      : JSON.stringify(value)
    process.stdout.write(`  ${key.padEnd(12)} ${shown}\n`)
  }
}
