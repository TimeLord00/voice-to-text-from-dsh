/**
 * The window half of the Win32 layer: layered (per-pixel alpha) windows, caret lookup and the
 * GDI plumbing that pushes a rasterized frame onto the screen.
 *
 * It is kept apart from src/win32.mjs on purpose — that module is the documented, already-verified
 * microphone/hotkey/clipboard path, and nothing here is needed to transcribe audio. Only the floating
 * button imports this file.
 *
 * Design notes that cost real debugging time and are therefore worth writing down:
 *
 * - The window is `WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE` and paints
 *   through `UpdateLayeredWindow`. Showing it that way does not move the foreground window and does
 *   not steal focus, which is the whole point: dictation must not interrupt the application the user
 *   is typing into.
 * - `WM_MOUSEACTIVATE` must answer `MA_NOACTIVATE`; without it Windows activates the button on click
 *   and the caret in the target application disappears.
 * - `WM_PAINT` must be answered with `BeginPaint`/`EndPaint`. Returning 0 without validating the
 *   update region leaves the window permanently invalid, so the message pump spins on `WM_PAINT`
 *   forever and every timer behind it starves.
 * - DIB sections are created top-down (`biHeight = -height`) so the raster buffer row order matches
 *   the canvas in src/raster.mjs and can be copied in one go.
 */
import koffi from 'koffi'

/** Window messages this module reacts to. */
export const WM = {
  PAINT: 0x000f,
  SETCURSOR: 0x0020,
  MOUSEACTIVATE: 0x0021,
  LBUTTONDOWN: 0x0201,
  LBUTTONUP: 0x0202,
  RBUTTONDOWN: 0x0204,
  RBUTTONUP: 0x0205,
  MBUTTONDOWN: 0x0207,
  MBUTTONUP: 0x0208,
  CAPTURECHANGED: 0x0215,
  MOUSEMOVE: 0x0200,
  MOUSELEAVE: 0x02a3,
  DESTROY: 0x0002,
  CLOSE: 0x0010,
  /** Private message (WM_APP + 1) a second launch posts to ask a running button to reappear. */
  APP_REVIVE: 0x8001,
  /** Sent instead of WM_RBUTTONUP for some shell versions. */
  CONTEXTMENU: 0x007b,
  /** Delivered by the shell when the tray icon is clicked; lParam is the mouse message. */
  APP_TRAY: 0x8002,
}

const WS_EX_LAYERED = 0x00080000
const WS_EX_TOPMOST = 0x00000008
const WS_EX_TOOLWINDOW = 0x00000080
const WS_EX_NOACTIVATE = 0x08000000
const WS_POPUP = 0x80000000
const SW_SHOWNOACTIVATE = 4
const SW_HIDE = 0
const SWP_NOACTIVATE = 0x0010
const SWP_SHOWWINDOW = 0x0040
const HWND_TOPMOST = -1
const ULW_ALPHA = 0x00000002
const AC_SRC_OVER = 0
const AC_SRC_ALPHA = 1
const MA_NOACTIVATE = 3
const DIB_RGB_COLORS = 0
const TME_LEAVE = 0x00000002
const IDC_HAND = 32649
const LOGPIXELSX = 88
const SM_XVIRTUALSCREEN = 76
const SM_YVIRTUALSCREEN = 77
const SM_CXVIRTUALSCREEN = 78
const SM_CYVIRTUALSCREEN = 79
const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
const WM_NULL = 0x0000
const NIM_ADD = 0x00000000
const NIM_MODIFY = 0x00000001
const NIM_DELETE = 0x00000002
const NIF_MESSAGE = 0x00000001
const NIF_ICON = 0x00000002
const NIF_TIP = 0x00000004
const MF_STRING = 0x00000000
const MF_SEPARATOR = 0x00000800
const TPM_RETURNCMD = 0x0100
const TPM_NONOTIFY = 0x0080
const TPM_RIGHTBUTTON = 0x0002
const PROCESS_TERMINATE = 0x0001
/** Bytes NOTIFYICONDATAW occupies on x64; a mismatch means the declaration below is wrong. */
const NOTIFYICONDATAW_SIZE = 1360

/** Offset of each MSG field, in bytes (x64). */
const MSG_MESSAGE = 8
const MSG_WPARAM = 16

/** @type {object|null} lazily loaded bindings, structures and helper handles. */
let nativeLibs = null

/** Win32 error of the last refused notification-area request; see {@link lastShellError}. */
let shellError = 0

/**
 * Load the Win32 bindings on first use.
 * @returns {object} bindings, structures and the module handle.
 */
