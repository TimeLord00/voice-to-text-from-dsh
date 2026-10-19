/**
 * Why does `Shell_NotifyIconW` refuse the icon?
 *
 * The overlay self-test reports `the notification-area icon is accepted by the shell` as its only
 * failure, while `FindWindowW('Shell_TrayWnd')` finds a taskbar — so either the icon we hand over is
 * unacceptable, or the shell is not reachable from this session at all. Those two have very different
 * consequences (a broken feature versus a harness that cannot see the desktop), so this probe tries the
 * variants that tell them apart and prints the Win32 error for each.
 *
 * Run: node probe\tray-probe.mjs
 */
import koffi from 'koffi'
import { renderButton } from '../src/raster.mjs'
import { createColorIcon, releaseIcon, shellPresent, trayIcon } from '../src/win32-gui.mjs'

const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')
// Only scalars and a plain pointer are declared here: koffi type names ('RECT', 'NOTIFYICONDATAW', ...)
// are global, and re-declaring one that src/win32-gui.mjs already defined throws.
const CreateWindowExW = user32.func('void *CreateWindowExW(uint32 exStyle, str16 className, str16 windowName, uint32 style, int x, int y, int width, int height, void *parent, void *menu, void *instance, void *param)')
const DestroyWindow = user32.func('int DestroyWindow(void *hwnd)')
const LoadIconW = user32.func('void *LoadIconW(void *instance, void *name)')
const GetLastError = kernel32.func('uint32 GetLastError()')

const WS_POPUP = 0x80000000
const hwnd = CreateWindowExW(0, 'STATIC', 'tray-probe', WS_POPUP, 0, 0, 8, 8, null, null, null, null)
if (!hwnd) {
  process.stdout.write(`could not create a window for the probe (last error ${GetLastError()})\n`)
  process.exit(1)
}
process.stdout.write(`probe window       ${hwnd}\n`)
process.stdout.write(`taskbar present    ${shellPresent()}\n`)

const frame = renderButton({ size: 32, state: 'idle', shadow: false })
const ours = createColorIcon(frame.width, frame.height, frame.pixels)
const stock = LoadIconW(null, 32512) // IDI_APPLICATION
process.stdout.write(`rendered icon      ${ours ? ours.handle : 'null'}\n`)
process.stdout.write(`stock icon         ${stock}\n`)

const attempt = (label, options) => {
  const accepted = trayIcon('add', { hwnd, tooltip: 'voice-to-text probe', ...options })
  const code = GetLastError()
  process.stdout.write(`${accepted ? 'ACCEPTED' : 'refused '}  ${label}  (last error ${code})\n`)
  if (accepted) trayIcon('remove', { hwnd })
  return accepted
}

attempt('our icon, callback message, tooltip', { icon: ours, message: 0x8002 })
attempt('stock icon, callback message, tooltip', { icon: stock, message: 0x8002 })
attempt('our icon, no callback message', { icon: ours })
attempt('stock icon, no callback message, no tooltip', { icon: stock })

releaseIcon(ours)
DestroyWindow(hwnd)
