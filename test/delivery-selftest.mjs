/**
 * Self-test for the delivery rules: what happens to the clipboard when recognized text is pasted.
 *
 * The rule the user asked for is "do not leave my text in the clipboard". Pasting into an arbitrary
 * foreign window needs the clipboard for a moment, so the rule is implemented as a restore with three
 * guards, and every one of them is checked here with an injected clipboard so the whole decision table is
 * covered without a real clipboard, a microphone or a model:
 *
 *  1. the contents from just before the write are put back after the paste;
 *  2. text copied by somebody else while the paste was in flight wins (nothing is overwritten);
 *  3. when the paste did not happen at all the text stays, otherwise the user would have nothing to
 *     paste by hand.
 *
 * A second section drives the same path against the REAL Win32 clipboard (with the keystroke injection
 * replaced by a stub, so nothing is typed into whatever window happens to have focus) and puts the
 * user's own clipboard back before exiting.
 *
 * Usage: node test/delivery-selftest.mjs
 */
import { Dictation, describeDelivery } from '../src/dictation.mjs'

const failures = []
/**
 * Record one assertion.
 * @param {string} label - what is being checked.
 * @param {boolean} ok - result.
 * @param {string} [detail] - extra context.
 * @returns {void}
 */
function check(label, ok, detail = '') {
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'}${label}${detail ? ` — ${detail}` : ''}\n`)
  if (!ok) failures.push(label)
}

/**
 * Report something this machine cannot answer either way, without failing the suite.
 * @param {string} label - what was skipped.
 * @param {string} detail - why.
 * @returns {void}
 */
function note(label, detail) {
  process.stdout.write(`  NOTE ${label} — ${detail}\n`)
}

/**
 * A clipboard that exists only in memory, plus the log of what was asked of it.
 * @param {{text?: string|null, present?: boolean}} [initial] - starting state; `present` without `text`
 *   stands for content that is not text (an image, a set of files).
 * @returns {object} clipboard double with `read`/`write`/`clear`/`hasData` and its recorded calls.
 */
function fakeClipboard(initial = {}) {
  const state = {
    text: initial.text ?? null,
    present: initial.present ?? initial.text !== undefined,
    writes: [],
    clears: 0,
    excluded: [],
  }
  return {
    state,
    read: () => state.text,
    write: (text, options) => {
      state.text = text
      state.present = true
      state.writes.push(text)
      state.excluded.push(Boolean(options?.excludeFromHistory))
      return true
    },
    clear: () => {
      state.text = null
      state.present = false
      state.clears += 1
      return true
    },
    hasData: () => state.present,
  }
}

/**
 * Build a Dictation with no engine, no microphone and an injected clipboard.
 * @param {object} clipboard - a {@link fakeClipboard} result.
 * @param {object} [options] - delivery switches and hooks.
 * @returns {Dictation} the session under test.
 */
function session(clipboard, options = {}) {
  const config = {
    beeps: false,
    pasteDelayMs: 0,
    restoreDelayMs: 0,
    restoreClipboard: options.restoreClipboard ?? true,
    keepRecordings: false,
    maxSeconds: 120,
  }
  return new Dictation(config, { load() {} }, {
    clipboard: options.clipboard ?? true,
    paste: options.paste ?? true,
    restoreClipboard: options.restoreClipboard,
    restoreDelayMs: options.restoreDelayMs,
    log: options.log ?? (() => {}),
    foregroundTitle: () => '',
    readClipboard: options.readClipboard ?? clipboard.read,
    writeClipboard: options.writeClipboard ?? clipboard.write,
    clearClipboard: options.clearClipboard ?? clipboard.clear,
    clipboardHasData: options.clipboardHasData ?? clipboard.hasData,
    pasteKeys: options.pasteKeys ?? (() => true),
    targetIsProtected: options.targetIsProtected ?? (() => false),
  })
}