function native() {
  if (nativeLibs) return nativeLibs
  const user32 = koffi.load('user32.dll')
  const gdi32 = koffi.load('gdi32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const shell32 = koffi.load('shell32.dll')

  const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
  const POINT = koffi.struct('POINT', { x: 'long', y: 'long' })
  const SIZE = koffi.struct('SIZE', { cx: 'long', cy: 'long' })
  const BLENDFUNCTION = koffi.struct('BLENDFUNCTION', {
    BlendOp: 'uchar', BlendFlags: 'uchar', SourceConstantAlpha: 'uchar', AlphaFormat: 'uchar',
  })
  const GUITHREADINFO = koffi.struct('GUITHREADINFO', {
    cbSize: 'uint',
    flags: 'uint',
    hwndActive: 'void *',
    hwndFocus: 'void *',
    hwndCapture: 'void *',
    hwndMenuOwner: 'void *',
    hwndMoveSize: 'void *',
    hwndCaret: 'void *',
    rcCaret: RECT,
  })
  const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
    biSize: 'uint', biWidth: 'long', biHeight: 'long', biPlanes: 'ushort', biBitCount: 'ushort',
    biCompression: 'uint', biSizeImage: 'uint', biXPelsPerMeter: 'long', biYPelsPerMeter: 'long',
    biClrUsed: 'uint', biClrImportant: 'uint',
  })
  const BITMAPINFO = koffi.struct('BITMAPINFO', { bmiHeader: BITMAPINFOHEADER, bmiColors: koffi.array('uint', 3) })
  const PAINTSTRUCT = koffi.struct('PAINTSTRUCT', {
    hdc: 'void *', fErase: 'int', rcPaint: RECT, fRestore: 'int', fIncUpdate: 'int', rgbReserved: koffi.array('uchar', 32),
  })
  const WNDCLASSEXW = koffi.struct('WNDCLASSEXW', {
    cbSize: 'uint', style: 'uint', lpfnWndProc: 'void *', cbClsExtra: 'int', cbWndExtra: 'int',
    hInstance: 'void *', hIcon: 'void *', hCursor: 'void *', hbrBackground: 'void *',
    lpszMenuName: 'void *', lpszClassName: 'void *', hIconSm: 'void *',
  })
  const TRACKMOUSEEVENT = koffi.struct('TRACKMOUSEEVENT', {
    cbSize: 'uint', dwFlags: 'uint', hwndTrack: 'void *', dwHoverTime: 'uint',
  })
  const WNDPROC = koffi.proto('intptr_t WndProc(void *hwnd, unsigned int msg, size_t wParam, intptr_t lParam)')
  const GUID = koffi.struct('GUID', {
    Data1: 'uint', Data2: 'ushort', Data3: 'ushort', Data4: koffi.array('uchar', 8),
  })
  const ICONINFO = koffi.struct('ICONINFO', {
    fIcon: 'int', xHotspot: 'uint', yHotspot: 'uint', hbmMask: 'void *', hbmColor: 'void *',
  })
  // The full version-4 layout: Windows validates cbSize against the sizes it knows, so declaring the
  // structure exactly is what makes the tray icon appear at all.
  const NOTIFYICONDATAW = koffi.struct('NOTIFYICONDATAW', {
    cbSize: 'uint',
    hWnd: 'void *',
    uID: 'uint',
    uFlags: 'uint',
    uCallbackMessage: 'uint',
    hIcon: 'void *',
    szTip: koffi.array('uint16', 128),
    dwState: 'uint',
    dwStateMask: 'uint',
    szInfo: koffi.array('uint16', 256),
    uVersion: 'uint',
    szInfoTitle: koffi.array('uint16', 256),
    dwInfoFlags: 'uint',
    guidItem: GUID,
    hBalloonIcon: 'void *',
  })

  nativeLibs = {
    koffi,
    user32,
    gdi32,
    RECT,
    POINT,
    SIZE,
    BLENDFUNCTION,
    GUITHREADINFO,
    BITMAPINFOHEADER,
    BITMAPINFO,
    PAINTSTRUCT,
    WNDCLASSEXW,
    TRACKMOUSEEVENT,
    WNDPROC,
    GUID,
    ICONINFO,
    NOTIFYICONDATAW,
    // user32
    RegisterClassExW: user32.func('unsigned short RegisterClassExW(_In_ WNDCLASSEXW *wc)'),
    CreateWindowExW: user32.func('void *CreateWindowExW(unsigned int exStyle, void *className, void *windowName, unsigned int style, int x, int y, int w, int h, void *parent, void *menu, void *instance, void *param)'),
    FindWindowW: user32.func('void *FindWindowW(str16 className, str16 windowName)'),
    IsWindow: user32.func('int IsWindow(void *hwnd)'),
    IsWindowVisible: user32.func('int IsWindowVisible(void *hwnd)'),
    DefWindowProcW: user32.func('intptr_t DefWindowProcW(void *hwnd, unsigned int msg, size_t wParam, intptr_t lParam)'),
    DestroyWindow: user32.func('int DestroyWindow(void *hwnd)'),
    ShowWindow: user32.func('int ShowWindow(void *hwnd, int cmd)'),
    SetWindowPos: user32.func('int SetWindowPos(void *hwnd, void *after, int x, int y, int cx, int cy, unsigned int flags)'),
    GetForegroundWindow: user32.func('void *GetForegroundWindow()'),
    GetWindowThreadProcessId: user32.func('unsigned int GetWindowThreadProcessId(void *hwnd, _Out_ unsigned int *pid)'),
    GetGUIThreadInfo: user32.func('int GetGUIThreadInfo(unsigned int threadId, _Inout_ GUITHREADINFO *info)'),
    ClientToScreen: user32.func('int ClientToScreen(void *hwnd, _Inout_ POINT *point)'),
    GetCursorPos: user32.func('int GetCursorPos(_Out_ POINT *point)'),
    GetClassNameW: user32.func('int GetClassNameW(void *hwnd, _Out_ void *buffer, int max)'),
    GetSystemMetrics: user32.func('int GetSystemMetrics(int index)'),
    LoadCursorW: user32.func('void *LoadCursorW(void *instance, void *name)'),
    SetCapture: user32.func('void *SetCapture(void *hwnd)'),
    ReleaseCapture: user32.func('int ReleaseCapture()'),
    TrackMouseEvent: user32.func('int TrackMouseEvent(_Inout_ TRACKMOUSEEVENT *event)'),
    GetDC: user32.func('void *GetDC(void *hwnd)'),
    ReleaseDC: user32.func('int ReleaseDC(void *hwnd, void *dc)'),
    BeginPaint: user32.func('void *BeginPaint(void *hwnd, _Out_ PAINTSTRUCT *ps)'),
    EndPaint: user32.func('int EndPaint(void *hwnd, _In_ PAINTSTRUCT *ps)'),
    UpdateLayeredWindow: user32.func('int UpdateLayeredWindow(void *hwnd, void *dstDc, _In_ POINT *dst, _In_ SIZE *size, void *srcDc, _In_ POINT *src, unsigned int key, _In_ BLENDFUNCTION *blend, unsigned int flags)'),
    PeekMessageW: user32.func('int PeekMessageW(_Out_ void *msg, void *hwnd, unsigned int filterMin, unsigned int filterMax, unsigned int remove)'),
    TranslateMessage: user32.func('int TranslateMessage(_In_ void *msg)'),
    DispatchMessageW: user32.func('intptr_t DispatchMessageW(_In_ void *msg)'),
    PostMessageW: user32.func('int PostMessageW(void *hwnd, unsigned int msg, size_t wParam, intptr_t lParam)'),
    SetProcessDPIAware: user32.func('int SetProcessDPIAware()'),
    SetProcessDpiAwarenessContext: user32.func('int SetProcessDpiAwarenessContext(void *context)'),
    // gdi32
    CreateCompatibleDC: gdi32.func('void *CreateCompatibleDC(void *dc)'),
    CreateDIBSection: gdi32.func('void *CreateDIBSection(void *dc, _In_ BITMAPINFO *info, unsigned int usage, _Out_ void **bits, void *section, unsigned int offset)'),
    SelectObject: gdi32.func('void *SelectObject(void *dc, void *object)'),
    DeleteObject: gdi32.func('int DeleteObject(void *object)'),
    DeleteDC: gdi32.func('int DeleteDC(void *dc)'),
    GetDeviceCaps: gdi32.func('int GetDeviceCaps(void *dc, int index)'),
    CreateBitmap: gdi32.func('void *CreateBitmap(int width, int height, unsigned int planes, unsigned int bits, void *bits)'),
    // shell32
    Shell_NotifyIconW: shell32.func('int Shell_NotifyIconW(unsigned int message, _In_ NOTIFYICONDATAW *data)'),
    // user32, tray and menus
    CreateIconIndirect: user32.func('void *CreateIconIndirect(_In_ ICONINFO *info)'),
    DestroyIcon: user32.func('int DestroyIcon(void *icon)'),
    CreatePopupMenu: user32.func('void *CreatePopupMenu()'),
    AppendMenuW: user32.func('int AppendMenuW(void *menu, unsigned int flags, size_t id, void *text)'),
    TrackPopupMenu: user32.func('int TrackPopupMenu(void *menu, unsigned int flags, int x, int y, int reserved, void *hwnd, void *rect)'),
    DestroyMenu: user32.func('int DestroyMenu(void *menu)'),
    SetForegroundWindow: user32.func('int SetForegroundWindow(void *hwnd)'),
    // kernel32
    GetModuleHandleW: kernel32.func('void *GetModuleHandleW(void *name)'),
    OpenProcess: kernel32.func('void *OpenProcess(unsigned int access, int inherit, unsigned int pid)'),
    TerminateProcess: kernel32.func('int TerminateProcess(void *process, unsigned int code)'),
    CloseHandle: kernel32.func('int CloseHandle(void *handle)'),
    GetLastError: kernel32.func('uint32 GetLastError()'),
  }
  nativeLibs.classAtom = 0
  nativeLibs.windows = new Map()
  nativeLibs.instance = null
  return nativeLibs
}

