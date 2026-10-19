/**
 * Thin Win32 layer: microphone capture through the WinMM MCI mapper, global hotkeys, clipboard and
 * synthetic key input.
 *
 * All of it runs in-process through koffi, deliberately: the harness constrains what a spawned
 * child process may do with its stdio, so a helper-process design (ffmpeg, PowerShell, ...) would
 * be both slower and less portable. Everything here is plain Win32, available since Windows 2000.
 *
 * Microphone notes: `open new type waveaudio` goes through the MCI waveaudio mapper, which on this
 * machine accepts exactly one format — 48 kHz, 16-bit, stereo. Any other sample rate or channel
 * count fails with MCI error 282 (MCIERR_OUTOFRANGE), and the implicit default is 11 kHz 8-bit
 * mono, which sounds terrible. So the recorder always asks for 48 kHz/16/stereo and resamples
 * afterwards. The mapper also writes a stale `byteRate`/`blockAlign` into the saved header while
 * the data itself is correct, which is why the file's true format is read back with `status`
 * instead of being trusted from the header.
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import koffi from 'koffi'
import { CUE_KINDS, DEFAULT_CUE_VOLUME, SAMPLE_RATE, cueSamples, encodePcm16Wav, renderCue } from './sound.mjs'

/** MCI recording format: the only one the waveaudio mapper accepts here. */
export const MIC_FORMAT = { sampleRate: 48000, channels: 2, bitsPerSample: 16 }

const GMEM_MOVEABLE = 0x0002
const CF_UNICODETEXT = 13
const KEYEVENTF_KEYUP = 0x0002
const PM_REMOVE = 0x0001
const WM_HOTKEY = 0x0312
/** PlaySound flags: our cue lives in memory and must never fall back to a sound-scheme entry. */
const SND_NODEFAULT = 0x0002
const SND_MEMORY = 0x0004
/** Rendered cue images, keyed by `kind@volume`: rendering per click would be wasted work. */
const cueCache = new Map()
/**
 * How long the output device is trusted to stay awake. An audio endpoint that has been idle goes into
 * power save; the first 100-300 ms written to it are then played into a device that is still waking up,
 * and a 130-330 ms cue can disappear entirely — which is what "sometimes there is a sound, sometimes
 * there is not" looks like from the outside. Measured on this machine: every PlaySound call returns 1 in
 * every state (idle, while the recorder runs, right after it closes), so a refusal is not the cause of
 * that report; the wake-up is.
 */
const CUE_WAKE_MS = 6000
/** Length of the silent pre-roll that absorbs the wake-up. */
const CUE_WAKE_TAIL_MS = 60
/** @type {Buffer|null} 60 ms of silence, played before a cue after a long quiet stretch. */
let wakeBuffer = null
/** @type {{at: number, error: string|null}} what the cue path last did, for diagnostics. */
const cueState = { at: 0, error: null }
const MOD_ALT = 0x0001
const MOD_CONTROL = 0x0002
const MOD_SHIFT = 0x0004
const MOD_WIN = 0x0008
const MOD_NOREPEAT = 0x4000

const VK = {
  backspace: 0x08, tab: 0x09, enter: 0x0d, return: 0x0d, escape: 0x1b, esc: 0x1b, space: 0x20,
  pageup: 0x21, pgup: 0x21, pagedown: 0x22, pgdn: 0x22, end: 0x23, home: 0x24,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28, insert: 0x2d, ins: 0x2d, delete: 0x2e, del: 0x2e,
  '`': 0xc0, '-': 0xbd, '=': 0xbb, '[': 0xdb, ']': 0xdd, '\\': 0xdc, ';': 0xba, "'": 0xde,
  ',': 0xbc, '.': 0xbe, '/': 0xbf,
}
for (let i = 1; i <= 24; i += 1) VK[`f${i}`] = 0x6f + i

/** @type {object|null} lazily loaded native bindings. */
let libs = null

