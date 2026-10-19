/**
 * Menu self-test: the notification-area menu, built as a real Windows menu.
 *
 * The tray menu is the only place where the user can quit the tool and the only place where a hidden
 * button can be brought back, so its wording and its command ids are part of the interface. The labels
 * are Chinese and koffi hands them to `AppendMenuW` as UTF-16; a marshalling mistake would show up as
 * mojibake in a menu that only exists on a real desktop.
 *
 * This suite therefore does not trust the strings in the source: it creates a popup menu, appends the
 * real entries, reads every label back out of the menu with `GetMenuStringW`, and compares the UTF-16
 * bytes. Nothing here is modal, so it runs unattended.
 *
 * Run: node test\menu-selftest.mjs   (npm run test:menu)
 */
import koffi from 'koffi'
import { TRAY_COMMAND, TRAY_TOOLTIP, TrayIcon, trayMenuItems } from '../src/tray.mjs'

const user32 = koffi.load('user32.dll')
const CreatePopupMenu = user32.func('void *CreatePopupMenu()')
const AppendMenuW = user32.func('int AppendMenuW(void *menu, unsigned int flags, size_t id, str16 label)')
const GetMenuItemCount = user32.func('int GetMenuItemCount(void *menu)')
const GetMenuStringW = user32.func('int GetMenuStringW(void *menu, size_t id, void *buffer, int max, unsigned int flags)')
const DestroyMenu = user32.func('int DestroyMenu(void *menu)')

const MF_STRING = 0x00000000
const MF_SEPARATOR = 0x00000800
const MF_BYCOMMAND = 0x00000000

let failures = 0
/**
 * Report one check.
 * @param {boolean} ok - whether it held.
 * @param {string} label - what was checked.
 * @param {string} [detail] - evidence to show either way.
 * @returns {void}
 */
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `   ${detail}` : ''}\n`)
}

/**
 * Read a label back out of the menu.
 *
 * `Buffer#toString`, not `koffi.decode(buffer, 0, 'str16')`: decoding a *string* from a plain JS Buffer
 * makes koffi treat the buffer's first bytes as an address and aborts the process with 0xC0000005
 * (measured with probe\menu-step.mjs). The bytes are identical either way.
 * @param {Buffer} buffer - buffer filled by `GetMenuStringW`.
 * @param {number} characters - how many characters the call reported.
 * @returns {string} the stored label.
 */
const readBack = (buffer, characters) => buffer.toString('utf16le', 0, characters * 2)

process.stdout.write('menu entries\n')
{
  const visible = trayMenuItems(true)
  const hidden = trayMenuItems(false)
  const labels = visible.map((item) => item.label ?? '---')
  check(labels.join('|') === '开始 / 结束听写|丢弃这次录音|---|隐藏悬浮按钮|---|退出',
    'the menu is in Chinese and in the documented order', labels.join('|'))
  check(visible.filter((item) => item.separator).length === 2, 'the menu separates the three groups')
  check(visible.filter((item) => !item.separator).every((item) => Number.isInteger(item.id)),
    'every command carries a numeric id', visible.map((item) => item.id ?? '-').join(','))
  const ids = visible.filter((item) => !item.separator).map((item) => item.id)
  check(new Set(ids).size === ids.length, 'no two commands share an id', ids.join(','))
  check(ids.includes(TRAY_COMMAND.quit), 'the menu can quit, which is the only way out of the tool', `quit = ${TRAY_COMMAND.quit}`)
  const shown = hidden.find((item) => item.id === TRAY_COMMAND.visibility)?.label
  const hiddenLabel = visible.find((item) => item.id === TRAY_COMMAND.visibility)?.label
  check(shown === '显示悬浮按钮' && hiddenLabel === '隐藏悬浮按钮',
    'the visibility entry flips with the button', `${hiddenLabel} / ${shown}`)
  check(TRAY_TOOLTIP.includes('语音转文字'), 'the tooltip is Chinese', TRAY_TOOLTIP)
  const tooltip = new TrayIcon({ window: { handle: null } }).tooltip
  check(tooltip === TRAY_TOOLTIP, 'a tray icon uses that tooltip unless one is given', tooltip)
}

process.stdout.write('\nreal windows menu\n')
const menu = CreatePopupMenu()
check(menu !== null && menu !== undefined, 'a popup menu can be created')
const items = trayMenuItems(true)
for (const item of items) {
  const ok = item.separator
    ? AppendMenuW(menu, MF_SEPARATOR, 0, null)
    : AppendMenuW(menu, MF_STRING, BigInt(item.id), item.label)
  check(ok !== 0, `Windows accepts ${item.separator ? 'a separator' : `"${item.label}"`}`)
}
check(GetMenuItemCount(menu) === items.length, 'the menu holds every entry', `${GetMenuItemCount(menu)} of ${items.length}`)

const buffer = Buffer.alloc(512)
for (const item of items) {
  if (item.separator) continue
  buffer.fill(0)
  const characters = GetMenuStringW(menu, BigInt(item.id), buffer, buffer.length / 2, MF_BYCOMMAND)
  const text = readBack(buffer, characters)
  const got = Buffer.from(text, 'utf16le')
  const wanted = Buffer.from(item.label, 'utf16le')
  check(characters === item.label.length && got.equals(wanted),
    `"${item.label}" survives the round trip byte for byte`,
    got.equals(wanted) ? `${got.length} bytes of UTF-16` : `${got.toString('hex')} vs ${wanted.toString('hex')}`)
}
check(DestroyMenu(menu) !== 0, 'the menu is destroyed again')

process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
