/**
 * The four dictation cues, synthesized as water drops instead of borrowed from the Windows sound scheme.
 *
 * `MessageBeep` can only play the sounds the user picked in 控制面板 -> 声音, so a dictation tool built on
 * it sounds exactly like every other Windows program. These cues are generated here as ordinary PCM, so
 * they are recognizable, distinguishable from each other and identical on every machine.
 *
 * The family is a **water drop**: a short sine whose pitch glides upward while its amplitude decays
 * exponentially, plus a whisper of low-passed noise at the onset for the "plip" of the surface. Field
 * feedback drove this choice — plain sine notes at 660-1050 Hz were reported as 尖 (shrill) and too
 * loud, and a drop is both softer and unmistakable:
 *
 *   start  one drop                 "I am listening now"
 *   stop   one deeper drop          "I have your recording"
 *   done   two drops, the second higher "here is your text"
 *   error  one flat falling bloop   "nothing came back"
 *
 * The error cue deliberately leaves the water family: a descending, muted tone is the one shape a drop
 * cannot be confused with.
 *
 * Nothing here touches Win32: {@link renderCue} returns WAV bytes and src/win32.mjs plays them through
 * PlaySound with SND_MEMORY.
 */

/** Cue sample rate. 44.1 kHz keeps the partials clean and every audio device accepts it. */
export const SAMPLE_RATE = 44100

/**
 * Default loudness, 0..1, of the loudest cue peak. Halved from the first release (0.7 -> 0.35) after the
 * user reported the cues were too loud; a cue at 0.35 peaks near -10 dBFS, which is clearly audible over
 * room tone without being startling.
 */
export const DEFAULT_CUE_VOLUME = 0.35

/**
 * One synthesized voice. The pitch glides geometrically from `from` to `to` over `ms`, the amplitude
 * decays as `exp(-decay * progress)`, `partials` are `[frequencyMultiple, gain]` pairs and `noise` is the
 * gain of the low-passed transient that gives a drop its attack.
 * @typedef {{from: number, to: number, ms: number, gain: number, decay: number,
 *   partials: [number, number][], noise?: number}} Voice
 */

/** A falling drop: the pitch rises, the level drops fast. Used for "start". @type {Voice} */
const DROP = { from: 520, to: 1180, ms: 150, gain: 0.85, decay: 3.2, partials: [[1, 1], [2.7, 0.18], [4.3, 0.05]], noise: 0.045 }

/** The same shape an octave down: a bigger drop landing. @type {Voice} */
const DEEP_DROP = { from: 300, to: 620, ms: 130, gain: 0.8, decay: 2.6, partials: [[1, 1], [2.4, 0.16]], noise: 0.03 }

/** A smaller, higher drop for the second half of "done". @type {Voice} */
const HIGH_DROP = { from: 700, to: 1650, ms: 170, gain: 0.8, decay: 3.4, partials: [[1, 1], [2.6, 0.16], [4, 0.04]], noise: 0.04 }

/** Flat and falling, with almost no high content: the sound of "no". @type {Voice} */
const PLOP = { from: 430, to: 235, ms: 210, gain: 0.7, decay: 1.6, partials: [[1, 1], [1.9, 0.12]], noise: 0.02 }

/**
 * Cue definitions: the voices to play in order, and the silence between them.
 * @type {Record<string, {voices: Voice[], gapMs: number}>}
 */
export const CUES = {
  start: { voices: [DROP], gapMs: 0 },
  stop: { voices: [DEEP_DROP], gapMs: 0 },
  done: { voices: [DROP, HIGH_DROP], gapMs: 12 },
  error: { voices: [PLOP], gapMs: 0 },
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
  return cue.voices.reduce((total, voice) => total + voice.ms, 0) + cue.gapMs * (cue.voices.length - 1)
}

/**
 * Render one voice.
 *
 * The phase is integrated sample by sample rather than computed as `sin(2*pi*f*t)`, because the frequency
 * changes while the note plays and a naive formula would tear the waveform apart at every step. The noise
 * transient runs through a one-pole low-pass so the attack is a soft "plip" and not a click.
 * @param {Voice} voice - see {@link CUES}.
 * @param {number} sampleRate - output rate in Hz.
 * @param {number} volume - 0..1 peak scale.
 * @returns {Float32Array} mono samples in [-1, 1].
 */
function renderVoice(voice, sampleRate, volume) {
  const length = Math.round((voice.ms * sampleRate) / 1000)
  const out = new Float32Array(length)
  const attack = Math.max(1, Math.round(sampleRate * 0.004))
  const release = Math.max(1, Math.round(length * 0.25))
  const ratio = voice.to / voice.from
  const normalise = voice.partials.reduce((total, [, gain]) => total + gain, 0)
  let phase = 0
  let lowpass = 0
  let seed = 0x2545f491
  for (let index = 0; index < length; index += 1) {
    const progress = index / (length - 1)
    const frequency = voice.from * ratio ** progress
    phase += (2 * Math.PI * frequency) / sampleRate
    let value = 0
    for (const [multiple, gain] of voice.partials) value += gain * Math.sin(phase * multiple)
    if (voice.noise) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      const white = seed / 0x3fffffff - 1
      lowpass += 0.3 * (white - lowpass)
      value += voice.noise * lowpass * Math.exp(-progress * 14)
    }
    let envelope = Math.exp(-voice.decay * progress)
    if (index < attack) envelope *= index / attack
    const tail = length - index
    if (tail < release) envelope *= 0.5 - 0.5 * Math.cos((Math.PI * tail) / release)
    out[index] = (voice.gain * volume * envelope * value) / normalise
  }
  return out
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
  const gap = Math.round((cue.gapMs * sampleRate) / 1000)
  for (const voice of cue.voices) {
    const rendered = renderVoice(voice, sampleRate, volume)
    samples.set(rendered, offset)
    offset += rendered.length + gap
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
