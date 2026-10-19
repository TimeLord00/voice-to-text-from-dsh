/**
 * The four dictation cues, synthesized instead of borrowed from the Windows sound scheme.
 *
 * `MessageBeep` can only play the sounds the user picked in 控制面板 -> 声音, so a dictation tool built on
 * it sounds exactly like every other Windows program. These cues are generated here as ordinary PCM, so
 * they are recognizable, distinguishable from each other and identical on every machine:
 *
 *   start  two rising notes        "I am listening now"
 *   stop   one low note            "I have your recording"
 *   done   three quick rising notes "here is your text"
 *   error  two falling notes       "nothing came back"
 *
 * Every cue is a few sine partials with a soft attack and a cosine tail, which is what keeps them from
 * clicking at the edges. Nothing here touches Win32: {@link renderCue} returns WAV bytes and
 * src/win32.mjs plays them through PlaySound with SND_MEMORY.
 */

/** Cue sample rate. 44.1 kHz keeps the partials clean and every audio device accepts it. */
export const SAMPLE_RATE = 44100

/** Default loudness, 0..1, of the loudest cue peak. Chosen so a cue is clearly audible but not jarring. */
export const DEFAULT_CUE_VOLUME = 0.7

/** Note names used below, in Hz. */
const NOTES = {
  g4: 392.0, a4: 440.0, f4: 349.23,
  e5: 659.25, g5: 783.99, a5: 880.0, c6: 1046.5,
}

/**
 * Cue definitions: a list of `[frequency, milliseconds]` notes and the gap between them.
 * @type {Record<string, {notes: [number, number][], gapMs: number, gain: number}>}
 */
export const CUES = {
  start: { notes: [[NOTES.e5, 55], [NOTES.a5, 85]], gapMs: 6, gain: 0.95 },
  stop: { notes: [[NOTES.g4, 90]], gapMs: 0, gain: 0.8 },
  done: { notes: [[NOTES.e5, 40], [NOTES.g5, 40], [NOTES.c6, 70]], gapMs: 6, gain: 0.95 },
  error: { notes: [[NOTES.a4, 85], [NOTES.f4, 140]], gapMs: 8, gain: 0.8 },
}

/** Kinds accepted by {@link cueSamples}. */
export const CUE_KINDS = Object.keys(CUES)

/**
 * Total length of a cue.
 * @param {string} kind - one of {@link CUE_KINDS}.
 * @returns {number} milliseconds.
 */
export function cueDurationMs(kind) {
  const cue = CUES[kind]
  if (!cue) throw new Error(`Unknown cue "${kind}"; expected one of ${CUE_KINDS.join(', ')}`)
  return cue.notes.reduce((total, [, ms]) => total + ms, 0) + cue.gapMs * (cue.notes.length - 1)
}

/**
 * Synthesize one cue.
 * @param {string} kind - one of {@link CUE_KINDS}.
 * @param {{volume?: number, sampleRate?: number}} [options] - `volume` scales the peak (default
 *   {@link DEFAULT_CUE_VOLUME}); it is clamped to 0..1.
 * @returns {Float32Array} mono samples in [-1, 1].
 */
export function cueSamples(kind, options = {}) {
  const cue = CUES[kind]
  if (!cue) throw new Error(`Unknown cue "${kind}"; expected one of ${CUE_KINDS.join(', ')}`)
  const { sampleRate = SAMPLE_RATE } = options
  const volume = Math.max(0, Math.min(1, options.volume ?? DEFAULT_CUE_VOLUME))
  const samples = new Float32Array(Math.round((cueDurationMs(kind) * sampleRate) / 1000) + 1)
  let offset = 0
  for (const [frequency, ms] of cue.notes) {
    const length = Math.round((ms * sampleRate) / 1000)
    const attack = Math.max(1, Math.round(sampleRate * 0.003))
    const release = Math.max(1, Math.min(Math.round(sampleRate * 0.03), Math.floor(length * 0.6)))
    for (let index = 0; index < length; index += 1) {
      const t = index / sampleRate
      const partials = Math.sin(2 * Math.PI * frequency * t)
        + 0.25 * Math.sin(4 * Math.PI * frequency * t)
        + 0.07 * Math.sin(6 * Math.PI * frequency * t)
      let envelope = 1
      if (index < attack) envelope = index / attack
      const tail = length - index
      if (tail < release) envelope = Math.min(envelope, 0.5 - 0.5 * Math.cos((Math.PI * tail) / release))
      samples[offset + index] += (cue.gain * volume * envelope * partials) / 1.32
    }
    offset += length + Math.round((cue.gapMs * sampleRate) / 1000)
  }
  return samples
}

/**
 * Wrap mono float samples in a 16-bit PCM RIFF/WAVE container.
 * @param {Float32Array} samples - signal in [-1, 1]; values outside are clamped.
 * @param {number} sampleRate - container sample rate.
 * @returns {Buffer} WAV bytes PlaySound accepts with SND_MEMORY.
 */
export function encodePcm16Wav(samples, sampleRate = SAMPLE_RATE) {
  const out = Buffer.alloc(44 + samples.length * 2)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + samples.length * 2, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(sampleRate, 24)
  out.writeUInt32LE(sampleRate * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(samples.length * 2, 40)
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]))
    out.writeInt16LE(Math.round(clamped * 32767), 44 + index * 2)
  }
  return out
}

/**
 * Synthesize one cue as WAV bytes ready for PlaySound.
 * @param {string} kind - one of {@link CUE_KINDS}.
 * @param {{volume?: number, sampleRate?: number}} [options] - see {@link cueSamples}.
 * @returns {Buffer} WAV bytes.
 */
export function renderCue(kind, options = {}) {
  const sampleRate = options.sampleRate ?? SAMPLE_RATE
  return encodePcm16Wav(cueSamples(kind, { ...options, sampleRate }), sampleRate)
}