function native() {
  if (libs) return libs
  const winmm = koffi.load('winmm.dll')
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  libs = {
    koffi,
    mciSendStringW: winmm.func('unsigned int mciSendStringW(const char16_t *command, _Out_ char16_t *result, unsigned int resultLength, void *callback)'),
    mciGetErrorStringW: winmm.func('int mciGetErrorStringW(unsigned int error, _Out_ char16_t *buffer, unsigned int length)'),
    PlaySoundW: winmm.func('int PlaySoundW(void *sound, void *module, unsigned int flags)'),
    RegisterHotKey: user32.func('int RegisterHotKey(void *window, int id, unsigned int modifiers, unsigned int key)'),
    UnregisterHotKey: user32.func('int UnregisterHotKey(void *window, int id)'),
    PeekMessageW: user32.func('int PeekMessageW(_Out_ void *message, void *window, unsigned int filterMin, unsigned int filterMax, unsigned int remove)'),
    OpenClipboard: user32.func('int OpenClipboard(void *owner)'),
    EmptyClipboard: user32.func('int EmptyClipboard()'),
    CloseClipboard: user32.func('int CloseClipboard()'),
    SetClipboardData: user32.func('void *SetClipboardData(unsigned int format, void *memory)'),
    GetClipboardData: user32.func('void *GetClipboardData(unsigned int format)'),
    IsClipboardFormatAvailable: user32.func('int IsClipboardFormatAvailable(unsigned int format)'),
    GetForegroundWindow: user32.func('void *GetForegroundWindow()'),
    GetWindowTextW: user32.func('int GetWindowTextW(void *window, _Out_ char16_t *text, int maxCount)'),
    keybd_event: user32.func('void keybd_event(unsigned char key, unsigned char scan, unsigned int flags, size_t extra)'),
    MessageBeep: user32.func('int MessageBeep(unsigned int type)'),
    GlobalAlloc: kernel32.func('void *GlobalAlloc(unsigned int flags, size_t bytes)'),
    GlobalLock: kernel32.func('void *GlobalLock(void *memory)'),
    GlobalUnlock: kernel32.func('int GlobalUnlock(void *memory)'),
    GetShortPathNameW: kernel32.func('unsigned int GetShortPathNameW(const char16_t *longPath, _Out_ char16_t *shortPath, unsigned int bufferLength)'),
  }
  return libs
}

/**
 * Send one MCI command string.
 * @param {string} command - MCI command, e.g. `record vttrec`.
 * @returns {{rc: number, text: string}} return code and the command's textual answer.
 */
export function mci(command) {
  const { mciSendStringW, koffi: k } = native()
  const buffer = Buffer.alloc(512 * 2)
  const rc = mciSendStringW(command, buffer, 256, null)
  const text = rc === 0 ? k.decode.string16(buffer).trim() : mciError(rc)
  return { rc, text }
}

/**
 * Turn an MCI return code into its official message.
 * @param {number} code - return code from {@link mci}.
 * @returns {string} human-readable error text.
 */
export function mciError(code) {
  const { mciGetErrorStringW, koffi: k } = native()
  const buffer = Buffer.alloc(512 * 2)
  const ok = mciGetErrorStringW(code, buffer, 256)
  const text = ok ? k.decode.string16(buffer).trim() : ''
  return text || `MCI error ${code}`
}

/**
 * Run an MCI command and throw when it fails.
 * @param {string} command - MCI command.
 * @returns {string} the command's textual answer.
 */
function mciOrThrow(command) {
  const { rc, text } = mci(command)
  if (rc !== 0) throw new Error(`Microphone command failed (${command}): ${text}`)
  return text
}

/**
 * Microphone recorder built on the WinMM waveaudio mapper.
 *
 * Usage: {@link open} once, then {@link start}/{@link stop} per recording. The mapper keeps one
 * device open, so a recorder is reused for the whole life of the process.
 */
export class Microphone {
  /**
   * @param {string} [alias] - MCI device alias; distinct aliases allow several recorders.
   */
  constructor(alias = 'vttrec') {
    this.alias = alias
    this.opened = false
    this.recording = false
    this.format = { ...MIC_FORMAT }
    this.startedAt = 0
  }

  /**
   * Open the waveaudio device and select the 48 kHz/16-bit/stereo capture format.
   * @returns {Microphone} this instance.
   */
  open() {
    if (this.opened) return this
    const format = `bitspersample ${MIC_FORMAT.bitsPerSample} channels ${MIC_FORMAT.channels} samplespersec ${MIC_FORMAT.sampleRate}`
    try {
      mciOrThrow(`open new type waveaudio alias ${this.alias}`)
      this.opened = true
      mciOrThrow(`set ${this.alias} time format ms`)
      mciOrThrow(`set ${this.alias} ${format}`)
      this.format = {
        sampleRate: readStatusNumber(this.alias, 'samplespersec', MIC_FORMAT.sampleRate),
        channels: readStatusNumber(this.alias, 'channels', MIC_FORMAT.channels),
        bitsPerSample: readStatusNumber(this.alias, 'bitspersample', MIC_FORMAT.bitsPerSample),
      }
    } catch (error) {
      this.close()
      throw new Error(`${error.message}\nNo capture device or the waveaudio mapper rejected the format. `
        + 'Check that a microphone is connected and that Windows grants this app microphone access '
        + '(Settings -> Privacy & security -> Microphone).')
    }
    return this
  }

