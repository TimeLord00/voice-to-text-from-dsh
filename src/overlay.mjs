/**
 * The floating microphone button.
 *
 * One small always-on-top window that parks itself next to the text caret of whatever application has
 * focus — the same affordance an input method gives you. Left-click starts and stops dictation,
 * right-click throws the current recording away, middle-click hides the button (the tray icon brings it
 * back), and dragging it with the left button moves it out of the way (which also stops it from
 * following the caret until the foreground window changes).
 *
 * The window itself is created and painted by src/win32-gui.mjs; this module owns the behaviour: hit
 * testing, dragging, caret following and the visual state. It deliberately shares the message pump
 * with the hotkey listener in src/dictate.mjs — Windows delivers mouse messages to the thread's queue,
 * and one pump draining that queue is simpler and safer than two competing loops.
 *
 * Coordinate note: mouse message lParams carry *client* coordinates, and the window moves during a
 * drag, so both are converted to screen coordinates before any arithmetic. Doing it the other way
 * around makes a dragged window chase its own tail.
 *
 * Placement note: the button is anchored to a caret and to nothing else. It deliberately does *not*
 * follow the pointer — an earlier version re-anchored itself to the cursor whenever the focused window
 * exposed no readable caret (Unity, games and many Electron apps never publish one), which parked the
 * button permanently at the pointer's bottom-right corner and made it impossible to click, because it
 * moved away exactly when the pointer approached. The rules now live in {@link planFollow}.
 */
import { BUTTON_STATES, renderButton } from './raster.mjs'
import { TRAY_COMMAND, TrayIcon } from './tray.mjs'
import { LayeredWindow, WM, buttonAnchor, caretPosition, cursorPosition, dpiScale, dispatchMessage, enableDpiAwareness, foregroundWindow, postMessage } from './win32-gui.mjs'

/** Dictation states the button can reflect, mapped onto the visual states in src/raster.mjs. */
const VISUAL_STATE = { idle: 'idle', recording: 'recording', transcribing: 'transcribing' }

/** Pixels the pointer must travel with the button held down before it counts as a drag. */
const DRAG_THRESHOLD = 6

/** Milliseconds between pointer samples while the button is held down. */
const DRAG_POLL_MS = 16

/** Pixels of slack around the button inside which the pointer freezes every automatic move. */
const POINTER_FREEZE = 8

/** Milliseconds the button stays put after the caret is lost before it steps aside. */
const CARET_GRACE_MS = 1200

/**
 * Whether the pointer is close enough to the button that it must not be moved automatically.
 * @param {{x: number, y: number, width: number, height: number}} rect - the window rectangle.
 * @param {{x: number, y: number}} point - pointer position in screen pixels.
 * @param {number} slack - extra pixels added on every side.
 * @returns {boolean} whether the pointer is inside.
 */
function pointerInside(rect, point, slack) {
  return point.x >= rect.x - slack && point.x <= rect.x + rect.width + slack
    && point.y >= rect.y - slack && point.y <= rect.y + rect.height + slack
}

/**
 * Whether the button should step aside because nothing is being typed into.
 *
 * Four rules keep this from losing the button: it never hides before it has seen a caret at all (so on
 * a desktop whose carets cannot be read it simply stays visible), it never hides while a recording is
 * running or being transcribed, it never hides when `overlay.hideWithoutCaret` is false, and it comes
 * back the moment a caret is found again. Applications that draw their own caret are the reason for
 * the first rule.
 * @param {{overlay?: object, state?: string, source?: string, seenCaret?: boolean, lastCaretAt?: number,
 *   now?: number}} context - configuration and bookkeeping.
 * @returns {boolean} whether to hide the button.
 */
export function shouldStepAside(context) {
  const overlay = context.overlay ?? {}
  if (overlay.hideWithoutCaret === false) return false
  if (context.source === 'caret') return false
  if (!context.seenCaret) return false
  if ((context.state ?? 'idle') !== 'idle') return false
  const grace = overlay.caretGraceMs ?? CARET_GRACE_MS
  return (context.now ?? Date.now()) - (context.lastCaretAt ?? 0) > grace
}

