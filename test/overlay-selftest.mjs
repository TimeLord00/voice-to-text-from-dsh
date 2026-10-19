/**
 * Self-test for the floating microphone button.
 *
 * Part 1 exercises the pure parts (frames, hit maths, placement) and Part 2 drives a real layered
 * window in this process with posted mouse messages. Part 3 is the honest end-to-end check: it starts
 * `vtt overlay` as a separate process, finds its window from *this* process, clicks it twice with
 * posted messages, reads the recognition out of the child's log, and asks it to close with
 * `vtt overlay --stop`.
 *
 * Exit code 0 means every check passed. Run it with `npm run test:overlay`.
 */
import { spawn } from 'node:child_process'
import { openSync, closeSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MicButton, planFollow } from '../src/overlay.mjs'
import { BUTTON_STATES, renderButton } from '../src/raster.mjs'
import { TRAY_COMMAND, TRAY_ICON_SIZE, TRAY_TOOLTIP, TrayIcon, trayMenuItems } from '../src/tray.mjs'
import { loadConfig } from '../src/config.mjs'
import { Hotkeys } from '../src/win32.mjs'
import { WM, buttonAnchor, buttonProcessId, closeButtonWindow, findButtonWindow, isWindow, isWindowVisible, lastShellError, notifyIconDataSize, postMessage, shellPresent } from '../src/win32-gui.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const ENTRY = join(ROOT, 'bin', 'vtt.mjs')
const OUTPUT = join(ROOT, 'test-output')
mkdirSync(OUTPUT, { recursive: true })

// This suite and the button the user is running have to be able to exist at the same time. A button
// left over from an earlier session keeps its window hidden, so a class-name lookup cannot tell it
// apart from a live one and Part 3 would refuse to start the child. Run everything here under a private
// window class; the child inherits it through the environment.
process.env.VTT_BUTTON_CLASS = `VttMicButtonTest${process.pid}`

let failures = 0

/**
 * Report one check.
 * @param {boolean} ok - whether the check passed.
 * @param {string} label - what was checked.
 * @param {string} [detail] - extra evidence.
 * @returns {void}
 */