/**
 * Turn the process DPI aware so the button is rendered at the display's real pixel density instead of
 * being bitmap-stretched by Windows. Must run before any window is created.
 * @returns {number} the resulting dots-per-inch, or 0 when it cannot be determined.
 */
export function enableDpiAwareness() {
  const { SetProcessDpiAwarenessContext, SetProcessDPIAware, GetDeviceCaps, GetDC, ReleaseDC } = native()
  try {
    if (!SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) SetProcessDPIAware()
  } catch {
    // Both entry points are absent on very old Windows; the default scaling still works.
  }
  const screenDc = GetDC(null)
  if (!screenDc) return 0
  try {
    return GetDeviceCaps(screenDc, LOGPIXELSX)
  } finally {
    ReleaseDC(null, screenDc)
  }
}

/**
 * The display scaling factor in use, e.g. 1.25 at 120 DPI.
 * @returns {number} scale factor, at least 1.
 */
export function dpiScale() {
  const { GetDeviceCaps, GetDC, ReleaseDC } = native()
  const screenDc = GetDC(null)
  if (!screenDc) return 1
  try {
    const dpi = GetDeviceCaps(screenDc, LOGPIXELSX)
    return dpi > 0 ? dpi / 96 : 1
  } finally {
    ReleaseDC(null, screenDc)
  }
}

/**
 * The current pointer position in physical screen pixels.
 * @returns {{x: number, y: number}|null} pointer position, or null when unavailable.
 */
export function cursorPosition() {
  const { GetCursorPos } = native()
  const point = {}
  return GetCursorPos(point) ? { x: point.x, y: point.y } : null
}

/**
 * Bounds of the whole virtual desktop, covering every monitor.
 * @returns {{x: number, y: number, width: number, height: number}} virtual screen rectangle.
 */
export function virtualScreen() {
  const { GetSystemMetrics } = native()
  return {
    x: GetSystemMetrics(SM_XVIRTUALSCREEN),
    y: GetSystemMetrics(SM_YVIRTUALSCREEN),
    width: GetSystemMetrics(SM_CXVIRTUALSCREEN) || 1920,
    height: GetSystemMetrics(SM_CYVIRTUALSCREEN) || 1080,
  }
}

/**
 * The window that currently has the foreground, i.e. the one dictation types into.
 * @returns {object|null} window handle, or null when nothing has focus.
 */
export function foregroundWindow() {
  return native().GetForegroundWindow()
}

/**
 * Class name of a window, used in logs to name the target application.
 * @param {object} hwnd - window handle.
 * @returns {string} class name, or an empty string.
 */
