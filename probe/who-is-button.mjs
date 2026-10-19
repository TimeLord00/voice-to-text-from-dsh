/**
 * Who owns the floating button window right now?
 *
 * The overlay self-test failed on "disposing the button destroys the window" and the next launch then
 * reported a button already running, so something owned a window of class VttMicButton. This prints
 * the owning process, its visibility and its rectangle, which separates "our process did not destroy
 * it" from "another process owns one".
 */
import koffi from 'koffi'

const user32 = koffi.load('user32.dll')
const FindWindowW = user32.func('void *FindWindowW(str16 className, str16 windowName)')
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)')
const IsWindowVisible = user32.func('int IsWindowVisible(void *hwnd)')
const GetWindowRect = user32.func('int GetWindowRect(void *hwnd, _Out_ int *rect)')
const GetClassNameW = user32.func('int GetClassNameW(void *hwnd, _Out_ char16 *buffer, int count)')

const hwnd = FindWindowW('VttMicButton', null)
if (!hwnd) {
  process.stdout.write('no VttMicButton window exists\n')
  process.exit(0)
}
const pidBuffer = [0]
GetWindowThreadProcessId(hwnd, pidBuffer)
const pid = pidBuffer[0]
const rect = [0, 0, 0, 0]
GetWindowRect(hwnd, rect)
const nameBuffer = Buffer.alloc(256)
GetClassNameW(hwnd, nameBuffer, 128)
process.stdout.write(`hwnd        ${hwnd}\n`)
process.stdout.write(`process     ${pid}\n`)
process.stdout.write(`self        ${pid === process.pid}\n`)
process.stdout.write(`visible     ${IsWindowVisible(hwnd)}\n`)
process.stdout.write(`rect        ${rect.join(',')}\n`)
process.stdout.write(`class       ${nameBuffer.toString('utf16le').replace(/\0.*$/, '')}\n`)
try {
  process.kill(pid, 0)
  process.stdout.write('alive       yes\n')
} catch {
  process.stdout.write('alive       no\n')
}