  /** @returns {boolean} whether a capture device is currently open. */
  get ready() {
    return this.opened
  }

  /**
   * Start capturing.
   * @returns {Microphone} this instance.
   */
  start() {
    this.open()
    if (this.recording) return this
    mciOrThrow(`record ${this.alias}`)
    this.recording = true
    this.startedAt = Date.now()
    return this
  }

  /** @returns {number} seconds captured since {@link start}. */
  get elapsedSeconds() {
    return this.recording ? (Date.now() - this.startedAt) / 1000 : 0
  }

  /**
   * Stop capturing.
   * @returns {number} seconds of audio captured.
   */
  stop() {
    if (!this.recording) return 0
    const seconds = this.elapsedSeconds
    this.recording = false
    mciOrThrow(`stop ${this.alias}`)
    return seconds
  }

  /**
   * Stop capturing and write the recording to a file.
   * The saved header carries the mapper's stale `byteRate`; `toCanonicalWav` fixes that up from the
   * `format` returned here. The device is closed afterwards so the next recording starts clean.
   * @param {string} path - destination WAV path.
   * @returns {{path: string, seconds: number, format: {sampleRate: number, channels: number, bitsPerSample: number}}} recording summary.
   */
  save(path) {
    const seconds = this.stop()
    if (existsSync(path)) unlinkSync(path)
    const format = { ...this.format }
    try {
      mciOrThrow(`save ${this.alias} "${path}"`)
    } catch (error) {
      // MCI opens files itself and some drivers still insist on 8.3 names for long or spaced paths.
      const short = shortPath(path)
      if (!short || short === path) throw error
      mciOrThrow(`save ${this.alias} "${short}"`)
    } finally {
      this.close()
    }
    return { path, seconds, format }
  }

  /**
   * Stop capturing and drop the captured audio.
   * @returns {Microphone} this instance.
   */
  discard() {
    if (this.recording) {
      this.recording = false
      mci(`stop ${this.alias}`)
    }
    this.close()
    return this
  }

  /** Close the device; safe to call repeatedly. */
  close() {
    if (this.opened) {
      mci(`close ${this.alias}`)
      this.opened = false
      this.recording = false
    }
  }
}

/**
 * Read one numeric `status` field, falling back to a default when the mapper refuses it.
 * @param {string} alias - MCI alias.
 * @param {string} field - status field name.
 * @param {number} fallback - value used when the query fails.
 * @returns {number} the value.
 */
function readStatusNumber(alias, field, fallback) {
  const { rc, text } = mci(`status ${alias} ${field}`)
  const value = Number.parseInt(text, 10)
  return rc === 0 && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Resolve an 8.3 form of a path, as some MCI drivers require.
 * @param {string} path - long path.
 * @returns {string|null} short path, or null when it cannot be resolved.
 */
export function shortPath(path) {
  const { GetShortPathNameW, koffi: k } = native()
  const length = GetShortPathNameW(path, null, 0)
  if (!length) return null
  const buffer = Buffer.alloc((length + 1) * 2)
  if (!GetShortPathNameW(path, buffer, length + 1)) return null
  return k.decode.string16(buffer)
}

/**
 * A private per-process temporary WAV path used for microphone dumps.
 * @returns {string} absolute path.
 */
export function tempRecordingPath() {
  return join(tmpdir(), `vtt-${process.pid}-${Date.now()}.wav`)
}

/**
 * Convert a hotkey description into Win32 registration values.
 * @param {string} description - e.g. `ctrl+alt+space`, `win+shift+f9`.
 * @returns {{modifiers: number, key: number, canonical: string}} registration values.
 */
export function parseHotkey(description) {
  const parts = String(description).toLowerCase().split('+').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) throw new Error(`Hotkey "${description}" is empty`)
  let modifiers = 0
  let key = 0
  const names = []
  for (const part of parts) {
    if (['ctrl', 'control'].includes(part)) { modifiers |= MOD_CONTROL; names.push('ctrl') } else if (part === 'alt') { modifiers |= MOD_ALT; names.push('alt') } else if (part === 'shift') { modifiers |= MOD_SHIFT; names.push('shift') } else if (['win', 'meta', 'super', 'cmd'].includes(part)) { modifiers |= MOD_WIN; names.push('win') } else {
      if (key !== 0) throw new Error(`Hotkey "${description}" names more than one key`)
      key = resolveKey(part, description)
      names.push(part)
    }
  }
  if (key === 0) throw new Error(`Hotkey "${description}" has no key besides modifiers`)
  return { modifiers: modifiers | MOD_NOREPEAT, key, canonical: names.join('+') }
}