/**
 * Decide what one follow tick should do with the button.
 *
 * Pure on purpose: these rules are the part that went wrong in the field, so they are tested without a
 * desktop (see test/overlay-selftest.mjs). Keeping the mouse away from every automatic move means the
 * button can always be clicked, which is the whole point of it existing.
 * @param {{caret?: object|null, pointer?: {x: number, y: number}|null, window?: object, size: number,
 *   gap?: number, margin?: number, overlay?: object, state?: string, seenCaret?: boolean,
 *   lastCaretAt?: number, now?: number, pinned?: boolean, dragging?: boolean, visible?: boolean,
 *   screen?: object}} context - caret, pointer, window rectangle, configuration and bookkeeping.
 * @returns {{action: 'none'|'move'|'hide', reason: string, sawCaret: boolean, x?: number, y?: number}}
 *   what to do and where to put the window.
 */
export function planFollow(context) {
  const { caret, pointer, window, size, gap = 6, margin = 0, overlay = {}, state = 'idle', now = Date.now() } = context
  const sawCaret = Boolean(caret)
  if (context.dragging) return { action: 'none', reason: 'dragging', sawCaret }
  if (context.pinned) return { action: 'none', reason: 'pinned', sawCaret }
  if (context.visible !== false && window && pointer
    && pointerInside(window, pointer, overlay.pointerFreezePx ?? POINTER_FREEZE)) {
    // Never move out from under the pointer: the button is about to be clicked.
    return { action: 'none', reason: 'pointer', sawCaret }
  }
  if (sawCaret) {
    const anchor = buttonAnchor({ size, gap, caret, screen: context.screen })
    return { action: 'move', reason: 'caret', sawCaret, x: anchor.x - margin, y: anchor.y - margin }
  }
  const aside = shouldStepAside({
    overlay,
    state,
    source: 'cursor',
    seenCaret: context.seenCaret,
    lastCaretAt: context.lastCaretAt,
    now,
  })
  return { action: aside ? 'hide' : 'none', reason: aside ? 'no-caret' : 'stay', sawCaret }
}

/**
 * The microphone button.
 */
export class MicButton {
  /**
   * @param {object} config - effective configuration; `config.overlay` holds the button options.
   * @param {{onToggle?: () => void, onCancel?: () => void, onQuit?: () => void,
   *   log?: (line: string) => void, pump?: {dispatch: Function|null},
   *   pointerAt?: () => {x: number, y: number}}} [options] - callbacks, logging, the shared message
   *   pump and the pointer source (injectable so the drag rules can be tested without a real mouse).
   */
  constructor(config, options = {}) {
    this.config = config
    this.overlay = config.overlay ?? {}
    this.onToggle = options.onToggle ?? (() => {})
    this.onCancel = options.onCancel ?? (() => {})
    this.onQuit = options.onQuit ?? (() => {})
    this.log = options.log ?? (() => {})
    this.pump = options.pump ?? null
    this.pointerAt = options.pointerAt ?? cursorPosition
    this.window = null
    this.tray = null
    this.dictationState = 'idle'
    this.visual = 'idle'
    this.hovered = false
    this.dragging = false
    this.pinned = false
    this.followTimer = null
    this.dragTimer = null
    this.dragOrigin = null
    this.dragStart = null
    this.margin = 0
    this.scale = 1
    this.visualSize = this.overlay.size ?? 46
    this.anchorSource = 'caret'
    this.lastForeground = null
    // Visibility bookkeeping for the "stand next to a caret, step aside otherwise" behaviour.
    this.seenCaret = false
    this.lastCaretAt = 0
  }

  /**
   * Create the window, paint it and start following the caret.
   * @returns {MicButton} this instance.
   */
  mount() {
    if (this.window) return this
    const dpi = enableDpiAwareness()
    this.scale = this.overlay.scale ?? dpiScale()
    this.visualSize = Math.max(20, Math.round((this.overlay.size ?? 46) * this.scale))
    const frame = this.paint('idle')
    this.margin = frame.margin
    this.window = new LayeredWindow({
      title: 'voice-to-text button',
      onMessage: (event, wParam, lParam) => this.handleMouse(event, wParam, lParam),
    })
    this.window.create(frame.width, frame.height)
    this.lastForeground = foregroundWindow()
    const anchor = buttonAnchor({ size: this.visualSize, gap: this.overlay.gap ?? 6 })
    this.anchorSource = anchor.source
    this.window.setFrame(frame, { x: anchor.x - this.margin, y: anchor.y - this.margin })
    if (this.overlay.startVisible !== false) this.window.show()
    if (this.pump) this.pump.dispatch = (message) => dispatchMessage(message)
    if (this.overlay.follow !== false) this.startFollowing()
    if (this.overlay.tray !== false) {
      this.tray = new TrayIcon({ window: this.window, log: this.log })
      if (this.tray.add()) this.log('tray icon ready (left-click dictates, right-click opens the menu)')
    }
    this.log(`mic button ready (${this.visualSize}px at ${Math.round(this.scale * 100)}% scaling, placed by ${anchor.source})`)
    return this
  }

