/**
 * The notification-area (tray) icon.
 *
 * A resident tool needs a way out that does not require Task Manager, and a window that never appears
 * in the taskbar needs a visible sign that it is running. The tray icon is both: left-click starts and
 * stops dictation, right-click opens a menu with the button's own commands, including quit.
 *
 * The icon image is rendered by src/raster.mjs — the same microphone glyph as the floating button — so
 * it follows the dictation state and needs no image file next to the source.
 */
import { renderButton } from './raster.mjs'
import { createColorIcon, lastShellError, popupMenu, releaseIcon, trayIcon } from './win32-gui.mjs'

/** Icon size in pixels. The shell scales this down to the size the user configured. */
export const TRAY_ICON_SIZE = 32

/** Commands the tray menu can report back to the button. */
export const TRAY_COMMAND = {
  toggle: 1,
  cancel: 2,
  visibility: 3,
  quit: 4,
}

/**
 * The notification-area tooltip.
 *
 * The labels the user sees are Chinese, matching the rest of the tool's documentation; they are handed
 * to the shell as UTF-16, so no console code page is involved.
 */
export const TRAY_TOOLTIP = '语音转文字 — 左键开始/结束，右键菜单'

/**
 * Build the notification-area menu.
 *
 * Separate from showing it so the entries can be checked without a modal menu on screen.
 * @param {boolean} visible - whether the floating button is currently on screen.
 * @returns {{id?: number, label?: string, separator?: boolean}[]} menu entries in display order.
 */
export function trayMenuItems(visible) {
  return [
    { id: TRAY_COMMAND.toggle, label: '开始 / 结束听写' },
    { id: TRAY_COMMAND.cancel, label: '丢弃这次录音' },
    { separator: true },
    { id: TRAY_COMMAND.visibility, label: visible ? '隐藏悬浮按钮' : '显示悬浮按钮' },
    { separator: true },
    { id: TRAY_COMMAND.quit, label: '退出' },
  ]
}

/**
 * The tray icon belonging to one floating button.
 */
export class TrayIcon {
  /**
   * @param {{window: {handle: object|null}, tooltip?: string, log?: (line: string) => void}} options -
   *   the window whose messages the shell will call back into, and a log sink.
   */
  constructor(options) {
    this.window = options.window
    this.tooltip = options.tooltip ?? TRAY_TOOLTIP
    this.log = options.log ?? (() => {})
    this.icon = null
    this.added = false
    this.visual = 'idle'
  }

  /**
   * Paint the icon for a visual state and tell the shell about it.
   * @param {string} state - `idle`, `hover`, `recording` or `transcribing`.
   * @returns {void}
   */
  paint(state) {
    const next = state === 'hover' ? 'idle' : state
    if (next === this.visual && this.icon) return
    this.visual = next
    const frame = renderButton({ size: TRAY_ICON_SIZE, state: next, shadow: false })
    const icon = createColorIcon(frame.width, frame.height, frame.pixels)
    if (!icon) {
      this.log('! the tray icon could not be rendered')
      return
    }
    if (this.added) trayIcon('update', { hwnd: this.window.handle, icon, tooltip: this.tooltip })
    if (this.icon) releaseIcon(this.icon)
    this.icon = icon
  }

  /**
   * Put the icon in the notification area.
   * @returns {boolean} whether the shell accepted it.
   */
  add() {
    if (this.added || !this.window?.handle) return false
    try {
      this.paint(this.visual)
      this.added = trayIcon('add', { hwnd: this.window.handle, icon: this.icon, tooltip: this.tooltip })
      if (!this.added) {
        const code = lastShellError()
        // 5 is access denied: the shell is there but this process may not talk to it (a low-integrity
        // token, or a different desktop). Saying so beats "the icon did not appear".
        this.log(code === 5
          ? '! the shell refused the notification-area icon (access denied: this process may not talk to the shell)'
          : `! the tray icon was refused by the shell (error ${code})`)
      }
      return this.added
    } catch (error) {
      this.log(`! the tray icon is unavailable: ${error?.message ?? error}`)
      return false
    }
  }

  /**
   * Show the popup menu and return the command the user chose.
   *
   * Must not be called from the window procedure: `TrackPopupMenu` runs its own message loop.
   * @param {boolean} visible - whether the floating button is currently on screen.
   * @returns {number} one of {@link TRAY_COMMAND}, or 0 when the menu was dismissed.
   */
  openMenu(visible) {
    if (!this.window?.handle) return 0
    return popupMenu(this.window.handle, trayMenuItems(visible))
  }

  /** Take the icon out of the notification area and release it. */
  remove() {
    if (this.added) {
      try {
        trayIcon('remove', { hwnd: this.window?.handle ?? null })
      } catch (error) {
        this.log(`! could not remove the tray icon: ${error?.message ?? error}`)
      }
      this.added = false
    }
    releaseIcon(this.icon)
    this.icon = null
  }
}
