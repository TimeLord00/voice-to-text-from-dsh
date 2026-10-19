/**
 * Configuration, model discovery and release-pinned model metadata.
 *
 * The tool deliberately reuses whatever SenseVoice weights are already on the machine — a DSH
 * installation downloads exactly these three files — so a first run normally costs no bandwidth.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package root (…/voice-to-text). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Release-pinned assets, byte-identical to the ones the DSH voice-input plugin verifies. */
export const ASSETS = {
  models: {
    int8: {
      name: 'model.int8.onnx',
      bytes: 239233841,
      sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
      path: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.int8.onnx',
    },
    fp32: {
      name: 'model.onnx',
      bytes: 937617178,
      sha256: '977016bd9c79f9eb343430b5cc305e07ab64d5212dff41b0dcfa1694bee9a8cb',
      path: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.onnx',
    },
  },
  tokens: {
    name: 'tokens.txt',
    bytes: 315894,
    sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
    path: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/tokens.txt',
  },
  vad: {
    name: 'silero_vad.onnx',
    bytes: 1807522,
    sha256: 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28',
    path: 'csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/silero_vad.onnx',
  },
}

/** Download origins tried in order; `VTT_MODEL_ORIGIN` replaces the list with a single origin. */
export const MODEL_ORIGINS = process.env.VTT_MODEL_ORIGIN
  ? [process.env.VTT_MODEL_ORIGIN]
  : ['https://hf-mirror.com', 'https://huggingface.co']

/** Supported SenseVoice language hints. */
export const LANGUAGES = ['auto', 'zh', 'en', 'yue', 'ja', 'ko']

/** Built-in defaults; `config.json` and CLI flags override them. */
export const DEFAULTS = {
  /** Recognition language hint: auto | zh | en | yue | ja | ko. */
  language: 'zh',
  /** Weight precision: int8 (239 MB) or fp32 (938 MB). */
  precision: 'int8',
  /** Explicit paths; null means discover or download. */
  models: { modelDir: null, vadPath: null },
  /** CPU threads used by ONNX Runtime. */
  threads: 2,
  /** Longest single speech segment the VAD hands to the recognizer. */
  segmentSeconds: 30,
  vadThreshold: 0.5,
  minSpeechSeconds: 0.25,
  minSilenceSeconds: 0.5,
  vadOnsetPaddingSeconds: 0.3,
  /**
   * How far a 20 ms frame must rise above the recording's own noise floor (in dB) to count as speech.
   *
   * The recognizer answers steady room tone with an invented sentence, and the floating button pastes
   * whatever comes back, so a recording with nothing above this margin is reported as empty instead of
   * decoded. The default is measured on this machine (probe/gate-sweep.mjs): the noise floor drifts by 8 dB
   * between hours, and at its loud end room tone holds a 240 ms run at +10 dB while normal speech holds
   * 120 ms at +16 dB. 10 dB therefore decoded the empty room — "花要来长的时候可以用。" pasted into whatever
   * was focused — so the strict margin is 16 dB again, with the relaxed rule below as the quiet-speech path.
   * Lower this to 12 (or 0 to disable the test entirely) in a quiet room, or when a soft voice is refused.
   */
  speechMarginDb: 16,
  /**
   * Consecutive frames that must clear {@link speechMarginDb} before a recording is worth decoding
   * (4 frames = 80 ms). A run rather than a total, because stationary noise always has a few loud frames.
   * The relaxed rule is 6 dB less margin over 6x this run (10 dB over 480 ms), which catches a soft but
   * sustained sentence while still refusing the loudest room tone measured here.
   */
  minSpeechFrames: 4,
  /** Global hotkey that starts and stops dictation. */
  hotkey: 'ctrl+alt+space',
  /** Global hotkey that discards an in-flight recording. */
  cancelHotkey: 'ctrl+alt+escape',
  /** Recording stops automatically after this many seconds. */
  maxSeconds: 120,
  /** Recordings shorter than this are treated as an accidental press. */
  minSeconds: 0.6,
  /** Delay between writing the clipboard and injecting Ctrl+V. */
  pasteDelayMs: 120,
  /** Play the start/stop/result cues. They are synthesized here, not Windows sound-scheme entries. */
  beeps: true,
  /** Loudness of those cues, 0..1. Halved from 0.7 after the user reported them too loud. */
  beepVolume: 0.35,
  /**
   * Keep a copy of every recording in `recordings/`. Off by default: a dictation tool should not
   * leave the user's voice on disk unless asked. Turn it on when a result looks wrong.
   */
  keepRecordings: false,
  /** Local HTTP API port for other applications. */
  port: 8791,
  /** Optional bearer token required by the HTTP API; null accepts any loopback caller. */
  token: null,
  /** Seconds the model stays loaded after the last transcription. */
  idleTimeoutMs: 300000,
  /** Floating microphone button (`vtt overlay` and `vtt dictate --overlay`). */
  overlay: {
    /** Seconds between caret position checks. */
    followIntervalMs: 400,
    /** Gap in logical pixels between the caret and the edge of the button. */
    gap: 6,
    /** Button diameter in logical pixels, before display scaling. */
    size: 46,
    /** Move the button to wherever the text caret is; false parks it in the corner once. */
    follow: true,
    /**
     * Hide the button while the focused window shows no text caret, so it only appears where text can
     * be typed. It never hides before it has seen a caret once, never hides while a recording is
     * running, and a second launch of the shortcut always brings it back. Off by default: an icon that
     * disappears is worse than one that stays, and this is what made the button look lost in the field.
     */
    hideWithoutCaret: false,
    /** Milliseconds of "no caret any more" before the button hides. */
    caretGraceMs: 1200,
    /** Pixels of slack around the button inside which the pointer freezes every automatic move. */
    pointerFreezePx: 8,
    /** Pixels the pointer must travel with the button held down before the press counts as a drag. */
    dragThresholdPx: 6,
    /** Show a notification-area icon; it is the way to reach the button when it is hidden. */
    tray: true,
    /** Force a display scale factor (1 = 100%); null asks Windows. */
    scale: null,
    /** Show the button immediately on start. */
    startVisible: true,
  },
}