  /**
   * Render one frame for a visual state.
   * @param {string} state - `idle`, `hover`, `recording` or `transcribing`.
   * @returns {{width: number, height: number, margin: number, pixels: Buffer}} the frame.
   */
  paint(state) {
    return renderButton({ size: this.visualSize, state: BUTTON_STATES.includes(state) ? state : 'idle' })
  }

  /**
   * Follow the caret of the focused application.
   * @returns {MicButton} this instance.
   */
  startFollowing() {
    if (this.followTimer) return this
    const interval = this.overlay.followIntervalMs ?? 400
    this.followTimer = setInterval(() => this.follow(), interval)
    this.followTimer.unref?.()
    return this
  }

  /**
   * Move the button to the current caret position.
   *
   * Skips work while dragging, while pinned and while the pointer is on the button. A change of
   * foreground window un-pins it, so it goes back to following the caret in the newly focused
   * application. With no readable caret it stays exactly where it is: see {@link planFollow}.
   * @returns {void}
   */
  follow() {
    if (!this.window) return
    const foreground = foregroundWindow()
    if (foreground !== this.lastForeground) {
      this.lastForeground = foreground
      this.pinned = false
    }
    const now = Date.now()
    const plan = planFollow({
      caret: caretPosition(),
      pointer: cursorPosition(),
      window: {
        x: this.window.position.x,
        y: this.window.position.y,
        width: this.window.width,
        height: this.window.height,
      },
      size: this.visualSize,
      gap: this.overlay.gap ?? 6,
      margin: this.margin,
      overlay: this.overlay,
      state: this.dictationState,
      seenCaret: this.seenCaret,
      lastCaretAt: this.lastCaretAt,
      now,
      pinned: this.pinned,
      dragging: this.dragging,
      visible: this.window.visible,
    })
    if (plan.sawCaret) {
      this.seenCaret = true
      this.lastCaretAt = now
      this.anchorSource = 'caret'
    }
    if (plan.action === 'hide') {
      this.anchorSource = 'none'
      this.window.hide()
      return
    }
    if (plan.action !== 'move') return
    this.window.show()
    if (Math.abs(plan.x - this.window.position.x) < 1 && Math.abs(plan.y - this.window.position.y) < 1) return
    this.window.moveTo(plan.x, plan.y)
  }

  /**
   * Bring the button back on screen and stop it from hiding again straight away.
   *
   * Used when a second launch of the shortcut asks the running button to reappear, and when dictation
   * is started from the hotkey: losing the button with no way back was the second field bug. With
   * nothing being typed into, a revealed button is treated as a fresh start, which is the state where
   * it never hides before it has seen a caret.
   * @param {string} [reason] - why it was revealed, for the log.
   * @returns {MicButton} this instance.
   */
  reveal(reason = 'requested') {
    if (!this.window) return this
    this.pinned = false
    this.seenCaret = Boolean(caretPosition())
    this.lastCaretAt = Date.now()
    this.window.show()
    this.follow()
    this.log(`microphone button shown again (${reason})`)
    return this
  }

  /**
   * Whether the button should step aside because nothing is being typed into.
   * @param {string} source - where the anchor came from ('caret', 'cursor' or 'none').
   * @returns {boolean} whether to hide the button.
   */
  shouldHide(source) {
    return shouldStepAside({
      overlay: this.overlay,
      state: this.dictationState,
      source,
      seenCaret: this.seenCaret,
      lastCaretAt: this.lastCaretAt,
      now: Date.now(),
    })
  }

  /**
   * Update the button's appearance to match the dictation state.
   * @param {string} state - dictation state from src/dictation.mjs.
   * @returns {void}
   */
  setState(state) {
    this.dictationState = state
    this.applyVisual()
  }

