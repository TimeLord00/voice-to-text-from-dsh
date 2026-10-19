/**
 * WAV decoding, downmixing, resampling and canonical encoding.
 *
 * The recognizer only accepts one shape of audio: 16 kHz mono PCM16. Microphones and files come
 * in every other shape (48 kHz stereo, 11 kHz 8-bit, 24-bit, float), so everything funnels through
 * here first. Header fields are treated as hints: some drivers (notably the WinMM MCI mapper) write
 * a stale `byteRate`/`blockAlign` while the data itself is correct, so decoding is driven by
 * `sampleRate`/`channels`/`bitsPerSample` — or by explicit overrides from the recorder.
 */

/** Target format of every recording handed to the recognizer. */
export const TARGET_RATE = 16000

const FORMAT_PCM = 1
const FORMAT_IEEE_FLOAT = 3

/**
 * Split a RIFF/WAVE buffer into its format description and raw data window.
 * @param {Uint8Array|Buffer} bytes - complete file contents.
 * @param {{sampleRate?: number, channels?: number, bitsPerSample?: number, formatTag?: number}} [overrides]
 *   authoritative format values that replace the file header (used for MCI recordings).
 * @returns {{sampleRate: number, channels: number, bitsPerSample: number, formatTag: number,
 *   dataOffset: number, dataSize: number, declaredByteRate: number}}
 */
export function parseWav(bytes, overrides = {}) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file')
  }
  let fmt = null
  let dataOffset = -1
  let dataSize = 0
  let offset = 12
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && size >= 16 && body + 16 <= buf.length) {
      fmt = {
        formatTag: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        declaredByteRate: buf.readUInt32LE(body + 8),
        bitsPerSample: buf.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      dataOffset = body
      dataSize = Math.min(size, buf.length - body)
    }
    offset = body + size + (size % 2)
  }
  if (!fmt) throw new Error('WAV file has no fmt chunk')
  if (dataOffset < 0) throw new Error('WAV file has no data chunk')
  const format = {
    ...fmt,
    ...withoutUndefined(overrides),
  }
  if (!(format.channels >= 1) || !(format.sampleRate >= 8000)) throw new Error(`Unusable WAV format: ${JSON.stringify(format)}`)
  if (![8, 16, 24, 32].includes(format.bitsPerSample)) throw new Error(`Unsupported sample width: ${format.bitsPerSample}`)
  return { ...format, dataOffset, dataSize }
}

function withoutUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null))
}

/**
 * Decode interleaved samples to a mono Float32 signal in [-1, 1].
 * @param {Uint8Array|Buffer} bytes - complete file contents.
 * @param {object} [overrides] - authoritative format values, see {@link parseWav}.
 * @returns {{samples: Float32Array, sampleRate: number, channels: number, bitsPerSample: number, seconds: number}}
 */
export function decodeWav(bytes, overrides = {}) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const info = parseWav(buf, overrides)
  const { bitsPerSample, channels, sampleRate, formatTag, dataOffset, dataSize } = info
  const width = bitsPerSample / 8
  const frames = Math.floor(dataSize / (width * channels))
  const mono = new Float32Array(frames)
  const isFloat = formatTag === FORMAT_IEEE_FLOAT
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0
    for (let channel = 0; channel < channels; channel += 1) {
      const at = dataOffset + (frame * channels + channel) * width
      sum += readSample(buf, at, bitsPerSample, isFloat)
    }
    mono[frame] = sum / channels
  }
  return { samples: mono, sampleRate, channels, bitsPerSample, seconds: frames / sampleRate }
}

function readSample(buf, at, bits, isFloat) {
  if (isFloat) return bits === 32 ? buf.readFloatLE(at) : 0
  switch (bits) {
    case 8: return (buf.readUInt8(at) - 128) / 128
    case 16: return buf.readInt16LE(at) / 32768
    case 24: return ((buf.readUInt8(at) | (buf.readUInt8(at + 1) << 8) | (buf.readInt8(at + 2) << 16))) / 8388608
    case 32: return buf.readInt32LE(at) / 2147483648
    default: return 0
  }
}

/**
 * Resample a mono signal; integer downsample ratios average the source window (a box low-pass),
 * upsampling interpolates linearly.
 * @param {Float32Array} samples - mono input.
 * @param {number} fromRate - input sample rate.
 * @param {number} toRate - output sample rate.
 * @returns {Float32Array} resampled mono signal.
 */
