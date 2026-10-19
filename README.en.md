# voice-to-text (vtt)

Local speech-to-text for Windows as a standalone tool: **talk anywhere, the text lands at your caret.**

Two front ends over the same recognition session:

- **Floating microphone button** (`vtt overlay`) — a small always-on-top mic icon that follows the **text caret**. Click to talk, click again and the text is pasted where the caret was. No console window, no command line.
- **Global hotkey** (`vtt dictate`) — `ctrl+alt+space` starts and stops a recording, then copies + pastes it.

Plus `vtt listen` (one-shot), `vtt transcribe file.wav` (batch) and `vtt serve` (local HTTP API, including an OpenAI-compatible `POST /v1/audio/transcriptions`).

Recognition is **fully local**: SenseVoiceSmall (ONNX int8) + Silero VAD through sherpa-onnx on the CPU. No audio leaves the machine, no account, no network once the model is in place.

> 中文说明（更详细，含设计与排查）见 [README.md](README.md).

---

## Requirements

- Windows 10/11 x64
- Node.js 20 or newer (developed on 24.19)
- A microphone. No administrator rights needed.

## Install

```powershell
git clone <this repo> voice-to-text
cd voice-to-text
.\install.ps1
```

`install.ps1` checks Node, installs the two native dependencies, runs the self-test and creates two shortcuts (`Voice to Text (floating button).lnk`, `Voice to Text (dictate).lnk`).

Manual equivalent:

```powershell
npm install --cache .\.npm-cache --ignore-scripts
node .\bin\vtt.mjs doctor
```

`--cache` / `--ignore-scripts` suit restricted environments; a plain `npm install` works too. Both dependencies ship prebuilt Windows x64 binaries, so nothing is compiled.

**Models**: by default the tool reuses the cache the DSH voice-input plugin already downloaded (`%USERPROFILE%\.dsh\speech-to-text\sensevoice\models`) and downloads nothing. On a machine without it, run `node .\bin\vtt.mjs models --fetch` (~241 MB, SHA-256 pinned, tries hf-mirror.com then huggingface.co).

## Quick start

```powershell
# 1) the floating button, no console window
.\start-overlay.vbs

# 2) hotkey only (ctrl+alt+space), runs in the console
node .\bin\vtt.mjs dictate

# 3) one recording from the terminal, text printed (and copied)
node .\bin\vtt.mjs listen --seconds 6

# 4) an existing WAV file
node .\bin\vtt.mjs transcribe .\foo.wav --json

# 5) local HTTP API (and an OpenAI-compatible endpoint)
node .\bin\vtt.mjs serve --dictate
```

## The floating button

- It sits next to the **text caret** of the focused window (centred on the caret line, flips to the left near the screen edge, always clamped on screen, falls back to the pointer when the window publishes no caret).
- **Click = start / stop.** It turns red while recording; on stop the audio is transcribed and pasted into the window that had focus. Focus is never stolen — the window is `WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE` with `MA_NOACTIVATE`, which is what makes "paste at the caret" possible at all.
- **It never chases the pointer.** Inside a dead zone around the button (`overlay.pointerFreezePx`, default 8 logical px) nothing moves, so the button can always be clicked.
- **Drag to park it.** A press that travels ≥ `overlay.dragThresholdPx` (6 px) moves the button instead of toggling; dragging never starts a recording. A parked button stops following the caret until you drag it again or press the hotkey.
- **Right-click cancels** the current recording, **middle-click hides** the button, and the **tray icon** has a menu (start/stop, cancel, hide/show, quit).
- It does **not** hide on its own. `"overlay": { "hideWithoutCaret": true }` restores the old auto-hide behaviour.
- Starting it twice is safe: the second launch asks the running button to show itself again (logged in `overlay.log`). `node .\bin\vtt.mjs overlay --stop` closes it.

## Commands

| command | what it does |
| --- | --- |
| `vtt overlay [--stop]` | floating microphone button (tray icon included) |
| `vtt dictate` | resident hotkey dictation (`ctrl+alt+space` / `ctrl+alt+escape`) |
| `vtt listen [--seconds N]` | record once, transcribe, print + deliver |
| `vtt transcribe <file.wav>` | transcribe an existing WAV (`--json`, `--language`) |
| `vtt serve [--dictate]` | local HTTP API on 127.0.0.1:8791 |
| `vtt record [--seconds N]` | save a canonical 16 kHz mono WAV, no recognition |
| `vtt models [--fetch]` | where the models are / download + verify them |
| `vtt doctor` | self-test: platform, models, recognizer, microphone, clipboard, hotkeys |
| `vtt config [--init]` | show (or write) the effective configuration |