  /**
   * Repaint when the state or the hover changed.
   * @returns {void}
   */
  applyVisual() {
    const base = VISUAL_STATE[this.dictationState] ?? 'idle'
    const wanted = base === 'idle' && this.hovered ? 'hover' : base
    if (wanted === this.visual) return
    this.visual = wanted
    if (this.window) this.window.setFrame(this.paint(wanted))
    this.tray?.paint(wanted)
  }

  /**
   * Handle a window mouse event.
   * @param {string} event - `left-down`, `left-up`, `right-up`, `middle-up`, `move`, `mouse-leave`,
   *   `capture-lost`, `close`, `revive` or `tray`.
   * @param {number} wParam - mouse key flags.
   * @param {number} lParam - packed client coordinates, or the mouse message for `tray`.
   * @returns {void}
   */
  handleMouse(event, wParam, lParam) {
    switch (event) {
      case 'left-down':
        this.beginDrag()
        return
      case 'move':
        // Windows holds capture during a press, so moves keep arriving; the poll started by beginDrag
        // means the drag still works even if one of them is lost.
        if (this.dragging || this.dragStart) this.applyDrag()
        if (!this.hovered) {
          this.hovered = true
          this.applyVisual()
        }
        return
      case 'mouse-leave':
        this.hovered = false
        this.applyVisual()
        return
      case 'left-up':
        this.endDrag()
        return
      case 'capture-lost':
        // Losing capture before the button is released is not the end of the press: the drag poll and
        // the pointer decide that, in endDrag().
        if (!this.dragStart) this.dragging = false
        return
      case 'right-up':
        this.defer(this.onCancel)
        return
      case 'middle-up':
        // Hiding, not quitting: a stray middle-click must never kill the tool. Quitting is a menu
        // command (the tray icon, or `vtt overlay --stop`).
        this.defer(() => this.setVisible(false, 'middle-click'))
        return
      case 'close':
        // Another process ran `vtt overlay --stop`, or Windows asked the window to go away.
        this.defer(this.onQuit)
        return
      case 'revive':
        // Another process launched the shortcut while this button was already running and could not
        // be seen: show it again instead of leaving the user with a second, invisible instance.
        this.defer(() => this.reveal('another launch'))
        return
      case 'tray':
        this.handleTray(lParam)
        return
      default:
    }
  }

  /**
   * Handle a click on the tray icon.
   *
   * The shell reports the mouse message in lParam. A menu must not be opened here: the window
   * procedure runs on a native callback frame, and `TrackPopupMenu` starts a message loop of its own,
   * so both paths go through {@link defer}.
   * @param {number} lParam - the mouse message the shell reported.
   * @returns {void}
   */
  handleTray(lParam) {
    if (!this.tray) return
    if (lParam === WM.RBUTTONUP || lParam === WM.CONTEXTMENU) {
      this.defer(() => this.openTrayMenu())
      return
    }
    if (lParam === WM.LBUTTONUP) this.defer(this.onToggle)
  }

  /**
   * Show the tray menu and run the command the user picked.
   * @returns {void}
   */
  openTrayMenu() {
    if (!this.tray) return
    const chosen = this.tray.openMenu(Boolean(this.window?.visible))
    switch (chosen) {
      case TRAY_COMMAND.toggle:
        this.defer(this.onToggle)
        return
      case TRAY_COMMAND.cancel:
        this.defer(this.onCancel)
        return
      case TRAY_COMMAND.visibility:
        this.defer(() => this.toggleVisible())
        return
      case TRAY_COMMAND.quit:
        this.defer(this.onQuit)
        return
      default:
    }
  }

  /**
   * Show or hide the button without ending the session.
   *
   * Hiding is what a middle-click does and what the tray menu's 隐藏悬浮按钮 entry does; the button then
   * comes back from that same menu entry, from the dictation hotkey, or from launching the shortcut
   * again. Quitting stays a deliberate menu command, so the icon can never be lost for good.
   * @param {boolean} visible - wanted visibility.
   * @param {string} [reason] - short note for the log.
   * @returns {boolean} whether the button is visible afterwards.
   */
  setVisible(visible, reason = 'requested') {
    if (!this.window) return false
    if (!visible) {
      this.window.hide()
      this.log(`microphone button hidden (${reason}); the tray icon brings it back`)
      return false
    }
    this.reveal(reason)
    return true
  }