export function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples
  const ratio = fromRate / toRate
  const length = Math.max(0, Math.floor(samples.length / ratio))
  const out = new Float32Array(length)
  if (fromRate > toRate) {
    for (let i = 0; i < length; i += 1) {
      const start = Math.floor(i * ratio)
      const end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * ratio)))
      let sum = 0
      for (let j = start; j < end; j += 1) sum += samples[j]
      out[i] = sum / (end - start)
    }
  } else {
    for (let i = 0; i < length; i += 1) {
      const position = i * ratio
      const left = Math.floor(position)
      const right = Math.min(samples.length - 1, left + 1)
      const weight = position - left
      out[i] = samples[left] * (1 - weight) + samples[right] * weight
    }
  }
  return out
}

/**
 * Wrap mono samples in the canonical 16 kHz mono PCM16 WAV container the recognizer demands.
 * @param {Float32Array} samples - mono signal in [-1, 1]; resampled here when needed.
 * @param {number} [sampleRate] - rate of `samples`; defaults to 16 kHz.
 * @returns {Buffer} complete WAV file bytes.
 */
export function encodeCanonical(samples, sampleRate = TARGET_RATE) {
  const mono = sampleRate === TARGET_RATE ? samples : resample(samples, sampleRate, TARGET_RATE)
  const frames = mono.length
  const out = Buffer.alloc(44 + frames * 2)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + frames * 2, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(FORMAT_PCM, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(TARGET_RATE, 24)
  out.writeUInt32LE(TARGET_RATE * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(frames * 2, 40)
  for (let i = 0; i < frames; i += 1) {
    const clamped = Math.max(-1, Math.min(1, mono[i]))
    out.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2)
  }
  return out
}

/**
 * Convert any decodable WAV into the canonical recording the recognizer accepts.
 * @param {Uint8Array|Buffer} bytes - source file contents.
 * @param {object} [overrides] - authoritative format values, see {@link parseWav}.
 * @returns {Buffer} canonical 16 kHz mono PCM16 WAV bytes.
 */
export function toCanonicalWav(bytes, overrides = {}) {
  const decoded = decodeWav(bytes, overrides)
  return encodeCanonical(decoded.samples, decoded.sampleRate)
}

/**
 * Read PCM16 little-endian samples back out of a canonical recording.
 * @param {Uint8Array|Buffer} bytes - canonical WAV bytes.
 * @returns {Float32Array} mono signal in [-1, 1].
 */
export function canonicalToFloat(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const frames = (buf.length - 44) / 2
  const samples = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) samples[i] = buf.readInt16LE(44 + i * 2) / 32768
  return samples
}

/**
 * Describe a recording for logs and diagnostics.
 * @param {Uint8Array|Buffer} bytes - canonical WAV bytes.
 * @returns {{seconds: number, kilobytes: number}} duration and size summary.
 */
export function describeCanonical(bytes) {
  const frames = Math.max(0, (bytes.length - 44) / 2)
  return { seconds: frames / TARGET_RATE, kilobytes: Math.round(bytes.length / 1024) }
}