process.stdout.write('delivery: restore rules (injected clipboard)\n')
{
  const clipboard = fakeClipboard({ text: 'before-text' })
  const result = await session(clipboard).deliver('hello world')
  check('the previous clipboard text is put back after the paste', clipboard.state.text === 'before-text', JSON.stringify(clipboard.state.text))
  check('the report says the clipboard was restored', result.restored === true && result.pasted === true, JSON.stringify(result))
  check('the recognized text was on the clipboard in between', clipboard.state.writes[0] === 'hello world')
  check('the text is written with the "do not keep me" markers', clipboard.state.excluded[0] === true)
  check('the restored text is written back without those markers', clipboard.state.excluded[1] === false)
  check('the clipboard is written exactly twice', clipboard.state.writes.length === 2, clipboard.state.writes.join(' | '))
}
{
  const clipboard = fakeClipboard({ text: null, present: false })
  const result = await session(clipboard).deliver('hello world')
  check('an empty clipboard is emptied again instead of restored', result.cleared === true && clipboard.state.text === null, JSON.stringify(result))
  check('nothing is left behind for the next Ctrl+V', clipboard.state.writes.length === 1 && clipboard.state.clears === 1)
}
{
  const clipboard = fakeClipboard({ text: null, present: true })
  const lines = []
  const result = await session(clipboard, { log: (line) => lines.push(line) }).deliver('hello world')
  check('content that is not text is emptied, not restored', result.cleared === true && clipboard.state.text === null)
  check('and the log says the clipboard held something that is not text', lines.some((line) => /not text/.test(line)), lines.join(' / '))
}
{
  const clipboard = fakeClipboard({ text: 'before-text' })
  const stub = session(clipboard, { readClipboard: () => 'copied by someone else' })
  const result = await stub.deliver('hello world')
  check('text copied while the paste was in flight is not overwritten', result.keptOther === true && clipboard.state.writes.length === 1)
  check('and the report says the clipboard was kept', describeDelivery(result) === 'pasted into the focused window, clipboard kept (it changed meanwhile)', describeDelivery(result))
}
{
  const clipboard = fakeClipboard({ text: 'before-text' })
  const result = await session(clipboard, { pasteKeys: () => false }).deliver('hello world')
  check('a paste that did not happen leaves the text on the clipboard', result.keptText === true && clipboard.state.text === 'hello world')
  check('and nothing was restored', result.restored === false && clipboard.state.writes.length === 1)
}
{
  const clipboard = fakeClipboard({ text: 'before-text' })
  const result = await session(clipboard, { restoreClipboard: false }).deliver('hello world')
  check('with restoreClipboard off the text stays, as before', result.keptText === true && clipboard.state.text === 'hello world')
  check('and no history markers are written', clipboard.state.excluded[0] === false)
}
{
  const clipboard = fakeClipboard({ text: 'before-text' })
  const result = await session(clipboard, { clipboard: false }).deliver('hello world')
  check('with the clipboard switched off nothing is written', clipboard.state.writes.length === 0 && result.clipboard === false)
}
{
  const clipboard = fakeClipboard({ text: 'before-text' })
  const started = Date.now()
  await session(clipboard, { restoreDelayMs: 60 }).deliver('hello world')
  const elapsed = Date.now() - started
  check('the restore waits for the target window to read the clipboard', elapsed >= 50, `${elapsed}ms`)
}
{
  // An elevated window ignores the injected Ctrl+V (UIPI), so taking the text off the clipboard would
  // leave the user with nothing to paste by hand. The clipboard is left holding the recognized text.
  const clipboard = fakeClipboard({ text: 'before-text' })
  const lines = []
  const result = await session(clipboard, { targetIsProtected: () => true, log: (line) => lines.push(line) }).deliver('hello world')
  check('an elevated target window keeps the text on the clipboard', result.targetProtected === true && result.keptText === true && clipboard.state.text === 'hello world', JSON.stringify(result))
  check('and the previous clipboard content is not written back', result.restored === false && clipboard.state.writes.length === 1)
  check('and the log explains why', lines.some((line) => /higher privileges/.test(line)), lines.join(' / '))
}
{
  const clipboard = fakeClipboard({ text: 'before-text' })
  const result = await session(clipboard, { targetIsProtected: () => false }).deliver('hello world')
  check('a normal target window still gets the clipboard back', result.restored === true && clipboard.state.text === 'before-text')
}
process.stdout.write('delivery: report wording\n')
{
  const cases = [
    [{ pasted: true, restored: true, target: 'Notepad' }, 'pasted into Notepad, clipboard restored'],
    [{ pasted: true, cleared: true, target: 'Notepad' }, 'pasted into Notepad, clipboard emptied'],
    [{ pasted: true, keptText: true, target: '' }, 'pasted into the focused window, text left on the clipboard'],
    [{ pasted: true, targetProtected: true, keptText: true, target: 'Notepad' }, 'pasted into Notepad (elevated window: the key press may have been ignored), text left on the clipboard'],
    [{ clipboard: true }, 'copied to the clipboard'],
    [{}, 'not delivered'],
  ]
  for (const [input, expected] of cases) {
    check(`describeDelivery(${JSON.stringify(input)})`, describeDelivery(input) === expected, describeDelivery(input))
  }
}
process.stdout.write('delivery: the real Win32 clipboard\n')
{
  // The whole path against the real clipboard, with the keystroke injection stubbed out: proving the
  // restore here needs no window to have focus, and nothing is typed into the user's applications.
  const { clearClipboard, clipboardHasData, copyText, historyExclusion, readClipboardText } = await import('../src/win32.mjs')
  const savedText = readClipboardText()
  const savedHadData = clipboardHasData()
  const sentinel = `vtt-delivery-selftest-${Date.now()}`
  check('the real clipboard can be read twice with the same answer', readClipboardText() === savedText)

  if (savedText === null && savedHadData) {
    // Only text can be put back. Overwriting an image or a set of files and then "restoring" it is
    // impossible, so this section stands aside rather than destroying what the user had copied.
    note('the real clipboard holds something that is not text', 'the real-clipboard checks were skipped so nothing is destroyed')
  } else {
    const marked = copyText(sentinel, { excludeFromHistory: true })
    check('copyText can tag the content as "do not keep me"', marked === true)
    const markers = historyExclusion()
    check('Win+V history is told to skip it', markers.canInclude === 0, JSON.stringify(markers))
    check('cloud clipboard is told to skip it', markers.canUpload === 0, JSON.stringify(markers))

    copyText(sentinel)
    check('a plain copy carries no history markers', historyExclusion().canInclude === null, JSON.stringify(historyExclusion()))

    copyText('vtt-delivery-selftest-before')
    const real = new Dictation(
      { beeps: false, pasteDelayMs: 0, restoreDelayMs: 20, restoreClipboard: true, keepRecordings: false, maxSeconds: 120 },
      { load() {} },
      { clipboard: true, paste: true, pasteKeys: () => true, log: () => {}, targetIsProtected: () => false },
    )
    const result = await real.deliver(sentinel)
    check('the real clipboard is put back after a paste', readClipboardText() === 'vtt-delivery-selftest-before', JSON.stringify(readClipboardText()))
    check('and the delivery reports the restore', result.restored === true && result.pasted === true, JSON.stringify(result))
    const { targetIsProtected } = await import('../src/win32.mjs')
    note('targetIsProtected() answers for the focused window', `it returned ${targetIsProtected()} (true = the text would stay on the clipboard)`)
  }

  if (savedText !== null) copyText(savedText)
  else if (!savedHadData) clearClipboard()
  check('the suite put the user clipboard back', readClipboardText() === savedText, JSON.stringify(readClipboardText()))
}

process.stdout.write(`\n${failures.length ? `${failures.length} FAILED: ${failures.join(', ')}` : 'ALL CHECKS PASSED'}\n`)
process.exitCode = failures.length ? 1 : 0
