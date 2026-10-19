# voice-to-text (vtt)

把 DSH「语音输入」插件里的语音转文字能力抽出来做成一个**独立的外部工具**：在任何应用里说话，文字自动进到光标处。

两个入口，同一个识别会话：

- **悬浮麦克风按钮**（`vtt overlay`）—— 一个浮在所有窗口最上层的小麦克风图标，跟着**文本光标**走。点一下开始说话，再点一下，文字自动粘贴到光标处。像一个输入法，不需要任何命令行窗口。
- **全局热键**（`vtt dictate`）—— `ctrl+alt+space` 开始/结束录音，同样自动复制并粘贴。

识别内核与插件完全一致 —— **SenseVoiceSmall**（ONNX int8）+ **Silero VAD**，通过 **sherpa-onnx** 在本地 CPU 上运行。不上传音频、不联网、不需要账号，装好即用。

> **录音不会留在磁盘上**：每次录音只写一个临时文件，转成 16 kHz 单声道后立刻删除，识别结果只存在于内存里；项目目录里不会出现任何 `.wav`。唯一的例外是你自己显式打开 `keepRecordings`（或 `--keep-recordings`）用于排查问题，见[配置](#配置)。

> TL;DR: 双击项目里的 `Voice to Text (floating button).lnk`（或 `start-overlay.vbs`）→ 光标旁边出现麦克风图标 → 点一下说话，再点一下出字。`vtt doctor` 告诉你哪里不对。
>
> English: see [README.en.md](README.en.md) (shorter; this file has the full design notes and troubleshooting).

---

## 目录

- [四种用法](#四种用法)
- [安装](#安装)
- [快速开始](#快速开始)
- [悬浮语音按钮](#悬浮语音按钮推荐)
- [命令参考](#命令参考)
- [在其他应用里使用](#在其他应用里使用)
- [配置](#配置)
- [HTTP API](#http-api)
- [模型](#模型)
- [自检与已验证行为](#自检与已验证行为)
- [故障排查](#故障排查)
- [它是怎么工作的](#它是怎么工作的)
- [许可与来源](#许可与来源)

---

## 四种用法

| 场景 | 用法 | 说明 |
| --- | --- | --- |
| **点一下图标说话** | `vtt overlay` | 悬浮麦克风按钮跟着光标走：点击开始/结束，文字粘贴到光标处；没有命令行窗口 |
| **只按快捷键说话** | `vtt dictate` | 常驻后台，`ctrl+alt+space` 开始/结束录音，文字自动复制并粘贴到当前焦点窗口 |
| **程序化调用** | `vtt serve` | 本地 HTTP 接口：`POST /transcribe`，另有 OpenAI 兼容的 `POST /v1/audio/transcriptions` |
| **音频文件转写** | `vtt transcribe foo.wav` | 一次性转写已有 WAV 文件，可 `--json` 输出 |

---

## 安装

要求：**Windows 10/11 x64**、**Node.js 20+**、无需管理员权限。

一条命令装好（检查 Node → 装依赖 → 自检 → 建快捷方式）：

```powershell
cd <你放这个项目的目录>\voice-to-text
.\install.ps1              # 加 -AddToPath 可把 bin 目录写进用户 PATH
```

也可以手动执行：

```powershell
cd <你放这个项目的目录>\voice-to-text

# 1) 安装依赖（两个原生依赖，均已内置 Windows x64 二进制）
npm install --cache .\.npm-cache --ignore-scripts

# 2) 自检：模型、麦克风、剪贴板、全局热键
node .\bin\vtt.mjs doctor
```

> `--cache .\.npm-cache` 与 `--ignore-scripts` 是为受限环境准备的：把 npm 缓存放在工作区内，并跳过依赖的安装脚本（两个依赖都不需要编译）。
> 如果你的机器上 npm 一切正常，直接 `npm install` 也可以。

**首次运行**：默认直接复用 DSH 已经下载好的模型缓存
（`%USERPROFILE%\.dsh\speech-to-text\sensevoice\models`），不会重复下载 240 MB。
如果这台机器上没有缓存，执行 `node .\bin\vtt.mjs models --fetch` 下载并校验（约 241 MB）。

### 让 `vtt` 成为全局命令（可选）

```powershell
# 方式一：把 bin 目录加进用户 PATH（之后任何终端里直接敲 vtt）
.\install.ps1 -AddToPath

# 方式二：创建听写快捷方式（项目目录内必成，桌面目录在受限会话下可能被拒绝）
.\install.ps1
```

不想用快捷方式时，直接双击项目里的 **`start-dictate.cmd`** 也是一样的：它设置好代码页（中文不乱码）、
启动常驻听写、窗口关掉即退出。

`bin\vtt.cmd` 是一个薄封装，直接调用 `bin\vtt.mjs`；任何能执行命令的地方都可以用它。

---

## 快速开始

```powershell
# 说 5 秒，把文字打印出来（一次性验证麦克风与模型）
node .\bin\vtt.mjs listen --seconds 5

# 常驻听写：按住说话 → 再按一次 → 文字进入当前窗口
node .\bin\vtt.mjs dictate

# 转写已有文件
node .\bin\vtt.mjs transcribe .\meeting.wav --language zh

# 起一个本地 HTTP 服务给别的程序调用
node .\bin\vtt.mjs serve --port 8791
```

`dictate` 的默认热键：

| 热键 | 作用 |
| --- | --- |
| `ctrl+alt+space` | 开始录音 / 结束录音并识别（识别结果复制 + 粘贴到焦点窗口） |
| `ctrl+alt+escape` | 放弃这次录音（不识别，并还原剪贴板） |
| `Ctrl+C`（在该终端窗口） | 退出 |

听写过程中会有系统提示音：开始一声、结束一声、识别为空时是错误音。提示音用于你正盯着别的窗口时确认状态，`--no-beeps` 可以关掉。

---

## 悬浮语音按钮（推荐）

一个浮在所有窗口最上层的麦克风小图标，跟着**文本光标**走：光标在哪里，它就贴在旁边。点一下开始录音（图标变红），再点一下结束，识别结果自动粘贴到光标处 —— 全程没有命令行窗口。

```powershell
# 无窗口启动（推荐；等同双击 start-overlay.vbs 或桌面快捷方式）
cscript //nologo .\start-overlay.vbs

# 想看着日志跑（会开一个控制台窗口）
.\start-overlay.cmd

# 直接跑，日志打到当前终端
node .\bin\vtt.mjs overlay

# 关掉正在运行的按钮
node .\bin\vtt.mjs overlay --stop
```

`install.ps1` 会生成两个快捷方式：**Voice to Text (floating button)** 是无窗口的悬浮按钮，**Voice to Text (dictate)** 是原来的命令行听写。

### 怎么操作

| 动作 | 效果 |
| --- | --- |
| 左键单击 | 开始录音；再点一次结束、识别并粘贴（图标：麦克风 → 红色停止 → 转圈 → 麦克风） |
| 按住左键拖动 | 把按钮拖到任意位置并**固定**；拖动的全过程绝不会开始录音，松手只负责「放下」，切到别的窗口后自动恢复跟随 |
| 右键单击 | 丢弃这次录音：不识别、不粘贴 |
| 中键单击 | **隐藏**悬浮按钮（不退出）：想再用时点通知区域图标 → 显示悬浮按钮，或按一次听写热键 |
| 通知区域图标（任务栏右下角） | 左键：开始 / 结束（和点悬浮按钮一样）；右键：中文菜单 —— 开始 / 结束听写、丢弃这次录音、隐藏 / 显示悬浮按钮、退出 |

拖动判定用的是**指针在屏幕上的真实位移**（`GetCursorPos`），不是鼠标消息里的客户区坐标。原来的写法有 bug：拖动时窗口一直跟着指针跑，所以窗口内坐标几乎不变，判断成「没动」，松手就当成了一次点击 —— 于是「一拖就开始录音」。现在按住后指针移动超过 `overlay.dragThresholdPx`（默认 6 像素）即算拖动，松手一定不会触发录音。

托盘菜单和提示文字都是中文（`src/tray.mjs` 的 `trayMenuItems` / `TRAY_TOOLTIP`）：菜单项以 UTF-16 直接交给 `AppendMenuW`，不经过控制台代码页，所以不会乱码；`npm run test:menu` 会真的建一个菜单、把每一项文字用 `GetMenuStringW` 读回来**逐字节比对**。**退出软件只有两个入口**：托盘菜单里的「退出」和 `vtt overlay --stop`；中键只是隐藏，误点不会把工具关掉。

### 它出现在哪里

- **有文本光标时**：贴在光标右侧、垂直居中对齐；太靠近屏幕右边缘时自动翻到光标左侧。
- **鼠标压上去时不跟**：光标和按钮之间留了一圈死区（默认 8 逻辑像素），鼠标在死区里按钮不动，所以点得到；拖走之后会固定，切到别的窗口自动恢复跟随。
- **默认不隐藏**：以前「没有光标就隐藏」，结果在某些程序里按钮消失、再启动又没反应，现在默认常亮，只在光标**移动时**才挪位置。找不到按钮时还可以点通知区域图标（右键 → 显示悬浮按钮）把它叫回来。
- 想恢复「只在能打字的地方出现」的老行为：`config.json` 里写 `"overlay": { "hideWithoutCaret": true }`（仍然带安全兜底：从启动起一次都没读到过光标就保持常亮，录音和识别过程中绝不隐藏）。
- 按钮消失后再按一次 `ctrl+alt+space` 开始录音，它会立刻回到光标旁边：热键和按钮是同一个会话，不会各说各话。

### 第一次说话就不会被漏掉

启动时会先把麦克风设备预热一次（打开 → 录一小段 → 关掉），这段开销（本机约 340 毫秒）花在启动阶段，而不是花在你点下按钮之后。每次录音还会在日志里写下设备真正开始采集花了多久：

```
● recording (max 120s, capture live after 38ms)
```

如果你习惯「点了就立刻说话」，看到这个数字就能知道有没有前几个字落在设备启动的空档里；数字偏大（几百毫秒以上）时，先等图标变红再开口即可。

### 开机自启（可选）

`Win+R` → 输入 `shell:startup` → 把项目目录里的 `Voice to Text (floating button).lnk` 复制进去。也可以在启动器里加一条：

```powershell
wscript.exe "<项目目录>\start-overlay.vbs"
```

### 日志与互斥

- 无窗口启动时，日志写在项目根目录的 `overlay.log`（每次启动清空，带时间戳）；用 `--log <文件>` 可以换路径。日志的**第一行是构建标识**（版本 + 源码最后修改时间），用来一眼分清「你双击的是新代码还是上次留下的老进程」。
- 同一时间只允许一个按钮：再启动一次不会报错退出，而是给正在运行的按钮发消息让它**重新显示**（日志里会写 `asked it to show itself again`）——「双击快捷方式没反应」就是这么修的。
- 互斥靠查找窗口类名（`VttMicButton`），不用锁文件，所以按钮进程被强杀后下次照样能启动。
- 如果找到的按钮**够不着**（属于另一个用户或更高权限的进程，Windows 会拦下消息），日志会写明这一点，并且**照样启动一个新按钮**，而不是什么都不做。
- `vtt overlay --stop` 分两步：先给按钮发 `WM_CLOSE`（正常退出，会把正在进行的识别做完再走）；消息被 Windows 拦下时，再结束拥有那个窗口的 `node.exe`，并打印它的 PID。只想发消息、绝不结束进程就加 `--no-force`。
- 通知区域图标需要和 shell 通信：如果进程权限比 shell 低（例如在受限沙箱里运行），`Shell_NotifyIconW` 会以「拒绝访问」失败，日志里会明说原因 —— 正常桌面双击启动不会遇到。

---

## 命令参考

```
vtt overlay [--stop [--no-force]] [--log [file]] [--no-paste] [--no-clipboard] [--no-beeps] [--json]
vtt dictate [--overlay] [--hotkey ctrl+alt+space] [--cancel-hotkey ctrl+alt+escape]
            [--no-paste] [--no-clipboard] [--no-beeps] [--language zh] [--json]
vtt listen  [--seconds 5] [--language zh] [--copy] [--paste] [--json]
vtt record  [--seconds 5] [--out file.wav]
vtt transcribe <file.wav> [--language zh] [--copy] [--paste] [--json]
vtt serve   [--port 8791] [--token <secret>] [--dictate]
vtt models  [--fetch] [--verify] [--force] [--json]
vtt doctor  [--json]
vtt config  [--init] [--force] [--json]
```

常用参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--language` | `zh` | `auto` / `zh` / `en` / `yue` / `ja` / `ko`；`auto` 让模型自己判断 |
| `--precision` | `int8` | `int8`（快、省内存）或 `fp32`（略准、更慢更大） |
| `--threads` | `2` | ONNX Runtime 线程数；识别慢就调大，占 CPU 就调小 |
| `--hotkey` | `ctrl+alt+space` | 听写热键。`vtt dictate` 里被占用会明确报错；`vtt overlay` 里只在日志和横幅里提示，按钮照常可用 |
| `--log [文件]` | `overlay.log` | 仅 `vtt overlay`：把运行日志写进文件（无窗口启动时唯一能看到情况的地方） |
| `--stop` | — | 仅 `vtt overlay`：通知正在运行的按钮退出（够不着时明确说明原因） |
| `--copy` / `--paste` | 关 / 关 | 一次性命令是否把结果放进剪贴板 / 粘贴到焦点窗口 |
| `--json` | 关 | 输出机器可读的 JSON |
| `--model-dir` / `--vad-path` | 自动 | 手动指定模型位置 |
| `--speech-margin-db` / `--min-speech-frames` | `16` / `5` | 一段录音里 20 ms 帧要高出自身底噪多少 dB、至少多少帧，才值得送去识别；设 `--speech-margin-db 0` 关掉这道闸门（静音也照解码，用来看模型到底「听」到了什么） |

退出码：`0` 成功，`1` 运行错误，`3` 没识别到内容，`4` 模型缺失，`5` 自检发现问题。

---

## 在其他应用里使用

### 1. 悬浮按钮：点一下说话（最省事）

见上面的[悬浮语音按钮](#悬浮语音按钮推荐)。适合「不想记快捷键、只想用鼠标点一下」的场景，也是唯一不需要任何命令行窗口的用法。

### 2. 全局热键 + 自动粘贴（通用）

任何「能接受键盘输入」的应用都适用：Word、浏览器、IDE、微信、终端……

```powershell
vtt dictate
```

焦点在哪个窗口，识别结果就会粘贴到哪个窗口。若目标窗口以管理员权限运行，Windows 会拒绝来自普通权限进程的模拟按键（UIPI 限制），此时文字仍在剪贴板里，手动 `Ctrl+V` 即可。

### 3. 只要剪贴板，不要自动粘贴

```powershell
vtt dictate --no-paste
```

适合你不希望工具替你按键的场景；按完热键后自己粘贴。

### 4. 由别的程序触发（HTTP）

```powershell
vtt serve --dictate --port 8791
```

此时任何能发 HTTP 请求的东西都能驱动听写，例如 AutoHotkey、Stream Deck、手机快捷指令、脚本：

```
POST http://127.0.0.1:8791/dictate          # 开始录音
POST http://127.0.0.1:8791/dictate/stop     # 结束、识别、粘贴，返回 {"text": "..."}
POST http://127.0.0.1:8791/dictate/cancel   # 放弃
```

`examples/dictate.ahk` 是一个 AutoHotkey v2 示例：把 `Win+;` 绑成听写键，由本工具负责录音、识别与粘贴。

### 5. 当作 OpenAI 兼容的转写后端

许多客户端支持自定义「OpenAI 兼容」的语音转写地址，把 Base URL 指到本工具即可：

```
Base URL: http://127.0.0.1:8791/v1
Path:     /audio/transcriptions
Model:    任意（会被忽略）
```

`examples/python_client.py` 与 `examples/transcribe.ps1` 是两种语言的最小调用示例。

### 6. 批量转写文件

```powershell
Get-ChildItem *.wav | ForEach-Object { vtt transcribe $_.FullName --json }
```

---

## 配置

`vtt config --init` 会在项目根目录生成 `config.json`；命令行参数优先于它，它优先于内置默认值。也可以用环境变量 `VTT_CONFIG` 指定另一个配置文件。

```json
{
  "language": "zh",
  "precision": "int8",
  "models": { "modelDir": null, "vadPath": null },
  "threads": 2,
  "segmentSeconds": 30,
  "vadThreshold": 0.5,
  "minSpeechSeconds": 0.25,
  "minSilenceSeconds": 0.5,
  "vadOnsetPaddingSeconds": 0.3,
  "hotkey": "ctrl+alt+space",
  "cancelHotkey": "ctrl+alt+escape",
  "maxSeconds": 120,
  "minSeconds": 0.6,
  "pasteDelayMs": 120,
  "beeps": true,
  "keepRecordings": false,
  "port": 8791,
  "token": null,
  "idleTimeoutMs": 300000,
  "overlay": {
    "followIntervalMs": 400,
    "gap": 6,
    "size": 46,
    "follow": true,
    "hideWithoutCaret": false,
    "caretGraceMs": 1200,
    "pointerFreezePx": 8,
    "dragThresholdPx": 6,
    "tray": true,
    "scale": null,
    "startVisible": true
  }
}
```

| 键 | 说明 |
| --- | --- |
| `models.modelDir` | SenseVoice 模型目录；留 `null` 自动查找（先看 DSH 缓存，再看工具自己的 `models/`） |
| `models.vadPath` | Silero VAD 路径；留 `null` 自动查找 |
| `segmentSeconds` | 分段上限：长音频按 VAD 切成不超过该秒数的片段送入模型 |
| `vadThreshold` / `minSpeechSeconds` / `minSilenceSeconds` | 语音活动检测灵敏度；环境嘈杂导致切碎时调大 `minSpeechSeconds` |
| `maxSeconds` | 单次录音上限（到点自动结束），默认 120 秒 |
| `minSeconds` | 短于该时长视为误触，直接丢弃 |
| `pasteDelayMs` | 粘贴前的等待毫秒数；某些应用需要更大值才能接住按键 |
| `keepRecordings` | 把每次录音留一份到 `recordings\`，**只用于排查**「识别为空/识别错」；默认关闭，打开时启动横幅和每次结果都会明确写出来（`! recordings are being kept ...`）。也可用环境变量 `VTT_KEEP_RECORDINGS=1`（给双击快捷方式的场景用） |
| `speechMarginDb` / `minSpeechFrames` | 「值不值得送去识别」的闸门：20 ms 帧要高出该录音自身底噪多少 dB（默认 16）、至少几帧（默认 5）。防的是**静音乱说话**：模型会对着纯底噪编出一句通顺的中文，而悬浮按钮会把这句话粘进你正在写的东西里。设 `0` 关闭 |
| `token` | 设置后 HTTP 接口要求 `Authorization: Bearer <token>`（默认只监听 127.0.0.1） |
| `overlay.size` / `gap` | 悬浮按钮的直径、与光标之间的间距（逻辑像素，会再乘以显示缩放） |
| `overlay.follow` / `followIntervalMs` | 是否跟着光标走、多久检查一次位置（默认 400 ms，只在位置真的变了才挪） |
| `overlay.pointerFreezePx` | 鼠标附近多少像素内冻结自动跟随（默认 8）：鼠标压上来时按钮不动，避免「点不到」 |
| `overlay.dragThresholdPx` | 按住后指针移动多少像素才算拖动（默认 6）；低于它松手算点击。判定用指针的屏幕坐标，所以窗口跟着指针跑也不会误判 |
| `overlay.tray` | 是否显示通知区域图标（默认 `true`）：左键开始 / 结束，右键出中文菜单（含退出、显示按钮） |
| `overlay.hideWithoutCaret` / `caretGraceMs` | 没有光标时是否隐藏（默认 **false** = 常亮）、失去光标后宽限多少毫秒才隐藏 |
| `overlay.scale` / `startVisible` | 强制缩放比例（`null` = 问 Windows）、启动时是否立刻显示 |

---

## HTTP API

仅监听 `127.0.0.1`。设置了 `token` 时，除 `/health` 外都需要 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 就绪状态、模型路径、引擎是否已加载 |
| `POST` | `/transcribe?language=zh` | 请求体是 WAV 文件（任意采样率/声道，服务端会转成 16 kHz 单声道） |
| `POST` | `/v1/audio/transcriptions` | OpenAI 兼容：`multipart/form-data`，字段 `file`，可选 `language` |
| `GET` | `/transcribe?file=<路径>` | 转写本机上已存在的 WAV |
| `POST` | `/dictate`、`/dictate/stop`、`/dictate/cancel` | 需 `--dictate` 启动；由外部程序驱动听写 |

示例：

```powershell
curl.exe -X POST --data-binary "@meeting.wav" "http://127.0.0.1:8791/transcribe?language=zh"
```

```python
import json, urllib.request
with open("meeting.wav", "rb") as f:
    body = f.read()
request = urllib.request.Request("http://127.0.0.1:8791/transcribe?language=zh", data=body, method="POST")
print(json.loads(urllib.request.urlopen(request).read())["text"])
```

---

## 模型

| 文件 | 大小 | 用途 |
| --- | --- | --- |
| `model.int8.onnx` | 228 MB | SenseVoiceSmall 权重（int8 量化） |
| `tokens.txt` | 309 KB | 词表 |
| `silero_vad.onnx` | 1.7 MB | 语音活动检测（切分长音频、丢掉静音） |

**这个工具不需要 DSH 在运行**：它只依赖三个模型文件，不依赖 DSH 的代码或进程。查找顺序（先找到先用）：
`config.models.*` / `--model-dir` → 环境变量 `VTT_MODEL_DIR`、`VTT_VAD_PATH` → 本工具的 `models\` 目录 →
DSH 缓存 `%USERPROFILE%\.dsh\speech-to-text\sensevoice\models`。

`vtt models --verify` 会按固定的 SHA-256 与字节数逐文件校验；`--fetch` 会从镜像下载并校验后再落盘（先 `hf-mirror.com`，失败再试 `huggingface.co`）。
下载位置：如果 DSH 缓存里**已经有**这套权重，就放在那里（与插件共用）；如果这台机器从来没装过 DSH，就放在本工具自己的 `models\` 目录，不会去创建 `.dsh` 目录树。
不管装没装 DSH，`--fetch` 下载的都是插件固定引用的同一批文件（相同的 SHA-256）。

---

## 自检与已验证行为

`npm test` 会跑四组无需人耳的自动化测试（都在本机上跑通）：

| 测试 | 覆盖内容 |
| --- | --- |
| `npm run test:menu` | 托盘菜单：中文措辞与顺序、命令 id 不重复、隐藏 / 显示文案随状态翻转、提示文字；并把菜单**真的建出来**，用 `GetMenuStringW` 把每项读回来逐字节比对 UTF-16（防止菜单乱码） |
| `npm run test:server` | 起真实 HTTP 服务：`/health`、`/transcribe`（raw WAV 与 multipart 两种）、`/v1/audio/transcriptions`、参数校验、鉴权 token、404/413/415/400 错误映射、导出、`/dictate` 重复开始冲突、关闭与重启 |
| `npm run test:hotkey` | 真实注册全局热键 → 用 PostMessage 投递 WM_HOTKEY → 校验消息泵回调与去重；验证非 WAV 文件被拒；启动真正的 `vtt dictate` 命令确认它是**常驻**的（不会打印完 banner 就退出），并确认停止后进程能自行退出（没有残留句柄） |
| `npm run test:overlay` | 四个状态的图标像素（尺寸、透明度、可见像素）、放置规则（贴光标 / 靠右翻边 / 无光标退到鼠标 / 不出屏）、跟随规则（鼠标死区内冻结、拖动优先、固定后不再跟随、`hideWithoutCaret` 开关与宽限时间、三条安全兜底）、**拖动判定**（指针真的移动了才算拖动；窗口一直停在指针下面、客户区坐标没变的那种几何也算拖动 —— 这正是「一拖就开始录音」的成因）、通知区域图标（结构体尺寸 1360、渲染、随状态换图、加入与移除、中文菜单项与提示文字、菜单项 id）、真实窗口上的点击 / 悬停 / 拖动 / 右键取消 / 中键只隐藏不退出 / 复活消息，以及**启动真正的 `vtt overlay` 进程**：从外部找到按钮窗口、投递点击、确认识别结果、用中键从外部确认它真的从屏幕上消失（`IsWindowVisible`）再叫回来、再用 `vtt overlay --stop` 关闭并断言退出码是 `0`（不崩溃）；热键被别的进程占用时按钮照样出现 |

其中 overlay 这一组还顺带锁定了一个真实崩溃：消息处理是在 Win32 回调栈上执行的，如果在里面直接做录音/推理，进程会以
`0xC0000005` 退出。现在窗口过程只判断「发生了什么」，真正的工作放到下一个事件循环 tick，退出前也会等正在进行的识别落地。

`vtt doctor` 在本机的结果：平台 Windows x64 / Node 20+ ✓、模型三件套校验通过（复用 DSH 缓存）✓、
识别引擎自检（静音输入 → 空文本，无异常）✓、麦克风可打开且能测到电平 ✓、剪贴板往返 ✓、全局热键可注册 ✓。

其他语言的调用示例（都实测过）：

```powershell
.\examples\transcribe.ps1 -File .\meeting.wav -Language zh
py .\examples\python_client.py .\meeting.wav        # Windows 上 python 可能只是商店别名，用 py
py .\examples\python_client.py --multipart .\meeting.wav
py .\examples\python_client.py --dictate --seconds 4
```

`examples\dictate.ahk` 是 AutoHotkey v2 版本：想用别热键（比如 `Win+;`）或用宏触发时使用。

**还没被验证的一件事**：本机没有可用的 TTS，也没有真人对着麦克风说话，所以“一段真实人声 → 正确文字”
这条端到端链路只能由你自己说一句来确认。录音、识别、剪贴板、粘贴四段分别都验证过了（包括把文字真的粘进一个
真实文本框），缺的只是把真人语音接到管道口：

```powershell
node .\bin\vtt.mjs listen --seconds 6      # 对着麦克风说“今天天气不错”，看是否打印出来
```

把结论告诉我：如果打印出文字，说明整条链路通了；如果打印为空但 `vtt doctor` 的电平不是全 0，那是模型解码的问题，我来调。

---

## 故障排查

先跑 `vtt doctor`，它会依次检查：平台、模型文件、识别引擎自检、麦克风（含电平）、剪贴板往返、热键可用性。

| 现象 | 原因与处理 |
| --- | --- |
| `Cannot register the global hotkey ctrl+alt+space` | `vtt dictate` 会直接报错退出：该热键已被别的程序占用（本机上就是 DSH 语音输入插件）。换一个：`--hotkey ctrl+alt+d`。`vtt overlay` 不会因此罢工：日志里写一行、横幅标注 `unavailable`，**悬浮按钮照常工作** —— 按钮才是它的交互方式 |
| 录制成功但识别为空 | 现在每次结果都会打印电平（`level -27.5 dBFS`）和原因（`no-speech-activity` = 整段录音里没有任何一帧高过它自己的底噪，压根没送给模型）。**先看这个数**：正常说话应该明显高于 -20 dBFS；只有 -30 以下就是麦克风没收到声音 —— 麦克风静音/被 Windows 隐私设置拦截/没选对默认输入设备。还查不出来就加 `--keep-recordings`，每次录音会留在 `recordings\`，可以自己放来听，用 `node probe\wav-level.mjs <文件>` 看峰值/底噪，或再用 `vtt transcribe <文件>` 复现 |
| 什么都没说，却粘出来一句莫名其妙的话 | 这是模型对纯底噪的**幻觉**（SenseVoice 会对着静音编一句通顺的中文），已由 `speechMarginDb` 闸门挡住：没有一帧高出底噪 16 dB 就不解码，直接报「没识别到」。想亲眼看见幻觉：`vtt transcribe recordings\<那次录音>.wav --speech-margin-db 0` |
| 粘贴没发生，但剪贴板有字 | 目标窗口是管理员权限（UIPI），手动 `Ctrl+V`；或把本工具也以管理员身份运行 |
| 识别很慢 | 提高线程 `--threads 4`；或改用更短的录音；CPU 推理 1 秒音频通常远快于 1 秒 |
| 中文夹杂英文识别不准 | `--language auto`；`zh` 会强制按中文解码 |
| `is not a RIFF/WAVE file` | 只支持 WAV。先用 ffmpeg 转成 `-ar 16000 -ac 1` 的 WAV |
| 麦克风被别的程序独占 | 关闭正在占用的录音软件（会议客户端等）后重试 |
| 屏幕上找不到悬浮按钮 | 默认已经**不再自动隐藏**（`hideWithoutCaret` 默认 `false`）。找不到就说明进程没在跑：看 `overlay.log` 最后几行，或任务管理器里有没有 `node.exe`。想恢复老行为（只在能打字的地方出现）设 `"overlay": { "hideWithoutCaret": true }` |
| 双击悬浮按钮快捷方式没反应 | 先跑 `vtt doctor`；无窗口启动的报错在项目根目录的 `overlay.log` 里。若 Node 不在 PATH，设环境变量 `VTT_NODE` 指向 `node.exe`（`start-overlay.vbs` 找不到时会弹窗提示）。再启动一次会给正在运行的按钮发消息让它重新显示，日志里出现 `asked it to show itself again` 就成了 |
| `overlay --stop` 说「够不着」或没有关掉按钮 | `--stop` 先发 `WM_CLOSE`；消息被 Windows 拦下（按钮属于另一个用户或更高权限的进程）时会**结束拥有那个窗口的 `node.exe`** 并打印 PID。只想发消息：`--no-force`。还不行就 `node probe\who-is-button.mjs` 看窗口属于哪个 PID，到任务管理器结束它 |
| 按钮停在屏幕角落而不是光标旁 | 那个窗口没有可读的文本光标（游戏、部分 UWP 应用、终端），此时按钮退到鼠标位置；不影响点击使用 |
| 鼠标一靠近按钮它就动、点不到 | 已经修好了：鼠标周围 `pointerFreezePx`（默认 8 像素）内按钮冻结不跟随；嫌不够可以调大 |
| 一拖动按钮就开始录音 | 已经修好了（判定改用指针的屏幕位移，见上文「怎么操作」）。日志里 `● recording (max 120s, capture live after 38ms)` 只在真正的点击之后才会出现，可以用它确认 |
| 点了按钮，第一句话没录进去 | 启动时已经预热过麦克风，正常应该是几十毫秒开始采集（日志 `capture live after Nms`）。数字很大时先等图标变红再开口；也可能是这台机器的唤醒时间确实长，把 `capture live after` 那一行发给我 |
| 任务栏右下角没有图标 | 先确认 `overlay.tray` 不是 `false`；日志里若写 `the shell refused the notification-area icon (access denied...)` 说明这个进程权限低于 shell（受限沙箱/另一个桌面），正常双击启动不会出现。没有图标也不影响悬浮按钮本身 |
| 文字粘到了错误的窗口 | 点击按钮不会抢焦点（`WS_EX_NOACTIVATE`）；如果是慢应用没接住按键，调大 `--paste-delay 250` |

---

## 它是怎么工作的

```
两个入口，同一个会话
  悬浮麦克风按钮 (分层窗口 + 每条消息的鼠标命中)  ┐
  全局热键 (RegisterHotKey + 消息泵)             ┴→ begin / finish / discard
        ↓
麦克风采集 (WinMM MCI waveaudio → 48 kHz/16-bit/立体声 WAV)
        ↓  重采样 + 混为单声道 → 16 kHz PCM
Silero VAD 切分 → SenseVoiceSmall (sherpa-onnx, CPU) → 文本
        ↓
剪贴板 (CF_UNICODETEXT) + 模拟 Ctrl+V
```

几个刻意的设计取舍：

- **不启动子进程**。录音、剪贴板、热键、按键注入、悬浮窗口全部通过 `koffi` 在本进程内直接调用 Win32 API。省掉 ffmpeg / PowerShell 依赖，冷启动更快，也不会与受限环境的子进程策略冲突。
- **窗口是「分层窗口」而不是普通窗口**：`WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`，用 `UpdateLayeredWindow` 逐像素画抗锯齿的圆和麦克风图形，鼠标命中由每条 `WM_MOUSEMOVE` 自己算。`WS_EX_NOACTIVATE` 是关键 —— 点按钮**不会抢走焦点**，否则「粘贴到光标处」就无从谈起（焦点一丢，光标就没了）。同一个窗口还带一个 `HTCLIENT` + `MA_NOACTIVATE` 的命中测试，确保点击不会激活它。
- **画在哪儿不猜**：`GetGUIThreadInfo` 读前台线程的插入符矩形（拿不到就退到鼠标位置），只在光标旁边画。
- **消息处理不在回调里干活**：窗口过程只记录发生了什么，录音和识别放到下一个事件循环 tick（见上面的崩溃说明）。
- **采集格式固定 48 kHz/16-bit/立体声**。Windows 的 MCI waveaudio 映射器只接受这一种格式（其他采样率/声道组合会返回 MCI 错误 282），而且它会往文件头写错误的 `byteRate`，所以真实格式以 `status` 查询结果为准，转换时显式覆盖。
- **识别在本地 CPU 上跑**，模型常驻内存（int8 约 250 MB）。首次 `load()` 需要若干秒，之后单次识别是百毫秒级。
- **静音不乱说话**：识别前先量一遍 20 ms 帧的电平，没有任何一帧高出这段录音自身底噪 16 dB 就直接返回空文本（`reason: no-speech-activity`），压根不送模型。这条是实测出来的 —— 一段 3 秒的空房间录音被 SenseVoice 解码成了一句通顺的中文「小气自己写就自己写。」，而悬浮按钮会把这句话粘进用户正在写的东西里。判断是**相对**的（跟录音自己的底噪比）而不是绝对音量，所以安静环境里的正常说话不会被误伤；每次结果都会打印 `level ... dBFS`，闸门开合有据可查（`--speech-margin-db 0` 可关闭）。

### 目录结构

```
voice-to-text/
├─ bin/vtt.mjs, bin/vtt.cmd     入口（薄封装）
├─ start-overlay.vbs            无窗口启动悬浮按钮（双击即用）
├─ start-overlay.cmd            带控制台的启动方式（看日志用）
├─ start-dictate.cmd            带控制台的听写启动方式
├─ install.ps1                  一键安装 + 自检 + 快捷方式
├─ src/cli.mjs                  命令行与各子命令
├─ src/dictate.mjs              常驻会话：热键 +（可选）悬浮按钮
├─ src/dictation.mjs            一次听写会话：录音 → 识别 → 投递（录音用完即删）
├─ src/overlay.mjs              悬浮麦克风按钮：状态、跟随、点击语义、托盘
├─ src/tray.mjs                 托盘图标与中文右键菜单
├─ src/win32-gui.mjs            Win32 GUI：窗口类、分层窗口、光标定位、托盘、查找/关闭按钮
├─ src/raster.mjs               图标光栅化（抗锯齿圆 + 麦克风图形，预乘 BGRA）
├─ src/engine.mjs               sherpa-onnx 识别引擎（含电平闸门与 VAD 分段）
├─ src/wav.mjs                  WAV 解析 / 重采样 / 规范化 / 电平测量
├─ src/win32.mjs                Win32：MCI 录音、热键、消息泵、剪贴板、按键
├─ src/server.mjs               本地 HTTP API
├─ src/models.mjs               模型查找 / 校验 / 下载
├─ src/doctor.mjs               自检
├─ test/                        四组自检脚本（server / hotkey / overlay / menu）
├─ probe/                       开发期探针：可复现的测量脚本，非运行时依赖
├─ examples/                    其他语言的调用示例（Python / PowerShell / AutoHotkey）
├─ LICENSE                      MIT
├─ README.en.md                 英文说明
└─ .gitignore                   依赖、模型、录音、日志、本地配置都不入库
```

`probe/` 里的脚本不是产品的一部分，但都保留着：它们是本项目所有结论的**证据**——MCI 只接受 48 kHz/16-bit/立体声、`Shell_NotifyIcon` 在低完整性会话里返回 5、合成鼠标事件不可信、`koffi.view` 返回的是 `ArrayBuffer`、`koffi.decode(buf, 0, 'str16')` 会崩溃等等，都是先写一个几十行的探针量出来的。想复核某个结论时，直接跑对应的探针即可。

---

## 许可与来源

本工具做的事情只有一件：把 DSH「语音输入」插件所用的同一套开源组件抽出来，装进一个不依赖 DSH 的独立 Windows 程序。识别内核、模型、推理库都没有改动。

| 组件 | 用在哪里 | 来源 | 许可 |
| --- | --- | --- | --- |
| **SenseVoiceSmall**（ONNX int8） | 语音识别模型 | [FunAudioLLM/SenseVoice](https://github.com/FunAudioLLM/SenseVoice) · [模型卡](https://huggingface.co/FunAudioLLM/SenseVoiceSmall) | 代码 MIT；**模型权重另按 [FunASR Model License](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE) 分发**（允许商用，需保留署名与模型名） |
| **Silero VAD** | 语音活动检测（切句） | [snakers4/silero-vad](https://github.com/snakers4/silero-vad) | MIT |
| **sherpa-onnx** | 本地推理运行时（Node 绑定） | [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | Apache-2.0 |
| **koffi** | 调用 Win32 API 的 FFI | [Koromix/koffi](https://github.com/Koromix/koffi) | MIT |
| 本项目源码 | 命令行、悬浮按钮、托盘、HTTP API | 见本仓库 | MIT（见 [LICENSE](LICENSE)） |

模型权重不入库：`vtt models --fetch` 按固定 URL 下载并校验 SHA-256，或直接复用你机器上已有的 DSH 缓存。
本仓库不含任何第三方二进制，`npm install` 会拉取 `sherpa-onnx-node` 与 `koffi` 的官方预编译包。