export function windowClassName(hwnd) {
  if (!hwnd) return ''
  const { GetClassNameW, koffi: k } = native()
  const buffer = Buffer.alloc(256 * 2)
  const length = GetClassNameW(hwnd, buffer, 256)
  return length > 0 ? k.decode.string16(buffer) : ''
}

/**
 * Locate the text caret of the window that has focus, in screen coordinates.
 *
 * `GetGUIThreadInfo` reports the caret of any thread, which is what makes this work across
 * applications: Windows publishes the caret rectangle of the focused thread, and a background process
 * may read it without attaching to that thread.
 *
 * @returns {{x: number, y: number, height: number, hwnd: object, threadId: number}|null} caret
 *   position (its bottom-left corner) or null when the focused window has no caret.
 */
export function caretPosition() {
  const { GetForegroundWindow, GetWindowThreadProcessId, GetGUIThreadInfo, ClientToScreen, GUITHREADINFO, koffi: k } = native()
  const window = GetForegroundWindow()
  if (!window) return null
  const threadId = GetWindowThreadProcessId(window, null)
  if (!threadId) return null
  const info = { cbSize: k.sizeof(GUITHREADINFO) }
  if (!GetGUIThreadInfo(threadId, info)) return null
  if (!info.hwndCaret || info.rcCaret.right <= info.rcCaret.left) return null
  const point = { x: info.rcCaret.left, y: info.rcCaret.bottom }
  if (!ClientToScreen(info.hwndCaret, point)) return null
  return {
    x: point.x,
    y: point.y,
    height: Math.max(1, info.rcCaret.bottom - info.rcCaret.top),
    hwnd: info.hwndCaret,
    threadId,
  }
}

/**
 * Work out where to put a button of a given size.
 *
 * Preference order: next to the caret of the focused window (the input-method behaviour the tool is
 * modelled on), otherwise next to the pointer, clamped into the virtual screen. When the caret sits
 * too close to the right edge the button flips to the caret's left.
 *
 * @param {{size: number, gap?: number, clamp?: boolean, caret?: object|null, cursor?: object|null,
 *   screen?: object}} options - size and spacing. `caret`, `cursor` and `screen` override what is read
 *   from the desktop and exist so the placement maths can be tested without a text field on screen.
 * @returns {{x: number, y: number, source: 'caret'|'cursor'}} top-left corner in screen pixels.
 */
export function buttonAnchor(options) {
  const size = options.size
  const gap = options.gap ?? 6
  const caret = options.caret !== undefined ? options.caret : caretPosition()
  let x
  let y
  let source = 'caret'
  if (caret) {
    const screen = options.screen ?? virtualScreen()
    const caretCentre = caret.y - caret.height / 2
    x = caret.x + gap
    y = Math.round(caretCentre - size / 2)
    if (x + size > screen.x + screen.width - 2) x = caret.x - gap - size
  } else {
    source = 'cursor'
    const cursor = options.cursor !== undefined ? options.cursor : cursorPosition()
    if (!cursor) return { x: 0, y: 0, source }
    x = cursor.x + gap
    y = cursor.y + gap
  }
  if (options.clamp === false) return { x: Math.round(x), y: Math.round(y), source }
  const screen = options.screen ?? virtualScreen()
  const margin = 2
  return {
    x: Math.round(Math.min(Math.max(x, screen.x + margin), screen.x + screen.width - size - margin)),
    y: Math.round(Math.min(Math.max(y, screen.y + margin), screen.y + screen.height - size - margin)),
    source,
  }
}

/**
 * Push one queued message through the window procedure.
 *
 * The hotkey pump in src/win32.mjs owns the message queue for the whole process, so it calls this for
 * every message that is not a hotkey. `TranslateMessage` is included even though the button has no
 * keyboard input, so future text input keeps working.
 * @param {Buffer} message - the MSG buffer filled by PeekMessage.
 * @returns {void}
 */
export function dispatchMessage(message) {
  const { TranslateMessage, DispatchMessageW } = native()
  TranslateMessage(message)
  DispatchMessageW(message)
}

/**
 * Read the message id out of a raw MSG buffer.
 * @param {Buffer} message - the MSG buffer.
 * @returns {number} message id, e.g. 0x0201.
 */
export function messageId(message) {
  return koffi.decode(message, MSG_MESSAGE, 'uint32')
}

/**
 * Read the wParam of a raw MSG buffer.
 * @param {Buffer} message - the MSG buffer.
 * @returns {number} wParam.
 */
export function messageParam(message) {
  return Number(koffi.decode(message, MSG_WPARAM, 'uint64'))
}

/**
 * Post a message to a window. Used by the self-test to click the button without a mouse.
 * @param {object} hwnd - target window.
 * @param {number} message - message id.
 * @param {number} [wParam] - wParam.
 * @param {number} [lParam] - lParam.
 * @returns {boolean} whether the message was queued.
 */
export function postMessage(hwnd, message, wParam = 0, lParam = 0) {
  return Boolean(native().PostMessageW(hwnd, message, wParam, lParam))
}

/**
 * Window class every instance of the floating button registers.
 *
 * `VTT_BUTTON_CLASS` overrides it so a second build can run beside a button that is already on the
 * desktop; the self-test uses that to stay independent of a leftover instance from an earlier session.
 * Read on every call rather than cached, so a caller can set it before the first window is created.
 * @returns {string} the class name.
 */
export function buttonClass() {
  return process.env.VTT_BUTTON_CLASS || 'VttMicButton'
}

/**
 * Whether a window handle still refers to a live window.
 *
 * `findButtonWindow()` searches the whole desktop by class name, so it also finds a button belonging
 * to another process — which is why the self-test asks this about its own handle instead.
 * @param {object} hwnd - window handle.
 * @returns {boolean} whether the window exists.
 */