  /**
   * Show or hide the button from the tray menu.
   * @returns {boolean} whether the button is visible afterwards.
   */
  toggleVisible() {
    if (!this.window) return false
    return this.setVisible(!this.window.visible, 'tray menu')
  }

  /**
   * Start a press: remember where the window and the pointer were.
   * @returns {void}
   */
  beginDrag() {
    this.dragging = false
    this.dragOrigin = { x: this.window.position.x, y: this.window.position.y }
    this.dragStart = this.pointerAt()
    if (!this.dragTimer) {
      this.dragTimer = setInterval(() => this.applyDrag(), DRAG_POLL_MS)
    }
  }

  /**
   * Finish a press: pin the button when it was dragged, otherwise treat it as a click.
   *
   * The decision is made from the pointer, not from the move messages alone: a press whose moves never
   * arrived (or were swallowed) would otherwise be classified as a click, which is exactly how dragging
   * the button started a recording in the field.
   * @returns {void}
   */
  endDrag() {
    if (this.dragTimer) {
      clearInterval(this.dragTimer)
      this.dragTimer = null
    }
    const press = this.dragStart
    const threshold = this.overlay.dragThresholdPx ?? DRAG_THRESHOLD
    this.dragStart = null
    if (!this.dragging && press) {
      const now = this.pointerAt()
      if (now && Math.hypot(now.x - press.x, now.y - press.y) >= threshold) this.dragging = true
    }
    const travelled = this.dragOrigin && this.window
      ? Math.hypot(this.window.position.x - this.dragOrigin.x, this.window.position.y - this.dragOrigin.y)
      : 0
    if (this.dragging || travelled >= threshold) {
      this.dragging = false
      this.pinned = true
      this.log(`button pinned at ${this.window.position.x},${this.window.position.y} (drag it to move it, middle-click hides it)`)
      return
    }
    this.defer(this.onToggle)
  }

  /**
   * Apply one drag step from the current pointer position.
   * @returns {boolean} whether the button moved.
   */
  applyDrag() {
    if (!this.dragStart || !this.window) return false
    const now = this.pointerAt()
    if (!now) return false
    const dx = now.x - this.dragStart.x
    const dy = now.y - this.dragStart.y
    if (!this.dragging && Math.hypot(dx, dy) < (this.overlay.dragThresholdPx ?? DRAG_THRESHOLD)) return false
    this.dragging = true
    this.window.moveTo(this.dragOrigin.x + dx, this.dragOrigin.y + dy)
    return true
  }

  /**
   * Run a callback on the next event-loop tick instead of inside the window procedure.
   *
   * The procedure is invoked from `DispatchMessageW`, i.e. on a native callback frame, and a click
   * there leads straight into the recorder and an ONNX inference. Doing that work on this stack was
   * observed to abort the process (0xC0000005) after a recording, and a teardown started from here
   * would destroy the window from inside its own message handler. The message handler therefore only
   * decides *what* happened; the work happens one tick later.
   * @param {() => void} callback - callback to run.
   * @returns {void}
   */
  defer(callback) {
    setImmediate(() => {
      try {
        callback()
      } catch (error) {
        this.log(`! ${error?.message ?? error}`)
      }
    })
  }

  /**
   * Click the button programmatically, as the self-test does.
   * @returns {void}
   */
  click() {
    if (!this.window?.handle) throw new Error('the button is not mounted')
    postMessage(this.window.handle, WM.LBUTTONDOWN, 1, 0)
    postMessage(this.window.handle, WM.LBUTTONUP, 0, 0)
  }

  /** @returns {object|null} the underlying window handle, for diagnostics. */
  get handle() {
    return this.window?.handle ?? null
  }

  /** Stop following, release the pump, remove the tray icon and destroy the window. */
  dispose() {
    if (this.followTimer) {
      clearInterval(this.followTimer)
      this.followTimer = null
    }
    if (this.dragTimer) {
      clearInterval(this.dragTimer)
      this.dragTimer = null
    }
    this.dragStart = null
    this.tray?.remove()
    this.tray = null
    if (this.pump?.dispatch) this.pump.dispatch = null
    this.window?.dispose()
    this.window = null
  }
}