/** Locations searched for already-downloaded weights, most specific first. */
function modelCandidates() {
  const dsh = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
  const local = {
    modelDir: join(ROOT, 'models', 'sensevoice-onnx'),
    vadPath: join(ROOT, 'models', 'silero', 'silero_vad.onnx'),
  }
  const shared = {
    modelDir: join(dsh, 'speech-to-text', 'sensevoice', 'models', 'sensevoice-onnx'),
    vadPath: join(dsh, 'speech-to-text', 'sensevoice', 'models', 'silero', 'silero_vad.onnx'),
  }
  return {
    local,
    shared,
    modelDir: [process.env.VTT_MODEL_DIR, local.modelDir, shared.modelDir].filter(Boolean),
    vadPath: [process.env.VTT_VAD_PATH, local.vadPath, shared.vadPath].filter(Boolean),
  }
}

/**
 * Read `config.json` when present.
 * @returns {object} parsed user configuration, or an empty object.
 */
export function readConfigFile() {
  const path = join(ROOT, 'config.json')
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`config.json is not valid JSON: ${error.message}`)
  }
}

/**
 * Merge defaults, `config.json`, and explicit overrides.
 * @param {object} [overrides] - CLI flags; `undefined` values are ignored.
 * @returns {typeof DEFAULTS} effective configuration.
 */
export function loadConfig(overrides = {}) {
  const file = readConfigFile()
  const merged = { ...DEFAULTS, ...file, ...withoutUndefined(overrides), models: { ...DEFAULTS.models, ...file.models, ...withoutUndefined(overrides.models ?? {}) }, overlay: { ...DEFAULTS.overlay, ...file.overlay, ...withoutUndefined(overrides.overlay ?? {}) } }
  // The shortcut launchers cannot pass flags, so a troubleshooting switch needs an environment form.
  if (process.env.VTT_KEEP_RECORDINGS === '1') merged.keepRecordings = true
  if (!LANGUAGES.includes(merged.language)) throw new Error(`Unsupported language "${merged.language}"; expected one of ${LANGUAGES.join(', ')}`)
  if (!['int8', 'fp32'].includes(merged.precision)) throw new Error(`Unsupported precision "${merged.precision}"; expected int8 or fp32`)
  return merged
}

function withoutUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))
}

/**
 * Locate the three files the recognizer needs, checking explicit configuration first and then
 * every known cache of the same release.
 * @param {typeof DEFAULTS} config - effective configuration.
 * @returns {{model: string, tokens: string, vad: string, modelDir: string, source: string}|null}
 *   resolved paths, or null when any file is missing.
 */
export function resolveModels(config) {
  const candidates = modelCandidates()
  const modelName = ASSETS.models[config.precision].name
  const modelDirs = [...new Set([config.models.modelDir, ...candidates.modelDir].filter(Boolean))]
  for (const dir of modelDirs) {
    const model = join(dir, modelName)
    const tokens = join(dir, ASSETS.tokens.name)
    if (existsSync(model) && existsSync(tokens)) {
      const vad = [config.models.vadPath, ...candidates.vadPath].filter(Boolean).find((path) => existsSync(path))
      if (vad) return { model, tokens, vad, modelDir: dir, source: describeSource(dir) }
    }
  }
  return null
}

function describeSource(dir) {
  return dir.startsWith(ROOT) ? 'local models directory' : 'existing DSH speech-to-text cache'
}

/**
 * Report which of the three model files already exist, for diagnostics and downloads.
 * @param {typeof DEFAULTS} config - effective configuration.
 * @returns {{model: string, tokens: string, vad: string, modelRoot: string, vadRoot: string, present: object, missing: string[]}}
 */
export function modelPlan(config) {
  const candidates = modelCandidates()
  // Download into the shared DSH cache only when it already holds weights: a machine that never ran
  // the DSH plugin should not get a ~/.dsh tree created just to store three files.
  const fallback = existsSync(candidates.shared.modelDir) ? candidates.shared : candidates.local
  const resolved = resolveModels(config)
  const modelRoot = config.models.modelDir ?? resolved?.modelDir ?? fallback.modelDir
  const vadPath = config.models.vadPath
    ?? resolved?.vad
    ?? (existsSync(candidates.shared.vadPath) ? candidates.shared.vadPath : candidates.local.vadPath)
  const paths = {
    model: join(modelRoot, ASSETS.models[config.precision].name),
    tokens: join(modelRoot, ASSETS.tokens.name),
    vad: vadPath,
  }
  const present = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, existsSync(path)]))
  return { ...paths, modelRoot, vadRoot: dirname(vadPath), present, missing: Object.keys(present).filter((key) => !present[key]) }
}

/**
 * Build the download URL for a pinned asset.
 * @param {{path: string}} asset - entry from {@link ASSETS}.
 * @param {string} origin - origin such as `https://hf-mirror.com`.
 * @returns {string} absolute URL.
 */
export function assetUrl(asset, origin) {
  return `${origin.replace(/\/$/, '')}/${asset.path}`
}