function check(ok, label, detail = '') {
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}\n`)
}

// A button left over from an *earlier run of this suite* (a process that hid its window and never came
// back, which is precisely the field bug this suite guards against) would be found by every class-name
// search below and make Part 3 meaningless: a second launch would refuse to start. Report it here and
// close it in Part 3, where the waiting helper is available.
const foreignButton = findButtonWindow()
if (foreignButton) {
  process.stdout.write(`NOTE  a button from an earlier run of this suite is still on the desktop (handle ${foreignButton})\n`)
}

/**
 * Wait for a condition to become true.
 * @param {() => boolean} predicate - condition.
 * @param {number} timeoutMs - how long to wait.
 * @param {number} [stepMs] - poll interval.
 * @returns {Promise<boolean>} whether it became true.
 */
async function waitFor(predicate, timeoutMs, stepMs = 50) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolvePromise) => setTimeout(resolvePromise, stepMs))
  }
  return predicate()
}

// ---------------------------------------------------------------------------------------------
// Part 1: frames and placement
// ---------------------------------------------------------------------------------------------

process.stdout.write('\nframes\n')
for (const state of BUTTON_STATES) {
  const frame = renderButton({ size: 40, state })
  const opaque = frame.pixels.reduce((count, value, index) => (index % 4 === 3 && value > 0 ? count + 1 : count), 0)
  check(frame.width === frame.height && frame.width === 40 + frame.margin * 2, `frame ${state} has the expected size`, `${frame.width}x${frame.height} margin ${frame.margin}`)
  check(opaque > 100, `frame ${state} actually draws something`, `${opaque} visible pixels`)
  check(frame.pixels.every((value, index) => index % 4 !== 3 || value <= 255), `frame ${state} premultiplied alpha is in range`)
}
const idle = renderButton({ size: 40, state: 'idle' })
const recording = renderButton({ size: 40, state: 'recording' })
check(!idle.pixels.equals(recording.pixels), 'idle and recording look different')

process.stdout.write('\nplacement\n')
const screen = { x: 0, y: 0, width: 1920, height: 1080 }
const caret = { x: 500, y: 300, height: 18 }
const placed = buttonAnchor({ size: 46, gap: 6, caret, screen })
check(placed.source === 'caret', 'a caret wins over the pointer', placed.source)
check(placed.x === 506, 'the button sits one gap right of the caret', `x=${placed.x}`)
check(placed.y === 300 - 9 - 23, 'the button is centred on the caret', `y=${placed.y}`)
const flipped = buttonAnchor({ size: 46, gap: 6, caret: { x: 1900, y: 300, height: 18 }, screen })
check(flipped.x === 1900 - 6 - 46, 'the button flips to the left of a caret near the right edge', `x=${flipped.x}`)
const cursorOnly = buttonAnchor({ size: 46, gap: 6, caret: null, cursor: { x: 100, y: 200 }, screen })
check(cursorOnly.source === 'cursor' && cursorOnly.x === 106 && cursorOnly.y === 206, 'without a caret it falls back to the pointer', `x=${cursorOnly.x} y=${cursorOnly.y}`)
const clamped = buttonAnchor({ size: 46, gap: 6, caret: { x: 100, y: 2, height: 18 }, screen })
check(clamped.y >= 2, 'the button never leaves the screen', `y=${clamped.y}`)

process.stdout.write('\nfollow rules\n')
/** The window rectangle the follow rules are evaluated against. */
const windowRect = { x: 1000, y: 500, width: 48, height: 48 }
/**
 * One follow tick, described by the case under test.
 * @param {object} [extra] - context fields that differ from the neutral case.
 * @returns {object} the plan.
 */
const tick = (extra = {}) => planFollow({
  caret: null,
  pointer: { x: 0, y: 0 },
  window: windowRect,
  size: 46,
  margin: 4,
  overlay: {},
  state: 'idle',
  seenCaret: false,
  lastCaretAt: 0,
  now: 10000,
  pinned: false,
  dragging: false,
  visible: true,
  screen,
  ...extra,
})
// The field bug this section exists for: with no readable caret the button used to be re-anchored to
// the pointer on every tick, so it sat at the pointer's bottom-right corner, ran away as soon as the
// pointer moved towards it and could never be clicked.
const chasing = tick({ pointer: { x: 3000, y: 2000 } })
check(chasing.action === 'none' && chasing.reason === 'stay', 'with no caret the button does not follow the pointer', `${chasing.action}/${chasing.reason}`)
const frozen = tick({ pointer: { x: 1020, y: 520 }, seenCaret: true })
check(frozen.action === 'none' && frozen.reason === 'pointer', 'the pointer on the button freezes every automatic move', `${frozen.action}/${frozen.reason}`)
const reaching = tick({ pointer: { x: 995, y: 520 }, seenCaret: true })
check(reaching.action === 'none', 'the freeze reaches a little past the button', `${reaching.action}/${reaching.reason}`)
const farAway = tick({ pointer: { x: 985, y: 520 }, seenCaret: true })
check(farAway.action === 'hide', 'the freeze does not spill far past the button', `${farAway.action}/${farAway.reason}`)
const typedAgain = tick({ pointer: { x: 200, y: 200 }, seenCaret: true })
check(typedAgain.action === 'hide', 'once a caret was seen, losing it hides the button', typedAgain.reason)
const atCaret = tick({ caret: { x: 500, y: 300, height: 18 } })
check(atCaret.action === 'move' && atCaret.x === 502 && atCaret.y === 264, 'a caret moves the button next to it', `x=${atCaret.x} y=${atCaret.y}`)
check(atCaret.sawCaret === true, 'the tick reports that it saw a caret')
const midRecording = tick({ state: 'recording', seenCaret: true, pointer: { x: 200, y: 200 } })
check(midRecording.action === 'none', 'a recording is never hidden mid-way', midRecording.reason)
const draggingTick = tick({ dragging: true, caret: { x: 500, y: 300, height: 18 } })
check(draggingTick.action === 'none', 'a drag outranks the caret', draggingTick.reason)
const pinnedTick = tick({ pinned: true, caret: { x: 700, y: 300, height: 18 } })
check(pinnedTick.action === 'none', 'a pinned button is not dragged back to the caret', pinnedTick.reason)
const optedIn = tick({ seenCaret: true, pointer: { x: 200, y: 200 }, overlay: { hideWithoutCaret: true } })
check(optedIn.action === 'hide', 'hideWithoutCaret asks for the old hiding behaviour', optedIn.reason)
const gracedTick = tick({ seenCaret: true, pointer: { x: 200, y: 200 }, overlay: { hideWithoutCaret: true }, lastCaretAt: 9900 })
check(gracedTick.action === 'none', 'the grace period still applies to an opted-in button', gracedTick.reason)

process.stdout.write('\nconfig\n')
const configured = loadConfig({})
check(configured.overlay.hideWithoutCaret === false, 'the button no longer hides unless it is asked to', String(configured.overlay.hideWithoutCaret))
check(configured.overlay.pointerFreezePx === 8, 'the pointer freeze has a default', String(configured.overlay.pointerFreezePx))

process.stdout.write('\nvisibility\n')
/** One unmounted button per case: no window, just the visibility rules. */
const visButton = (overlay = {}) => new MicButton({ overlay: { follow: false, ...overlay } }, { log: () => {} })
const fresh = visButton()
check(fresh.shouldHide('cursor') === false, 'a button that has never seen a caret stays visible', `seenCaret=${fresh.seenCaret}`)
check(fresh.shouldHide('caret') === false, 'a visible button never hides next to a caret')
const typed = visButton()
typed.seenCaret = true
typed.lastCaretAt = Date.now() - 5000
check(typed.shouldHide('cursor') === true, 'no caret any more hides the button')
check(typed.shouldHide('caret') === false, 'a caret brings it straight back')
typed.setState('recording')
check(typed.shouldHide('cursor') === false, 'the button stays while a recording is running')
typed.setState('transcribing')
check(typed.shouldHide('cursor') === false, 'the button stays while the recording is transcribed')
const opted = visButton({ hideWithoutCaret: false })
opted.seenCaret = true
opted.lastCaretAt = Date.now() - 5000
check(opted.shouldHide('cursor') === false, 'hideWithoutCaret false keeps it on screen permanently')
const graced = visButton({ caretGraceMs: 50 })
graced.seenCaret = true
graced.lastCaretAt = Date.now()
check(graced.shouldHide('cursor') === false, 'the grace period delays hiding after the caret is lost')

// ---------------------------------------------------------------------------------------------
// Part 2: a real window in this process
// ---------------------------------------------------------------------------------------------

process.stdout.write('\nwindow\n')
const pump = new Hotkeys()
pump.start()
const events = []
// The button reads the pointer only while a press is being dragged, and only after this is initialised.
const pointer = { x: 0, y: 0 }
const button = new MicButton(
  { overlay: { size: 40, gap: 6, follow: false, startVisible: true, tray: false } },
  {
    log: () => {},
    onToggle: () => events.push('toggle'),
    onCancel: () => events.push('cancel'),
    onQuit: () => events.push('quit'),
    pump,
    // The drag decision is made in *screen* space from the real pointer, because a mouse message only
    // carries client coordinates and the window moves under the pointer while dragging. A test that
    // posted messages without moving the physical cursor is exactly how "dragging started a recording"
    // slipped through, so the pointer is injected here and the helpers below keep it in step.
    pointerAt: () => ({ x: pointer.x, y: pointer.y }),
  },
)
button.mount()
check(Boolean(button.handle), 'the button created a window')
check(findButtonWindow() !== null, 'the window can be found by class name from this process')
check(button.visual === 'idle', 'the button starts idle', button.visual)

button.click()
await waitFor(() => events.length >= 1, 1000)
check(events.join(',') === 'toggle', 'a left click toggles dictation', events.join(','))
// The button lives on the real desktop, so the physical pointer may happen to rest on it; hover is
// asserted separately below and must not make the state checks flaky.
button.hovered = false
button.setState('recording')
check(button.visual === 'recording', 'the button repaints when recording starts', button.visual)
button.setState('transcribing')
check(button.visual === 'transcribing', 'the button repaints while transcribing', button.visual)
button.setState('idle')
check(button.visual === 'idle', 'the button goes back to idle', button.visual)
check(events.length === 1, 'clicking does not fire the callback twice', events.join(','))

// Hover is a separate visual state; the window tracks WM_MOUSELEAVE so it cannot get stuck hovered.
button.handleMouse('move', 0, 0x00010001)
check(button.visual === 'hover', 'the pointer over the button shows the hover state', button.visual)
button.handleMouse('mouse-leave', 0, 0)
check(button.visual === 'idle', 'leaving the button clears the hover state', button.visual)

// The notification-area icon is the way back to a hidden button, so it is exercised for real: the shell
// either accepts it or it does not. It exists only for the length of these checks.
check(notifyIconDataSize() === 1360, 'the notification-area structure has the size the shell expects', String(notifyIconDataSize()))
const tray = new TrayIcon({ window: button.window, tooltip: 'voice-to-text self-test' })
const trayAccepted = tray.add()
// A refusal is only a defect when the shell could have accepted it. Measured cause of a legitimate
// refusal: this harness runs at low integrity (whoami /groups -> "Mandatory Label\Low Mandatory Level")
// while the taskbar belongs to a medium-integrity shell, so every variant of the call — including a
// stock system icon — comes back with error 5 (access denied). See probe\tray-probe.mjs.
const trayRefusal = lastShellError()
const trayEnvironment = trayRefusal === 5 || !shellPresent()
check(trayAccepted === true || trayEnvironment, 'the notification-area icon is accepted by the shell', trayAccepted ? '' : `refused with error ${trayRefusal}${shellPresent() ? '' : ' (no taskbar in this session)'}`)
if (!trayAccepted) process.stdout.write(`NOTE  the tray icon was refused with error ${trayRefusal}${trayEnvironment ? '; that is this sandbox (low integrity), not the tool — confirm it on a real desktop' : ''}\n`)
check(tray.icon !== null, 'the icon was rendered from the button frame without an image file')
tray.paint('recording')
check(tray.visual === 'recording', 'the tray icon follows the dictation state', tray.visual)
tray.remove()
check(tray.added === false, 'the notification-area icon is removed again', String(tray.added))

// The menu is the user's only way to quit, so its wording is part of the interface. The labels are Chinese
// and go to Windows as UTF-16; test\menu-selftest.mjs proves the round trip through a real menu byte for byte.
{
  const labels = trayMenuItems(true).map((item) => item.label ?? '---')
  check(labels.join('|') === '开始 / 结束听写|丢弃这次录音|---|隐藏悬浮按钮|---|退出', 'the tray menu is in Chinese', labels.join('|'))
  const hidden = trayMenuItems(false).find((item) => item.id === TRAY_COMMAND.visibility)
  check(hidden?.label === '显示悬浮按钮', 'the visibility entry offers 显示 while the button is hidden', hidden?.label)
  const defaultTooltip = new TrayIcon({ window: button.window })
  check(defaultTooltip.tooltip === TRAY_TOOLTIP, 'the tray tooltip is in Chinese by default', defaultTooltip.tooltip)
}

// A mouse message carries *client* coordinates, so the pointer's screen position is only known once
// the window position at that moment is added back in. These helpers emulate a real cursor by aiming
// at a screen point, exactly as the system does while the window is being dragged.
const toClient = (screenX, screenY) => {
  const x = (screenX - button.window.position.x) & 0xffff
  const y = (screenY - button.window.position.y) & 0xffff
  return ((y << 16) | x) >>> 0
}
const pressAt = (screenX, screenY) => {
  pointer.x = screenX
  pointer.y = screenY
  button.handleMouse('left-down', 0, toClient(screenX, screenY))
}
const moveTo = (screenX, screenY) => {
  pointer.x = screenX
  pointer.y = screenY
  button.handleMouse('move', 0, toClient(screenX, screenY))
}
const release = () => button.handleMouse('left-up', 0, toClient(pointer.x, pointer.y))

const before = { ...button.window.position }
pressAt(before.x + 100, before.y + 100)
moveTo(before.x + 102, before.y + 101)
release()
await waitFor(() => events.length >= 2, 500)
check(events[events.length - 1] === 'toggle', 'a wobble under the drag threshold is still a click', events.join(','))
check(button.window.position.x === before.x && button.window.position.y === before.y, 'a wobble does not move the button', `${before.x},${before.y} -> ${button.window.position.x},${button.window.position.y}`)

{
  const start = { ...button.window.position }
  pressAt(start.x + 100, start.y + 100)
  moveTo(pointer.x + 50, pointer.y + 20)
  moveTo(pointer.x + 150, pointer.y + 80)
  check(button.dragging, 'holding the button down and moving the pointer starts a drag')
  check(button.window.position.x === start.x + 200 && button.window.position.y === start.y + 100, 'the button follows the pointer while dragged', `${start.x},${start.y} -> ${button.window.position.x},${button.window.position.y}`)
  release()
  const toggles = events.filter((event) => event === 'toggle').length
  check(toggles === 2, 'releasing a drag does not toggle dictation', `${toggles} toggles`)
  check(button.pinned, 'the button stays where it was dropped')

  // The field bug: the window moves under the pointer, so the client coordinates of every following
  // mouse message stay the same. Classifying the press from those coordinates concluded "no drag" and
  // started a recording on release. Putting the window back by hand reproduces that geometry exactly,
  // with a pointer that has really travelled.
  const stuck = { ...button.window.position }
  const togglesBefore = events.filter((event) => event === 'toggle').length
  pressAt(stuck.x + 200, stuck.y + 150)
  moveTo(stuck.x + 260, stuck.y + 210)
  button.window.moveTo(stuck.x, stuck.y, { repaint: false })
  release()
  await waitFor(() => false, 50)
  const togglesAfter = events.filter((event) => event === 'toggle').length
  check(togglesAfter === togglesBefore, 'a drag does not toggle when the window stays under the pointer', `${togglesBefore} -> ${togglesAfter}`)
}

// A pinned button must not be dragged back to the caret by the follow timer.
const pinnedAt = { ...button.window.position }
button.follow()
check(button.window.position.x === pinnedAt.x && button.window.position.y === pinnedAt.y, 'a pinned button stops following the caret', `${pinnedAt.x},${pinnedAt.y}`)
button.lastForeground = null
// A second launch of the shortcut posts WM.APP_REVIVE; it has to bring a hidden button back, because
// "the button is gone and starting it again does nothing" is exactly what the field report described.
button.window.hide()
check(button.window.visible === false, 'the button can be hidden')
postMessage(button.handle, WM.APP_REVIVE, 0, 0)
const revived = await waitFor(() => button.window.visible === true, 1000)
check(revived, 'a revive message shows the button again')
check(button.pinned === false, 'reviving it also lets it follow the caret again')
// `vtt overlay --stop` falls back to ending the process that owns the window when Windows refuses the
// close message, so naming that process has to work.
const owner = buttonProcessId()
check(owner === process.pid, 'the button can name the process that owns its window', `${owner} vs ${process.pid}`)

button.handleMouse('right-up', 0, 0)
await waitFor(() => events.includes('cancel'), 500)
check(events.includes('cancel'), 'a right click discards the recording', events.join(','))

// The middle button hides the icon; it must never end the session, because a stray third-button click
// would then take the whole tool down (the way back is the tray menu, or the hotkey).
{
  const quitsBefore = events.filter((event) => event === 'quit').length
  button.handleMouse('middle-up', 0, 0)
  const hidden = await waitFor(() => button.window.visible === false, 500)
  check(hidden, 'a middle click hides the button')
  check(events.filter((event) => event === 'quit').length === quitsBefore, 'a middle click does not quit', events.join(','))
  button.setVisible(true, 'self-test')
  check(button.window.visible === true, 'the hidden button comes back (the tray menu entry does this)')
}

button.handleMouse('close', 0, 0)
await waitFor(() => events.includes('quit'), 500)
check(events.includes('quit'), 'WM_CLOSE asks the owner to quit', events.join(','))

const handle = button.handle
button.dispose()
// Checked against our own handle: a button left over from another session is found by the same class
// name, and blaming this process for it hid the real story the first time this suite ran.
check(handle !== null && isWindow(handle) === false, 'disposing the button destroys its window')
check(foreignButton !== null || findButtonWindow() === null, 'no button window is left behind in this process')
pump.dispose()

// ---------------------------------------------------------------------------------------------
// Part 3: the real command, in its own process, clicked from this one
// ---------------------------------------------------------------------------------------------

process.stdout.write('\nresident process\n')
let exited = null
let child = null
let fd = null
// A leftover button from an earlier run of this suite would make the launch below refuse to start. It
// can only be closed if it runs in this session, so try that first and say plainly what to do when it
// cannot be reached.
if (foreignButton) {
  const status = closeButtonWindow()
  const gone = await waitFor(() => findButtonWindow() === null, 3000)
  process.stdout.write(`NOTE  the leftover button answered "${status}" and ${gone ? 'closed' : 'is still there'}\n`)
}
const free = findButtonWindow() === null
check(free, 'no other floating button is occupying the desktop', free ? '' : 'close the leftover node.exe in Task Manager and run this suite again')
// A taken hotkey must not be fatal for the button. That is checked deterministically rather than by
// hoping somebody else's hotkey is busy: this process takes two first, so the child cannot have them.
const heldKeys = []
const holder = new Hotkeys()
for (const key of ['ctrl+alt+f8', 'ctrl+alt+f7', 'ctrl+alt+f6', 'ctrl+alt+f5']) {
  if (heldKeys.length === 2) break
  try {
    heldKeys.push(holder.register(key, () => {}).canonical)
  } catch {
    // another application owns this one too
  }
}
check(heldKeys.length === 2, 'this test could take two hotkeys for the conflict check', heldKeys.join(' + ') || 'none available')
if (free) {
const logPath = join(OUTPUT, 'overlay-resident.log')
rmSync(logPath, { force: true })
writeFileSync(logPath, '')
fd = openSync(logPath, 'a')
child = spawn(process.execPath, [
  ENTRY, 'overlay', '--no-beeps', '--language', 'zh',
  ...(heldKeys.length === 2 ? ['--hotkey', heldKeys[0], '--cancel-hotkey', heldKeys[1]] : []),
], {
  cwd: ROOT,
  stdio: ['ignore', fd, fd],
  windowsHide: true,
})
child.on('exit', (code) => { exited = code ?? 0 })
process.on('exit', () => {
  if (exited === null) {
    try {
      child.kill()
    } catch {
      // already gone
    }
  }
})
const readLog = () => readFileSync(logPath, 'utf8')

const ready = await waitFor(() => /the microphone button follows/.test(readLog()), 40000)
check(ready, 'vtt overlay reaches its banner', ready ? '' : readLog().slice(-400))
check(/model ready in/.test(readLog()), 'the model is loaded before the button appears')
if (heldKeys.length === 2) {
  const pattern = heldKeys[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  check(new RegExp(`the global hotkey ${pattern} is already taken`).test(readLog()), 'a hotkey owned by another process is reported, not fatal')
  check(new RegExp(`${pattern}\\s+unavailable`).test(readLog()), 'the banner says which hotkey is unavailable')
}
check(exited === null, 'the overlay process stays resident after printing the banner', `exit ${exited}`)
const live = await waitFor(() => findButtonWindow() !== null, 4000)
check(live, 'the button window exists in the running process')
check(exited === null, 'the button process is still alive')

if (live) {
  // Two posted clicks: start recording, then stop, transcribe and paste. Posted rather than injected,
  // because this sandbox drops synthesized input (see test/hotkey-selftest.mjs).
  const hwnd = findButtonWindow()
  const click = () => {
    postMessage(hwnd, WM.LBUTTONDOWN, 1, 0)
    postMessage(hwnd, WM.LBUTTONUP, 0, 0)
  }
  click()
  const started = await waitFor(() => /recording \(max/.test(readLog()), 4000)
  check(started, 'clicking the button starts recording', started ? '' : readLog().slice(-300))
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1200))
  click()
  const stopped = await waitFor(() => /transcribing/.test(readLog()), 8000)
  check(stopped, 'clicking again stops and transcribes', stopped ? '' : readLog().slice(-300))
  const reported = await waitFor(() => /✔|no speech recognized/.test(readLog()), 30000)
  check(reported, 'the session reports a result', reported ? '' : readLog().slice(-300))
  check(exited === null, 'the overlay stays resident after a transcription')

  // Hiding is what a middle-click does, and it must be real in the window rather than a flag in the
  // child's memory — the user's way back is the tray menu, which reads exactly this visibility.
  const shownBefore = isWindowVisible(hwnd)
  postMessage(hwnd, WM.MBUTTONUP, 0, 0)
  const wentAway = await waitFor(() => isWindowVisible(hwnd) === false, 3000)
  check(shownBefore && wentAway, 'a middle click hides the button in the running process', `visible ${shownBefore} -> ${isWindowVisible(hwnd)}`)
  check(exited === null, 'hiding the button does not end the process', `exit ${exited}`)
  postMessage(hwnd, WM.APP_REVIVE, 0, 0)
  const cameBack = await waitFor(() => isWindowVisible(hwnd) === true, 3000)
  check(cameBack, 'the hidden button comes back on request (the tray menu entry does this)')

  // Running the shortcut a second time must reach the running button instead of refusing with a line
  // nobody can see: the launcher has no console, so stdout goes nowhere and the log stayed empty.
  const again = spawn(process.execPath, [ENTRY, 'overlay', '--log', logPath], { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true })
  await new Promise((resolvePromise) => again.on('exit', resolvePromise))
  const askedAgain = await waitFor(() => /shown again \(another launch\)/.test(readLog()), 4000)
  check(askedAgain, 'a second launch asks the running button to show itself again', askedAgain ? '' : readLog().slice(-300))
  check(/already running/.test(readLog()), 'the second launch records what it did in the log file')
  check(exited === null, 'the second launch does not start a second button')

  // `vtt overlay --stop` from a second process must close it cleanly, without killing anything.
  const stop = spawn(process.execPath, [ENTRY, 'overlay', '--stop'], { cwd: ROOT, stdio: ['ignore', fd, fd], windowsHide: true })
  let stopSaid = ''
  stop.stdout?.on('data', (chunk) => { stopSaid += chunk })
  await new Promise((resolvePromise) => stop.on('exit', resolvePromise))
  const cleaned = await waitFor(() => exited !== null, 8000)
  check(cleaned, 'vtt overlay --stop closes the running button', cleaned ? `exit ${exited}` : readLog().slice(-300))
  check(exited === 0, 'the closed button exits cleanly instead of crashing', `exit ${exited}`)
  check(/button closed|stopping/.test(readLog()), 'the closed button says so in its log')
  check(/asked the floating button to close/.test(readLog()), 'the stop command found the running button')
  check(isWindow(hwnd) === false, 'no button window is left behind')
} else {
  check(false, 'skipped the click checks: no window to click')
}
} // if (free)

if (child && exited === null) {
  child.kill()
  await waitFor(() => exited !== null, 3000)
}
if (fd !== null) closeSync(fd)
holder.dispose()

process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
if (failures > 0) process.exitCode = 1
if (foreignButton) process.stdout.write('NOTE  close the leftover floating button (Task Manager -> node.exe) to run the full suite\n')
