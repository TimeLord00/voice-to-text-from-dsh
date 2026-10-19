/**
 * SenseVoice + Silero VAD inference, lifted from the DSH voice-input plugin
 * (`packages/experimental/speech-to-text-sensevoice/src/inference.ts`) with the same model
 * configuration, the same 512-sample VAD framing, the same first-segment onset restoration and the
 * same per-segment decode loop, so results match what the plugin produces.
 *
 * Input is always a canonical 16 kHz mono PCM16 WAV; anything else is rejected before native code
 * sees it, exactly like the plugin's worker does.
 */
import { createRequire } from 'node:module'
import { TARGET_RATE, canonicalToFloat, speechActivity } from './wav.mjs'
import { LANGUAGES } from './config.mjs'

/** Silero consumes fixed 512-sample frames at 16 kHz. */
const VAD_WINDOW = 512

/** Thrown for input the recognizer must not see. */
export class SpeechInputError extends Error {}

/**
 * Verify a canonical recording without decoding it.
 * @param {Uint8Array|Buffer} audio - candidate recording.
 * @param {number} maxSeconds - upper bound on duration.
 * @returns {number} duration in seconds.
 */
export function validateCanonical(audio, maxSeconds) {
  if (audio.length < 46 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE'
    || audio.toString('ascii', 12, 16) !== 'fmt ' || audio.readUInt32LE(16) !== 16
    || audio.readUInt16LE(20) !== 1 || audio.readUInt16LE(22) !== 1 || audio.readUInt32LE(24) !== TARGET_RATE
    || audio.readUInt32LE(28) !== TARGET_RATE * 2 || audio.readUInt16LE(32) !== 2 || audio.readUInt16LE(34) !== 16
    || audio.toString('ascii', 36, 40) !== 'data' || audio.readUInt32LE(4) !== audio.length - 8
    || audio.readUInt32LE(40) !== audio.length - 44 || (audio.length - 44) % 2 !== 0) {
    throw new SpeechInputError('Audio must be a canonical 16 kHz mono PCM16 WAV recording')
  }
  const seconds = (audio.length - 44) / (TARGET_RATE * 2)
  if (seconds > maxSeconds) throw new SpeechInputError(`Audio exceeds ${maxSeconds} seconds`)
  return seconds
}

/**
 * One process-wide native recognizer pair, loaded on first use.
 */
export class SpeechEngine {
  /**
   * @param {object} config - effective configuration.
   * @param {{model: string, tokens: string, vad: string, source: string}} paths - resolved model files.
   */
  constructor(config, paths) {
    this.config = config
    this.paths = paths
    this.recognizer = null
    this.detector = null
    this.nativeConfig = null
    this.loadedAt = null
    this.inferences = 0
    this.audioSeconds = 0
  }

  /** @returns {boolean} whether the native models are currently resident. */
  get loaded() {
    return this.recognizer !== null
  }

  /**
   * Build the native recognizer and VAD. Idempotent; blocks for one to three seconds on a cold start.
   * @returns {SpeechEngine} this instance.
   */
  load() {
    if (this.loaded) return this
    const sherpa = createRequire(import.meta.url)('sherpa-onnx-node')
    const { config, paths } = this
    this.nativeConfig = {
      featConfig: { sampleRate: TARGET_RATE, featureDim: 80 },
      modelConfig: {
        senseVoice: { model: paths.model, language: 'auto', useInverseTextNormalization: 1 },
        tokens: paths.tokens,
        numThreads: config.threads,
        provider: 'cpu',
        debug: 0,
      },
    }
    this.recognizer = new sherpa.OfflineRecognizer(this.nativeConfig)
    this.detector = new sherpa.Vad({
      sileroVad: {
        model: paths.vad,
        threshold: config.vadThreshold,
        minSilenceDuration: config.minSilenceSeconds,
        minSpeechDuration: config.minSpeechSeconds,
        maxSpeechDuration: config.segmentSeconds,
        windowSize: VAD_WINDOW,
      },
      sampleRate: TARGET_RATE,
      numThreads: config.threads,
      provider: 'cpu',
      debug: 0,
    }, config.segmentSeconds + config.minSilenceSeconds + 1)
    this.loadedAt = Date.now()
    return this
  }