export function isWindow(hwnd) {
  if (!hwnd) return false
  return Boolean(native().IsWindow(hwnd))
}

/**
 * Whether a window handle refers to a window that is currently shown.
 *
 * A hidden button still exists (that is the point of hiding rather than closing it), so `isWindow()`
 * cannot tell the two apart. This is the check that says "the icon really disappeared from the screen".
 * @param {object} hwnd - window handle.
 * @returns {boolean} whether the window is visible.
 */
export function isWindowVisible(hwnd) {
  if (!hwnd) return false
  return Boolean(native().IsWindowVisible(hwnd))
}

/**
 * Whether this session has a shell (the taskbar) to put an icon in.
 *
 * `Shell_NotifyIconW` can only add an icon to a notification area that exists. In a session without
 * explorer.exe — which is how this tool's own test harness sometimes runs — the call fails, and that is
 * the environment rather than the tool, so callers report it instead of treating it as a defect.
 * @returns {boolean} true when the taskbar window is present.
 */
export function shellPresent() {
  return Boolean(native().FindWindowW('Shell_TrayWnd', null))
}

/**
 * Find a running floating button, whoever started it.
 * @returns {object|null} its window handle, or null when no button is on screen.
 */
export function findButtonWindow() {
  const hwnd = native().FindWindowW(buttonClass(), null)
  return hwnd ? hwnd : null
}

/**
 * Ask a running floating button to close, by posting WM_CLOSE to it. Works across processes, which is
 * what makes `vtt overlay --stop` possible while the button is shown without a console window.
 *
 * The three outcomes are distinguished because they are not the same thing to a user: `unreachable`
 * is what a button owned by another account or a higher privilege level looks like (Windows blocks the
 * post), and reporting that as "no button is running" sent the first investigation of two leftover
 * instances in the wrong direction.
 * @returns {'closed'|'unreachable'|'none'} what happened.
 */
export function closeButtonWindow() {
  const hwnd = findButtonWindow()
  if (!hwnd) return 'none'
  return postMessage(hwnd, WM.CLOSE, 0, 0) ? 'closed' : 'unreachable'
}

/**
 * Ask a running floating button to show itself again, by posting a private message to it.
 *
 * A second launch of the shortcut used to be refused with a line on stdout, which is invisible when
 * the first instance was started by the hidden launcher (no console) — so a button that had stepped
 * aside could not be brought back at all. Posting works across processes, exactly like WM_CLOSE does
 * for `vtt overlay --stop`.
 * @returns {boolean} whether a button was found and asked to reappear.
 */
export function reviveButtonWindow() {
  const hwnd = findButtonWindow()
  if (!hwnd) return false
  return postMessage(hwnd, WM.APP_REVIVE, 0, 0)
}

/**
 * Pack a string into the fixed-size UTF-16 array a Win32 structure expects.
 * @param {string} text - the text to store.
 * @param {number} length - array length in code units, including the terminator.
 * @returns {number[]} NUL-padded code units.
 */
function utf16Units(text, length) {
  const units = new Array(length).fill(0)
  const clipped = String(text ?? '').slice(0, length - 1)
  for (let index = 0; index < clipped.length; index += 1) units[index] = clipped.charCodeAt(index)
  return units
}

/**
 * Build a tray icon from premultiplied BGRA pixels, the same layout src/raster.mjs produces.
 *
 * The colour bitmap is a top-down 32-bit DIB section, which is what carries the alpha channel; the
 * mask is a zeroed monochrome bitmap, which tells the shell to use that alpha. Both bitmaps are
 * returned with the icon so they can be released together — deleting them before the icon is
 * destroyed is the one thing that is not obviously safe.
 * @param {number} width - icon width in pixels.
 * @param {number} height - icon height in pixels.
 * @param {Buffer} pixels - premultiplied BGRA, `width * height * 4` bytes.
 * @returns {{handle: object, bitmap: object, mask: object}|null} the icon, or null when it failed.
 */
export function createColorIcon(width, height, pixels) {
  const libs = native()
  if (pixels.length !== width * height * 4) {
    throw new Error(`icon pixels are ${pixels.length} bytes but claim ${width}x${height}`)
  }
  const screenDc = libs.GetDC(null)
  const info = {
    bmiHeader: {
      biSize: koffi.sizeof(libs.BITMAPINFOHEADER),
      biWidth: width,
      biHeight: -height,
      biPlanes: 1,
      biBitCount: 32,
      biCompression: 0,
      biSizeImage: 0,
      biXPelsPerMeter: 0,
      biYPelsPerMeter: 0,
      biClrUsed: 0,
      biClrImportant: 0,
    },
    bmiColors: [0, 0, 0],
  }
  const bitsOut = [null]
  const bitmap = libs.CreateDIBSection(screenDc, info, DIB_RGB_COLORS, bitsOut, null, 0)
  libs.ReleaseDC(null, screenDc)
  if (!bitmap) return null
  new Uint8Array(koffi.view(bitsOut[0], pixels.length)).set(pixels)
  const mask = libs.CreateBitmap(width, height, 1, 1, null)
  const handle = libs.CreateIconIndirect({ fIcon: 1, xHotspot: 0, yHotspot: 0, hbmMask: mask, hbmColor: bitmap })
  if (!handle) {
    libs.DeleteObject(bitmap)
    if (mask) libs.DeleteObject(mask)
    return null
  }
  return { handle, bitmap, mask }
}

/**
 * Release an icon created by {@link createColorIcon}.
 * @param {{handle: object, bitmap: object, mask: object}|null} icon - the icon.
 * @returns {void}
 */
export function releaseIcon(icon) {
  if (!icon) return
  const libs = native()
  if (icon.handle) libs.DestroyIcon(icon.handle)
  if (icon.bitmap) libs.DeleteObject(icon.bitmap)
  if (icon.mask) libs.DeleteObject(icon.mask)
}