/**
 * Map one key name to a virtual-key code.
 * @param {string} name - key name such as `space`, `f9`, `a`.
 * @param {string} description - whole hotkey, for error messages.
 * @returns {number} virtual-key code.
 */
function resolveKey(name, description) {
  if (Object.hasOwn(VK, name)) return VK[name]
  if (/^[a-z]$/.test(name)) return name.toUpperCase().charCodeAt(0)
  if (/^[0-9]$/.test(name)) return 0x30 + Number(name)
  throw new Error(`Unknown key "${name}" in hotkey "${description}"`)
}

/**
 * Global hotkey listener driven by a polling message pump.
 *
 * RegisterHotKey posts WM_HOTKEY to the calling thread's queue; because Node owns the thread and
 * never pumps messages on its own, {@link start} polls with PeekMessage from a timer. 25 ms of poll
 * latency is far below human perception and costs nothing while idle.
 *
 * While the pump runs, it keeps the process alive: a dictation session that owns hotkeys has pending
 * work, and the caller only gets its event loop back after {@link dispose}.
 *
 * This is the thread's only message pump, so the floating button in src/overlay.mjs feeds its mouse
 * messages through {@link dispatch} rather than installing a competing loop.
 */
export class Hotkeys {
  /**
   * @param {number} [pollMs] - message poll interval.
   */
  constructor(pollMs = 25) {
    this.pollMs = pollMs
    this.registered = new Map()
    this.timer = null
    this.handlers = new Map()
    this.sequence = 0
    this.message = Buffer.alloc(64)
    /** @type {((message: Buffer) => void)|null} optional consumer for messages that are not hotkeys. */
    this.dispatch = null
  }

  /**
   * Register one hotkey.
   * @param {string} description - hotkey text such as `ctrl+alt+d`.
   * @param {() => void} handler - callback invoked on each press.
   * @returns {{id: number, canonical: string}} registration details.
   */
  register(description, handler) {
    const { modifiers, key, canonical } = parseHotkey(description)
    const id = ++this.sequence
    const ok = native().RegisterHotKey(null, id, modifiers, key)
    if (!ok) {
      throw new Error(`Cannot register the global hotkey ${canonical}: another application already owns it. `
        + 'Pass a different one, for example --hotkey ctrl+alt+d')
    }
    this.registered.set(id, canonical)
    this.handlers.set(id, handler)
    return { id, canonical }
  }

  /** Start pumping messages; idempotent. */
  start() {
    if (this.timer) return this
    const { PeekMessageW } = native()
    this.timer = setInterval(() => {
      while (PeekMessageW(this.message, null, 0, 0, PM_REMOVE)) {
        // The MSG struct on x64 is hwnd(0) message(8) wParam(16) lParam(24): the *message* id is what
        // says whether this is a hotkey, and wParam is what says which one.
        const message = Number(koffi.decode(this.message, 8, 'uint32'))
        if (message !== WM_HOTKEY) {
          try {
            this.dispatch?.(this.message)
          } catch (error) {
            process.stderr.write(`window message failed: ${error?.stack ?? error}\n`)
          }
          continue
        }
        const id = Number(koffi.decode(this.message, 16, 'uint64'))
        if (id === 0) continue
        const handler = this.handlers.get(id)
        if (handler) {
          try {
            handler()
          } catch (error) {
            process.stderr.write(`hotkey handler failed: ${error?.stack ?? error}\n`)
          }
        }
      }
    }, this.pollMs)
    // This timer is deliberately left referenced: a registered global hotkey is pending work, so
    // while the pump runs the process has to stay alive. Unref'ing it made `vtt dictate` print its
    // banner and exit immediately — the awaited promise in the CLI does not hold the event loop open.
    return this
  }