  /**
   * Transcribe a canonical recording.
   * @param {Uint8Array|Buffer} audio - canonical 16 kHz mono PCM16 WAV bytes.
   * @param {string} [language] - SenseVoice language hint.
   * @returns {{text: string, audioSeconds: number, inferenceSeconds: number, segments: number,
   *   peakDbfs: number, reason?: string}} text and measurements; `reason` is `no-speech-activity` when
   *   the recording was not decoded at all.
   */
  transcribe(audio, language = this.config.language) {
    if (!LANGUAGES.includes(language)) throw new SpeechInputError(`Unsupported SenseVoice language "${language}"; expected one of ${LANGUAGES.join(', ')}`)
    const maxSeconds = Math.max(this.config.maxSeconds, 60)
    const audioSeconds = validateCanonical(audio, maxSeconds)
    const samples = canonicalToFloat(audio)
    // Refuse to decode a recording that contains nothing but its own noise floor. Without this the model
    // answers steady room tone with an invented sentence, which is worse than saying nothing at all: the
    // text is pasted into whatever the user was typing in. See speechActivity in src/wav.mjs.
    const activity = speechActivity(samples, {
      sampleRate: TARGET_RATE,
      marginDb: this.config.speechMarginDb,
      minFrames: this.config.minSpeechFrames,
    })
    if (!activity.hasSpeech) {
      return {
        text: '',
        audioSeconds,
        inferenceSeconds: 0,
        segments: 0,
        peakDbfs: activity.peakDbfs,
        reason: 'no-speech-activity',
      }
    }
    this.load()
    const { recognizer, detector, nativeConfig } = this
    nativeConfig.modelConfig.senseVoice.language = language
    recognizer.setConfig(nativeConfig)
    detector.reset()
    const started = performance.now()
    const texts = []
    const onsetPadding = Math.round(this.config.vadOnsetPaddingSeconds * TARGET_RATE)
    let isFirstSegment = true
    const drain = () => {
      while (!detector.isEmpty()) {
        const segment = detector.front(false)
        let speech = segment.samples
        // Silero cannot back-date the first segment of a cold detector: it reports a start index
        // several frames after speech began, so restore the dropped onset from the recording.
        if (isFirstSegment) {
          isFirstSegment = false
          const from = Math.max(0, segment.start - onsetPadding)
          if (from < segment.start) {
            const restored = new Float32Array(segment.start - from + speech.length)
            restored.set(samples.subarray(from, segment.start))
            restored.set(speech, segment.start - from)
            speech = restored
          }
        }
        const stream = recognizer.createStream()
        stream.acceptWaveform({ sampleRate: TARGET_RATE, samples: speech })
        recognizer.decode(stream)
        texts.push(recognizer.getResult(stream).text.trim())
        detector.pop()
      }
    }
    for (let offset = 0; offset < samples.length; offset += VAD_WINDOW) {
      detector.acceptWaveform(samples.subarray(offset, offset + VAD_WINDOW))
      drain()
    }
    detector.flush()
    drain()
    const inferenceSeconds = (performance.now() - started) / 1000
    this.inferences += 1
    this.audioSeconds += audioSeconds
    return {
      text: texts.filter(Boolean).join(' ').trim(),
      audioSeconds,
      inferenceSeconds,
      segments: texts.length,
      peakDbfs: activity.peakDbfs,
    }
  }

  /**
   * Drop the native models so an idle process releases their memory.
   * @returns {boolean} whether anything was released.
   */
  unload() {
    if (!this.loaded) return false
    this.recognizer = null
    this.detector = null
    this.loadedAt = null
    return true
  }
}

/**
 * Resolve models and build an engine, or explain what is missing.
 * @param {object} config - effective configuration.
 * @param {object} resolveModels - model resolver from config.mjs.
 * @returns {SpeechEngine} engine that loads lazily.
 */
export function createEngine(config, resolveModels) {
  const paths = resolveModels(config)
  if (!paths) {
    throw new Error('SenseVoice models were not found. Run "vtt fetch-models" to download them '
      + '(about 241 MB), or point config.json -> models.modelDir at an existing model directory.')
  }
  return new SpeechEngine(config, paths)
}