/**
 * Add, update or remove the notification-area icon owned by a window.
 * @param {'add'|'update'|'remove'} action - what to ask the shell for.
 * @param {{hwnd: object, id?: number, message?: number, icon?: object, tooltip?: string}} options -
 *   the owning window, the icon id, the callback message and the icon itself.
 * @returns {boolean} whether the shell accepted the request.
 */
export function trayIcon(action, options) {
  const libs = native()
  const message = { add: NIM_ADD, update: NIM_MODIFY, remove: NIM_DELETE }[action]
  if (message === undefined) throw new Error(`unknown tray action ${action}`)
  const data = {
    cbSize: koffi.sizeof(libs.NOTIFYICONDATAW),
    hWnd: options.hwnd,
    uID: options.id ?? 1,
    uFlags: action === 'remove' ? 0 : NIF_MESSAGE | NIF_ICON | NIF_TIP,
    uCallbackMessage: options.message ?? WM.APP_TRAY,
    hIcon: options.icon?.handle ?? null,
    szTip: utf16Units(options.tooltip ?? 'voice-to-text', 128),
    dwState: 0,
    dwStateMask: 0,
    szInfo: utf16Units('', 256),
    uVersion: 0,
    szInfoTitle: utf16Units('', 256),
    dwInfoFlags: 0,
    guidItem: { Data1: 0, Data2: 0, Data3: 0, Data4: [0, 0, 0, 0, 0, 0, 0, 0] },
    hBalloonIcon: null,
  }
  const accepted = Boolean(libs.Shell_NotifyIconW(message, data))
  shellError = accepted ? 0 : Number(libs.GetLastError())
  return accepted
}

/**
 * The Win32 error of the last refused notification-area request.
 *
 * Worth keeping because "the icon does not appear" has two very different causes: a defect here, or a
 * process that is not allowed to talk to the shell. Measured in the DSH sandbox, which runs commands at
 * low integrity: every variant of the call — including a stock system icon — is refused with error 5
 * (access denied), while the same code is expected to succeed on a normal desktop.
 * @returns {number} a Win32 error code, 0 when the last request succeeded.
 */
export function lastShellError() {
  return shellError
}

/**
 * The size koffi computed for NOTIFYICONDATAW; the self-test compares it with the documented 1360.
 * @returns {number} struct size in bytes.
 */
export function notifyIconDataSize() {
  return koffi.sizeof(native().NOTIFYICONDATAW)
}

/**
 * Show a popup menu at a screen position and return the id the user picked.
 *
 * `TrackPopupMenu` runs its own message loop, so this must never be called from a window procedure:
 * the pump would be re-entered on a native callback frame, which is the pattern that aborted this
 * process with 0xC0000005 before.
 * @param {object} hwnd - the window that owns the menu.
 * @param {{id?: number, label?: string, separator?: boolean}[]} items - menu entries.
 * @param {{x?: number, y?: number}} [options] - where to show it; the pointer position by default.
 * @returns {number} the chosen id, or 0 when the menu was dismissed.
 */
export function popupMenu(hwnd, items, options = {}) {
  const libs = native()
  const menu = libs.CreatePopupMenu()
  if (!menu) return 0
  for (const item of items) {
    if (item.separator) {
      libs.AppendMenuW(menu, MF_SEPARATOR, 0, null)
      continue
    }
    const label = Buffer.from(`${item.label ?? ''}\0`, 'utf16le')
    libs.AppendMenuW(menu, MF_STRING, item.id ?? 0, koffi.address(label))
  }
  const at = cursorPosition()
  // SetForegroundWindow is what makes the menu disappear when the user clicks somewhere else.
  libs.SetForegroundWindow(hwnd)
  const chosen = libs.TrackPopupMenu(
    menu,
    TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON,
    options.x ?? at.x,
    options.y ?? at.y,
    0,
    hwnd,
    null,
  )
  libs.DestroyMenu(menu)
  postMessage(hwnd, WM_NULL, 0, 0)
  return chosen
}

/**
 * The process that owns the floating button window.
 * @returns {number|null} the process id, or null when there is no button.
 */
export function buttonProcessId() {
  const libs = native()
  const hwnd = findButtonWindow()
  if (!hwnd) return null
  const out = [0]
  libs.GetWindowThreadProcessId(hwnd, out)
  return out[0] || null
}

/**
 * Close the floating button, whatever it takes.
 *
 * Asking politely is the normal path: `WM_CLOSE` makes the owning process shut down cleanly and remove
 * its tray icon. When Windows refuses to deliver that message — it blocks cross-process messages to
 * windows of a different integrity level — the only honest answer is to say so, or, when the caller
 * asks for it, to end the process that owns the window.
 * @param {{waitMs?: number, force?: boolean}} [options] - how long to wait and whether to end a
 *   process that does not answer.
 * @returns {Promise<{found: boolean, closed: boolean, killed: boolean, pid: number|null,
 *   method: string}>} what happened.
 */
export async function stopButton(options = {}) {
  const waitMs = options.waitMs ?? 900
  const pid = buttonProcessId()
  if (pid === null) return { found: false, closed: false, killed: false, pid: null, method: 'none' }
  const hwnd = findButtonWindow()
  postMessage(hwnd, WM.CLOSE, 0, 0)
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    if (!isWindow(hwnd)) return { found: true, closed: true, killed: false, pid, method: 'message' }
  }
  if (!options.force) return { found: true, closed: false, killed: false, pid, method: 'message-blocked' }
  if (pid === process.pid) return { found: true, closed: false, killed: false, pid, method: 'self' }
  const libs = native()
  const handle = libs.OpenProcess(PROCESS_TERMINATE, 0, pid)
  if (!handle) return { found: true, closed: false, killed: false, pid, method: 'no-access' }
  const killed = Boolean(libs.TerminateProcess(handle, 1))
  libs.CloseHandle(handle)
  return { found: true, closed: killed, killed, pid, method: killed ? 'terminate' : 'no-access' }
}