Common flags: `--language zh|en|yue|ja|ko|auto`, `--no-paste` (clipboard only), `--hotkey`, `--cancel-hotkey`, `--max-seconds`, `--threads`, `--json`. Exit codes: `0` ok, `1` error, `3` nothing recognized, `4` models missing, `5` doctor found problems.

## Configuration

`vtt config --init` writes `config.json` next to the project with all defaults; it is merged over the defaults on every run (it is git-ignored).

```json
{
  "language": "zh",
  "precision": "int8",
  "threads": 2,
  "hotkey": "ctrl+alt+space",
  "cancelHotkey": "ctrl+alt+escape",
  "maxSeconds": 120,
  "minSeconds": 0.6,
  "pasteDelayMs": 120,
  "beeps": true,
  "beepVolume": 0.7,
  "speechMarginDb": 16,
  "minSpeechFrames": 4,
  "keepRecordings": false,
  "overlay": {
    "size": 46,
    "gap": 6,
    "follow": true,
    "tray": true,
    "pointerFreezePx": 8,
    "dragThresholdPx": 6,
    "hideWithoutCaret": false,
    "followIntervalMs": 400
  }
}
```

## Privacy

- Every recording is written to a temporary file, converted to 16 kHz mono, transcribed and **deleted immediately**. `recordings/` does not exist unless you ask for it.
- `keepRecordings` (or `--keep-recordings`, or `VTT_KEEP_RECORDINGS=1`) keeps a copy for troubleshooting. It is announced loudly in the banner and on every run, because it means your voice stays on disk.
- Nothing is uploaded anywhere; the HTTP API binds `127.0.0.1` only and supports an optional bearer token.

## Silence safety (why it does not type nonsense)

SenseVoice happily invents fluent sentences out of room tone — measured here: 3 seconds of an empty room decoded to a full Chinese sentence. Before every transcription the tool measures 20 ms frame levels and refuses to call the model unless `minSpeechFrames` consecutive frames (4 = 80 ms) rise `speechMarginDb` (16 dB) above that recording's own noise floor, returning `reason: "no-speech-activity"` with the measured `level ... dBFS` and the run it found. A relaxed second rule (480 ms at 10 dB) catches a soft but sustained sentence. The test is relative to the recording, so quiet-but-real speech survives; the defaults come from measurements taken on this machine with `probe/gate-sweep.mjs` (`--synth` and `--cue`), and the noise floor is not a constant:

| recording | peak | longest run at +10 dB | longest run at +16 dB |
| --- | --- | --- | --- |
| empty room, quiet hour | -29 … -31 dBFS | 0-20 ms | 0 ms |
| empty room, loud hour | -22.7 dBFS | **240 ms** | 20 ms (1 frame) |
| room tone with the start cue bleeding in | -27.6 dBFS | 80 ms | 0 ms |
| room + one click sample | -26.9 dBFS | 20 ms | 0 ms |
| very quiet voice (20 dB below normal) | -27.8 dBFS | 100 ms | 0 ms |
| normal voice | -22.7 dBFS | 160 ms | 120 ms (6 frames) |

Row two is why the strict margin is 16 dB and not the 10 dB this started with: at 10 dB the loud-hour room tone produced a 240 ms run, was decoded, and the model answered the empty room with an invented sentence that the floating button pasted into the focused window. The trade-off is explicit: a short *and* soft utterance can now be refused, the log prints exactly what was measured, and `speechMarginDb` (12 in a quiet room, 0 to disable) is the knob. Note that the model's own tags cannot help here — it labels room tone `<|Speech|>` (`node probe/sensevoice-fields.mjs <file.wav>`).

`--speech-margin-db 0` disables the gate. Every result prints the level and, when the gate refuses, what it measured and which of the two conclusions applies (no sound at all vs. speech that was simply too quiet).

## Feedback sounds

The four cues (start, stop, done, error) are synthesized by this project rather than borrowed from the Windows sound scheme, so they cannot be confused with another program's notifications and do not change with the user's scheme. Play them yourself with `node probe/cue-check.mjs`, which writes them to `test-output/cues/`. `--no-beeps` silences them, `--beep-volume 0..1` (default 0.7) changes how loud they are; if the output device refuses the buffer, the tool falls back to the plain Windows sound instead of going silent.