/**
 * Measure whether a recording contains anything that stands out from its own noise floor.
 *
 * This exists because Silero's VAD accepts broadband room tone as speech, and the recognizer then
 * invents a sentence for it: a three-second recording of an empty room came back as
 * "小气自己写就自己写。" with nobody near the microphone (`vtt listen --seconds 3`, 2026-10-19). Silence is
 * not the only failure mode either — a quiet microphone produces the same steady noise — so the test is
 * relative to the recording itself rather than an absolute level.
 *
 * The signal is framed, the frames are ranked, and speech is declared when a *run* of consecutive frames
 * stays above the tenth-percentile frame level. A run, not a count, because stationary noise always has a
 * few frames above any threshold (measured here: room tone has 14 frames above +8 dB but they never
 * last longer than 80 ms), while a spoken syllable is a plateau.
 *
 * Two rules are applied. The first is the strict one; the second accepts speech that is very quiet but
 * long enough to be unmistakable. Measured on this machine (16 kHz mono, 20 ms frames, floor -49 dBFS):
 *
 *   recording                       peak      +6 dB     +10 dB    +12 dB    +16 dB
 *   room tone                       -29.4   140 ms     20 ms      0 ms      0 ms
 *   room tone + one click sample    -26.9   140 ms     20 ms      0 ms      0 ms
 *   quiet voice (peak -27.8)        -27.8   260 ms    100 ms     80 ms      0 ms
 *   normal voice (peak -22.7)       -22.7   340 ms    160 ms    140 ms    120 ms
 *
 * The room tone row is why the defaults are 10 dB / 4 frames: the strict rule rejects noise with a
 * four-fold margin and still accepts a voice 20 dB quieter than normal speech, which the previous
 * 16 dB / 5 frames version silently threw away. The relaxed rule (60% of the margin, three times the run:
 * 6 dB over 240 ms) catches speech quieter still, and the same room tone reaches only 7 frames there.
 * @param {Float32Array} samples - mono signal in [-1, 1] at any sample rate.
 * @param {{sampleRate?: number, frameMs?: number, marginDb?: number, minFrames?: number,
 *   relaxedMarginDb?: number, relaxedMinFrames?: number}} [options] framing and thresholds; `marginDb` 0
 *   disables the test (everything counts as speech). The relaxed rule defaults to 60% of the margin and
 *   three times the run.
 * @returns {{peakDbfs: number, floorDbfs: number, medianDbfs: number, p90Dbfs: number, frames: number,
 *   activeFrames: number, longestRunFrames: number, longestRunMs: number, relaxedRunFrames: number,
 *   relaxedRunMs: number, hasSpeech: boolean}} the measurement.
 */
export function speechActivity(samples, options = {}) {
  const {
    sampleRate = TARGET_RATE,
    frameMs = 20,
    marginDb = 10,
    minFrames = 4,
    relaxedMarginDb = marginDb * 0.6,
    relaxedMinFrames = minFrames * 3,
  } = options
  const frame = Math.max(1, Math.round((sampleRate * frameMs) / 1000))
  const levels = []
  let peak = 0
  for (let start = 0; start + frame <= samples.length; start += frame) {
    let energy = 0
    for (let index = start; index < start + frame; index += 1) {
      const value = samples[index]
      energy += value * value
      const magnitude = Math.abs(value)
      if (magnitude > peak) peak = magnitude
    }
    levels.push(Math.sqrt(energy / frame))
  }
  for (let index = levels.length * frame; index < samples.length; index += 1) {
    const magnitude = Math.abs(samples[index])
    if (magnitude > peak) peak = magnitude
  }
  const sorted = [...levels].sort((a, b) => a - b)
  const quantile = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
  const floor = quantile(0.1)
  // The absolute floor keeps digital silence and dither from counting as speech at any margin.
  const threshold = (db) => Math.max(floor * 10 ** (db / 20), 0.001)
  const countAbove = (value) => levels.filter((level) => level > value).length
  const longestRun = (value) => {
    let longest = 0
    let current = 0
    for (const level of levels) {
      if (level > value) {
        current += 1
        if (current > longest) longest = current
      } else current = 0
    }
    return longest
  }
  const toDbfs = (value) => (value > 0 ? 20 * Math.log10(value) : Number.NEGATIVE_INFINITY)
  const disabled = marginDb <= 0
  const longestRunFrames = disabled ? levels.length : longestRun(threshold(marginDb))
  const relaxedRunFrames = disabled ? levels.length : longestRun(threshold(relaxedMarginDb))
  const hasSpeech = disabled || (levels.length > 0
    ? longestRunFrames >= minFrames || (relaxedMinFrames > 0 && relaxedRunFrames >= relaxedMinFrames)
    : peak > 0.001)
  return {
    peakDbfs: toDbfs(peak),
    floorDbfs: toDbfs(floor),
    medianDbfs: toDbfs(quantile(0.5)),
    p90Dbfs: toDbfs(quantile(0.9)),
    frames: levels.length,
    activeFrames: disabled ? levels.length : countAbove(threshold(marginDb)),
    longestRunFrames,
    longestRunMs: longestRunFrames * frameMs,
    relaxedRunFrames,
    relaxedRunMs: relaxedRunFrames * frameMs,
    hasSpeech,
  }
}
