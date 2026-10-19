/**
 * Probe: isolate which step of the Chinese menu-label check aborts the process.
 *
 * probe/menu-probe.mjs died with 0xC0000005 before printing the readback result, so every native call
 * is announced before it is made — a silent probe cannot say which call is the culprit.
 *
 * Usage: node probe\menu-step.mjs
 */
import koffi from 'koffi'

const user32 = koffi.load('user32.dll')
const CreatePopupMenu = user32.func('void *CreatePopupMenu()')
const AppendMenuW = user32.func('int AppendMenuW(void *menu, unsigned int flags, size_t id, str16 label)')
const GetMenuStringW = user32.func('int GetMenuStringW(void *menu, size_t id, void *buffer, int max, unsigned int flags)')
const DestroyMenu = user32.func('int DestroyMenu(void *menu)')

const step = (text) => process.stdout.write(`· ${text}\n`)

step('CreatePopupMenu')
const menu = CreatePopupMenu()
step(`  -> ${menu}`)

step('AppendMenuW id=1 ascii')
step(`  -> ${AppendMenuW(menu, 0, BigInt(1), 'Start')}`)

step('GetMenuStringW ascii into a Buffer')
const buffer = Buffer.alloc(512)
let length = GetMenuStringW(menu, BigInt(1), buffer, 256, 0)
step(`  -> ${length}`)
step(`  decode -> ${JSON.stringify(koffi.decode(buffer, 0, 'str16'))}`)

step('AppendMenuW id=2 chinese')
step(`  -> ${AppendMenuW(menu, 0, BigInt(2), '开始 / 结束听写')}`)

step('GetMenuStringW chinese into a Buffer')
length = GetMenuStringW(menu, BigInt(2), buffer, 256, 0)
step(`  -> ${length}`)
step(`  decode -> ${JSON.stringify(koffi.decode(buffer, 0, 'str16'))}`)

step('DestroyMenu')
step(`  -> ${DestroyMenu(menu)}`)
step('done')