They are also played **synchronously**, which is not an accident: with `SND_ASYNC`, a cue still playing when the MCI mapper opens the capture device makes `mciSendStringW('record')` never return — the process freezes with no error, no log line and no way out but Task Manager (`vtt listen` reproduced it on the first run). `probe/cue-capture-probe.mjs` walks one playback technique per mode through a real recording: every asynchronous variant deadlocks, every blocking variant completes. Blocking costs at most 233 ms, and `npm test` runs the probe in a child process with a timeout, so a hang fails the suite instead of hanging it.

## Verified on

Windows 10 22H2 (19045) x64, Node 24.19, SenseVoice int8 — real dictation pasted into a browser and an editor, plus a measured room-tone rejection. `npm test` runs five suites (audio gate + cues + the cue/recorder deadlock, HTTP API, global hotkey + resident process, overlay window/mouse semantics, tray menu structure); `vtt doctor` checks platform, models, recognizer load, microphone capture, clipboard round trip and hotkey registration.

Two honest caveats: `Shell_NotifyIcon` is refused with `error 5` inside low-integrity sessions (sandboxes, some CI), so the tray icon can only be confirmed on a real desktop — `probe/tray-probe.mjs` tells the two cases apart; and injected mouse/keyboard input is swallowed in some sessions, so the click and drag rules are tested through an injectable pointer seam (`MicButton`'s `pointerAt`) plus posted window messages rather than with synthetic hardware events.

## Troubleshooting

| symptom | what to do |
| --- | --- |
| Recording works but the text is empty | The result prints the measurement and the gate's verdict: `longest run above +16 dB: N frame(s), 4 needed` plus either `nothing in it stands out from its own noise floor` (the microphone is not hearing you — check mute, Windows privacy settings, the default input device, raise the input level) or `the voice detector still found N s of speech` (you spoke, just too quietly for the gate: retry with `--speech-margin-db 12`). |
| A word or two sometimes produces nothing at all | That is what the gate does when a short utterance is too quiet: it refuses to decode rather than let the model invent a sentence out of room tone. The default requires an 80 ms run 16 dB above the recording's own noise floor, or 480 ms at 10 dB for a soft but continuous sentence. Every refusal is explained in the log, and `--keep-recordings` keeps the audio so `node probe/gate-sweep.mjs <file>` can show which margin it would pass. |
| The first words are missing | The banner prints `microphone ready in Nms` (a warm-up capture at start-up). Wait for the icon to turn red before talking. |
| `Cannot register the global hotkey ...` | Another application owns it (a voice-input plugin often does). Pass `--hotkey ctrl+alt+d`. `vtt overlay` only warns and keeps working. |
| The button is gone | It does not hide by itself; check `overlay.log` and Task Manager for a leftover `node.exe`. A second launch revives a running button. |
| `overlay --stop` says the button cannot be reached | It belongs to another user or a higher privilege level (UIPI blocks the message). `node probe\who-is-button.mjs` prints the owning PID; end that `node.exe` in Task Manager. |
| Nothing happens after double-clicking the shortcut | Read `overlay.log` — the first line is a build stamp (version + source mtime), which tells a fresh process apart from an old one. |
| Text lands in the wrong window | Click into the target field first: the paste goes to whatever holds the focus when the recording stops. |

## License and credits

| component | used for | source | license |
| --- | --- | --- | --- |
| SenseVoiceSmall (ONNX int8) | speech recognition | [FunAudioLLM/SenseVoice](https://github.com/FunAudioLLM/SenseVoice) · [model card](https://huggingface.co/FunAudioLLM/SenseVoiceSmall) | code MIT; **weights under the [FunASR Model License](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE)** |
| Silero VAD | voice activity detection | [snakers4/silero-vad](https://github.com/snakers4/silero-vad) | MIT |
| sherpa-onnx | local inference runtime (Node bindings) | [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | Apache-2.0 |
| koffi | FFI used to call Win32 directly | [Koromix/koffi](https://github.com/Koromix/koffi) | MIT |
| this project | CLI, floating button, tray, HTTP API | this repository | MIT — see [LICENSE](LICENSE) |

Model weights are never committed: `vtt models --fetch` downloads them from pinned URLs and verifies their SHA-256, or the tool reuses an existing DSH cache. No third-party binaries live in this repository.