/**
 * The window procedure shared by every button this process creates.
 *
 * `koffi.register` can only bind one JS function per native prototype, so the procedure looks the
 * window up in a registry and forwards to that instance.
 * @param {object} hwnd - window handle.
 * @param {number} message - message id.
 * @param {number} wParam - first parameter.
 * @param {number} lParam - second parameter.
 * @returns {number} the message result.
 */
function windowProc(hwnd, message, wParam, lParam) {
  const libs = native()
  if (message === WM.PAINT) {
    // Validate the update region; see the header note about the pump otherwise spinning forever.
    const ps = {}
    libs.BeginPaint(hwnd, ps)
    libs.EndPaint(hwnd, ps)
    return 0
  }
  if (message === WM.MOUSEACTIVATE) return MA_NOACTIVATE
  const window = libs.windows.get(hwnd)
  if (window && window.handleMessage(message, wParam, lParam)) return 0
  return libs.DefWindowProcW(hwnd, message, wParam, lParam)
}

/**
 * A borderless, always-on-top, per-pixel-alpha window used as the microphone button.
 *
 * The window never activates and never takes focus; clicks arrive as ordinary mouse messages.
 */
export class LayeredWindow {
  /**
   * @param {{title?: string, onMessage?: (message: number, wParam: number, lParam: number) => boolean}} [options]
   *   window title (diagnostics only) and the handler for mouse messages.
   */
  constructor(options = {}) {
    this.title = options.title ?? 'voice-to-text button'
    this.onMessage = options.onMessage ?? (() => false)
    this.handle = null
    this.width = 0
    this.height = 0
    this.position = { x: 0, y: 0 }
    this.visible = false
    this.screenDc = null
    this.memoryDc = null
    this.bitmap = null
    this.previousBitmap = null
    this.bits = null
    this.className = null
    this.trackingLeave = false
  }

  /**
   * Create the window (hidden).
   * @param {number} width - window width in pixels.
   * @param {number} height - window height in pixels.
   * @returns {LayeredWindow} this instance.
   */
  create(width, height) {
    const libs = native()
    if (this.handle) return this
    if (!libs.classAtom) {
      libs.instance = libs.GetModuleHandleW(null)
      const name = Buffer.from(`${buttonClass()}\0`, 'utf16le')
      libs.className = name
      libs.classAtom = libs.RegisterClassExW({
        cbSize: koffi.sizeof(libs.WNDCLASSEXW),
        style: 0,
        lpfnWndProc: libs.wndProcPointer ??= koffi.register(windowProc, koffi.pointer(libs.WNDPROC)),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: libs.instance,
        hIcon: null,
        hCursor: libs.LoadCursorW(null, IDC_HAND), // a plain resource ordinal, not a pointer
        hbrBackground: null,
        lpszMenuName: null,
        lpszClassName: koffi.address(name),
        hIconSm: null,
      })
      if (!libs.classAtom) throw new Error('cannot register the overlay window class')
    }
    this.className = libs.className
    this.handle = libs.CreateWindowExW(
      WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
      koffi.address(this.className),
      koffi.address(Buffer.from(`${this.title}\0`, 'utf16le')),
      WS_POPUP,
      this.position.x, this.position.y, width, height,
      null, null, libs.instance, null,
    )
    if (!this.handle) throw new Error('cannot create the overlay window')
    libs.windows.set(this.handle, this)
    this.screenDc = libs.GetDC(null)
    this.resizeDib(width, height)
    return this
  }

  /**
   * (Re)allocate the DIB section that backs the window.
   * @param {number} width - pixel width.
   * @param {number} height - pixel height.
   * @returns {void}
   */
  resizeDib(width, height) {
    const libs = native()
    if (this.bitmap && this.width === width && this.height === height) return
    if (this.memoryDc) {
      if (this.previousBitmap) libs.SelectObject(this.memoryDc, this.previousBitmap)
      if (this.bitmap) libs.DeleteObject(this.bitmap)
      libs.DeleteDC(this.memoryDc)
      this.memoryDc = null
      this.bitmap = null
      this.previousBitmap = null
      this.bits = null
    }
    this.memoryDc = libs.CreateCompatibleDC(this.screenDc)
    const info = {
      bmiHeader: {
        biSize: koffi.sizeof(libs.BITMAPINFOHEADER),
        biWidth: width,
        biHeight: -height, // top-down: row 0 of the raster buffer is the top row on screen
        biPlanes: 1,
        biBitCount: 32,
        biCompression: 0,
        biSizeImage: 0,
        biXPelsPerMeter: 0,
        biYPelsPerMeter: 0,
        biClrUsed: 0,
        biClrImportant: 0,
      },
      bmiColors: [0, 0, 0],
    }
    const bitsOut = [null]
    this.bitmap = libs.CreateDIBSection(this.memoryDc, info, DIB_RGB_COLORS, bitsOut, null, 0)
    if (!this.bitmap) throw new Error('cannot create the overlay bitmap')
    this.previousBitmap = libs.SelectObject(this.memoryDc, this.bitmap)
    this.bits = bitsOut[0]
    this.width = width
    this.height = height
  }