  /**
   * Release every hotkey and stop pumping.
   * @returns {Hotkeys} this instance.
   */
  dispose() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    for (const id of this.registered.keys()) native().UnregisterHotKey(null, id)
    this.registered.clear()
    this.handlers.clear()
    return this
  }

  /** @returns {string[]} canonical names of the registered hotkeys. */
  get names() {
    return [...this.registered.values()]
  }
}

/**
 * Replace the clipboard contents with the given text.
 * @param {string} text - text to place on the clipboard.
 * @returns {boolean} whether the clipboard accepted it.
 */
export function copyText(text) {
  const { koffi: k, OpenClipboard, EmptyClipboard, CloseClipboard, SetClipboardData, GlobalAlloc, GlobalLock, GlobalUnlock } = native()
  if (!OpenClipboard(null)) return false
  try {
    EmptyClipboard()
    const handle = GlobalAlloc(GMEM_MOVEABLE, (text.length + 1) * 2)
    if (!handle) return false
    const pointer = GlobalLock(handle)
    if (!pointer) return false
    const view = new Uint16Array(k.view(pointer, (text.length + 1) * 2))
    for (let i = 0; i < text.length; i += 1) view[i] = text.charCodeAt(i)
    view[text.length] = 0
    GlobalUnlock(handle)
    if (!SetClipboardData(CF_UNICODETEXT, handle)) return false
    return true
  } finally {
    CloseClipboard()
  }
}

/**
 * Read the clipboard as text.
 * @returns {string|null} clipboard text, or null when it holds no text.
 */
export function readClipboardText() {
  const { koffi: k, OpenClipboard, GetClipboardData, GlobalLock, GlobalUnlock, IsClipboardFormatAvailable, CloseClipboard } = native()
  if (!IsClipboardFormatAvailable(CF_UNICODETEXT)) return null
  if (!OpenClipboard(null)) return null
  try {
    const handle = GetClipboardData(CF_UNICODETEXT)
    if (!handle) return null
    const pointer = GlobalLock(handle)
    if (!pointer) return null
    const text = k.decode.string16(pointer)
    GlobalUnlock(handle)
    return text
  } finally {
    CloseClipboard()
  }
}

/**
 * Inject Ctrl+V into whatever window currently has focus.
 *
 * Elevation matters: Windows blocks synthetic input from a lower integrity level, so an elevated
 * target window ignores the paste. The text stays on the clipboard, so the user can paste by hand.
 * @returns {boolean} whether the keystrokes were sent.
 */