  /**
   * Upload one frame and (re)position the window.
   * @param {{width: number, height: number, pixels: Buffer}} frame - premultiplied BGRA pixels.
   * @param {{x: number, y: number}} [position] - new top-left corner; kept when omitted.
   * @returns {LayeredWindow} this instance.
   */
  setFrame(frame, position) {
    const libs = native()
    if (!this.handle) throw new Error('the overlay window has not been created yet')
    this.resizeDib(frame.width, frame.height)
    if (frame.pixels.length !== frame.width * frame.height * 4) {
      throw new Error(`overlay frame has ${frame.pixels.length} bytes but claims ${frame.width}x${frame.height}`)
    }
    // koffi.view() exposes unmanaged memory as an ArrayBuffer, so the frame copies in one operation.
    new Uint8Array(koffi.view(this.bits, frame.pixels.length)).set(frame.pixels)
    if (position) this.position = { x: Math.round(position.x), y: Math.round(position.y) }
    const painted = libs.UpdateLayeredWindow(
      this.handle,
      this.screenDc,
      { x: this.position.x, y: this.position.y },
      { cx: frame.width, cy: frame.height },
      this.memoryDc,
      { x: 0, y: 0 },
      0,
      { BlendOp: AC_SRC_OVER, BlendFlags: 0, SourceConstantAlpha: 255, AlphaFormat: AC_SRC_ALPHA },
      ULW_ALPHA,
    )
    if (!painted) throw new Error('UpdateLayeredWindow failed')
    return this
  }

  /**
   * Move the window without repainting it.
   * @param {number} x - screen x.
   * @param {number} y - screen y.
   * @param {{repaint?: boolean, frame?: object}} [options] - repaint instead of moving when needed.
   * @returns {LayeredWindow} this instance.
   */
  moveTo(x, y, options = {}) {
    const libs = native()
    if (!this.handle) return this
    const nextX = Math.round(x)
    const nextY = Math.round(y)
    if (nextX === this.position.x && nextY === this.position.y && this.visible) return this
    this.position = { x: nextX, y: nextY }
    if (this.visible && !options.repaint) {
      libs.SetWindowPos(this.handle, HWND_TOPMOST, nextX, nextY, this.width, this.height, SWP_NOACTIVATE | SWP_SHOWWINDOW)
    } else if (options.frame) {
      this.setFrame(options.frame, this.position)
    }
    return this
  }

  /** Show the window without activating it or moving focus. */
  show() {
    const libs = native()
    if (!this.handle || this.visible) return this
    libs.ShowWindow(this.handle, SW_SHOWNOACTIVATE)
    libs.SetWindowPos(this.handle, HWND_TOPMOST, this.position.x, this.position.y, this.width, this.height, SWP_NOACTIVATE | SWP_SHOWWINDOW)
    this.visible = true
    return this
  }

  /** Hide the window; it keeps its frame and position. */
  hide() {
    const libs = native()
    if (!this.handle || !this.visible) return this
    libs.ShowWindow(this.handle, SW_HIDE)
    this.visible = false
    return this
  }

  /**
   * Forward the messages this window cares about.
   * @param {number} message - message id.
   * @param {number} wParam - first parameter.
   * @param {number} lParam - second parameter.
   * @returns {boolean} true when the message was consumed.
   */
  handleMessage(message, wParam, lParam) {
    const libs = native()
    switch (message) {
      case WM.LBUTTONDOWN:
        libs.SetCapture(this.handle)
        this.onMessage('left-down', wParam, lParam)
        return true
      case WM.LBUTTONUP:
        // The window procedure must report the button-up before capture is released: ReleaseCapture
        // sends WM_CAPTURECHANGED straight back to this window, and a handler that treats that as the
        // end of a press would decide "click" about a drag the user is still finishing.
        this.onMessage('left-up', wParam, lParam)
        libs.ReleaseCapture()
        return true
      case WM.RBUTTONUP:
        this.onMessage('right-up', wParam, lParam)
        return true
      case WM.MBUTTONUP:
        this.onMessage('middle-up', wParam, lParam)
        return true
      case WM.MOUSEMOVE:
        if (!this.trackingLeave) {
          // WM_MOUSELEAVE has to be asked for explicitly; without it the hover state never clears.
          this.trackingLeave = Boolean(libs.TrackMouseEvent({
            cbSize: koffi.sizeof(libs.TRACKMOUSEEVENT),
            dwFlags: TME_LEAVE,
            hwndTrack: this.handle,
            dwHoverTime: 0,
          }))
        }
        this.onMessage('move', wParam, lParam)
        return false
      case WM.MOUSELEAVE:
        this.trackingLeave = false
        this.onMessage('mouse-leave', wParam, lParam)
        return false
      case WM.CAPTURECHANGED:
        this.onMessage('capture-lost', wParam, lParam)
        return false
      case WM.CLOSE:
        // Posted by `vtt overlay --stop` from another process: never route it to DefWindowProc, which
        // would destroy the window behind the owner's back.
        this.onMessage('close', wParam, lParam)
        return true
      case WM.APP_REVIVE:
        // Posted by a second `vtt overlay` launch: show the button again.
        this.onMessage('revive', wParam, lParam)
        return true
      case WM.APP_TRAY:
        // The shell tells us which tray icon was clicked in wParam and how in lParam.
        this.onMessage('tray', wParam, lParam)
        return true
      default:
        return false
    }
  }

  /** Destroy the window and release every GDI object. */
  dispose() {
    const libs = native()
    if (this.memoryDc) {
      if (this.previousBitmap) libs.SelectObject(this.memoryDc, this.previousBitmap)
      if (this.bitmap) libs.DeleteObject(this.bitmap)
      libs.DeleteDC(this.memoryDc)
    }
    if (this.screenDc) libs.ReleaseDC(null, this.screenDc)
    if (this.handle) {
      libs.windows.delete(this.handle)
      libs.DestroyWindow(this.handle)
    }
    this.memoryDc = null
    this.screenDc = null
    this.bitmap = null
    this.previousBitmap = null
    this.bits = null
    this.handle = null
    this.visible = false
  }
}