export function sendPaste() {
  try {
    const { keybd_event } = native()
    keybd_event(0x11, 0, 0, 0)
    keybd_event(0x56, 0, 0, 0)
    keybd_event(0x56, 0, KEYEVENTF_KEYUP, 0)
    keybd_event(0x11, 0, KEYEVENTF_KEYUP, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Describe the window that currently has focus, for diagnostics.
 * @returns {string} window title, or an empty string.
 */
export function foregroundWindowTitle() {
  const { koffi: k, GetForegroundWindow, GetWindowTextW } = native()
  const window = GetForegroundWindow()
  if (!window) return ''
  const buffer = Buffer.alloc(512 * 2)
  const length = GetWindowTextW(window, buffer, 512)
  return length > 0 ? k.decode.string16(buffer) : ''
}

/**
 * The silent buffer played at start-up. Silence costs nothing audibly and the device leaves power save
 * while it is being played, so the first cue of a session is not the one that pays for the wake-up.
 * @returns {Buffer} WAV bytes of {@link CUE_WAKE_TAIL_MS} milliseconds of silence.
 */
function wakeupBuffer() {
  if (!wakeBuffer) {
    wakeBuffer = encodePcm16Wav(new Float32Array(Math.round((CUE_WAKE_TAIL_MS * SAMPLE_RATE) / 1000)), SAMPLE_RATE)
  }
  return wakeBuffer
}

/**
 * The same cue with silence in front of it, for the first cue after an idle stretch: one buffer means one
 * open of the output device, which is worth about 90 ms of blocking compared with playing two buffers.
 * @param {string} kind - cue name.
 * @param {number} volume - 0..1 peak scale.
 * @returns {Buffer} WAV bytes: {@link CUE_WAKE_TAIL_MS} ms of silence followed by the cue.
 */
function cueWithLead(kind, volume) {
  const samples = cueSamples(kind, { volume })
  const lead = Math.round((CUE_WAKE_TAIL_MS * SAMPLE_RATE) / 1000)
  const padded = new Float32Array(lead + samples.length)
  padded.set(samples, lead)
  return encodePcm16Wav(padded, SAMPLE_RATE)
}

/**
 * Bring the output device out of power save without making a sound. Called once at start-up so that the
 * very first start cue is not the one that pays for waking the endpoint up.
 * @returns {boolean} whether the device accepted the buffer.
 */
export function warmUpAudio() {
  try {
    return native().PlaySoundW(wakeupBuffer(), null, SND_MEMORY | SND_NODEFAULT) !== 0
  } catch {
    return false
  }
}

/**
 * Play one of the synthesized dictation cues (see src/sound.mjs).
 *
 * **Blocking, deliberately** (no `SND_ASYNC`). Measured on this machine: an asynchronous PlaySound that
 * is still playing when the MCI mapper opens the capture device makes `mciSendStringW('record')` never
 * return — the whole process freezes with no error, no log line and no way to recover, and it reproduced
 * on the very first try (`vtt listen` played its start cue, printed "recording", then hung forever).
 * `probe/cue-capture-probe.mjs` walks one playback technique per mode through a real recording; every
 * asynchronous variant deadlocks, every blocking variant completes, whether the cue precedes the
 * recorder or plays while it is already running. A cue is 130-330 ms, so blocking costs at most that.
 *
 * After {@link CUE_WAKE_MS} of silence the endpoint is assumed to be in power save, so a silent pre-roll
 * is played first and the cue gets a live device. A refusal is retried once before giving up, because a
 * device that is still waking up can reject the very first buffer.
 * @param {'start'|'stop'|'done'|'error'} kind - which cue to play.
 * @param {number} [volume] - 0..1 peak scale, default {@link DEFAULT_CUE_VOLUME}.
 * @returns {boolean} whether the audio device accepted the buffer.
 */
export function playCue(kind, volume = DEFAULT_CUE_VOLUME) {
  if (!CUE_KINDS.includes(kind)) return false
  const key = `${kind}@${volume}`
  const idle = Date.now() - cueState.at
  const wake = cueState.at === 0 || idle > CUE_WAKE_MS
  const cacheKey = wake ? `lead:${key}` : key
  let wav = cueCache.get(cacheKey)
  if (!wav) {
    wav = wake ? cueWithLead(kind, volume) : renderCue(kind, { volume })
    cueCache.set(cacheKey, wav)
  }
  try {
    const play = native().PlaySoundW
    cueState.woke = wake
    let ok = play(wav, null, SND_MEMORY | SND_NODEFAULT) !== 0
    if (!ok) ok = play(wav, null, SND_MEMORY | SND_NODEFAULT) !== 0
    cueState.error = ok ? null : 'the audio device refused the cue'
    if (ok) cueState.at = Date.now()
    return ok
  } catch (error) {
    cueState.error = error?.message ?? String(error)
    return false
  }
}

/**
 * What the cue path last did. Diagnostics only: the dictation log uses it to tell "the device refused
 * the sound" apart from "the sound played but nobody heard it".
 * @returns {{at: number, woke: boolean, error: string|null}} `at` is when a cue last played, `woke` is
 *   whether the last call needed the wake-up pre-roll, `error` is the last refusal.
 */
export function cueStatus() {
  return { at: cueState.at, woke: Boolean(cueState.woke), error: cueState.error }
}

/**
 * Play the short sound that tells the user what dictation is doing. Beeps are the only feedback channel
 * a tool with no window of its own has while the user looks at another application, which is exactly
 * when dictation happens.
 *
 * These are our own synthesized cues rather than Windows sound-scheme entries, because the scheme sounds
 * are configurable, generic and (with `MessageBeep`) impossible to tell apart from any other program's.
 * When the device refuses the buffer — a muted output, no audio endpoint at all — the system sound is
 * used instead so feedback is never silently lost; note that the system sound is *also* silent when the
 * matching scheme entry is set to (None), which is why the return value is reported to the caller.
 * @param {'start'|'stop'|'done'|'error'} kind - which sound to play.
 * @param {number} [volume] - 0..1, see {@link playCue}.
 * @returns {boolean} `true` when our own cue played, `false` when it fell back to the system sound.
 */
export function beep(kind, volume = DEFAULT_CUE_VOLUME) {
  if (kind !== 'off' && playCue(kind, volume)) return true
  const types = { start: 0x40, stop: 0x30, done: 0x40, error: 0x10 }
  try {
    native().MessageBeep(types[kind] ?? 0x40)
  } catch {
    // Feedback is best-effort: a missing sound scheme must never break dictation.
  }
  return false
}

