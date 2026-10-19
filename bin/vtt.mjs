#!/usr/bin/env node
/**
 * Executable entry point: `vtt <command> [options]`.
 *
 * Kept deliberately thin — all behaviour lives in src/cli.mjs, which is also what the tests import.
 * The platform check happens before anything native is loaded, so running this on Linux or macOS
 * fails with an explanation instead of a loader error.
 */
const MIN_NODE_MAJOR = 20

if (process.platform !== 'win32') {
  process.stderr.write('voice-to-text supports Windows only: it captures audio through the WinMM MCI mapper and drives the clipboard through Win32.\n')
  process.exit(1)
}

const major = Number(process.versions.node.split('.')[0])
if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
  process.stderr.write(`voice-to-text needs Node.js ${MIN_NODE_MAJOR} or newer; this is ${process.version}.\n`)
  process.exit(1)
}

try {
  const { main } = await import('../src/cli.mjs')
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  const message = error?.message ?? String(error)
  process.stderr.write(`error: ${message}\n`)
  if (/Microphone command failed|Cannot register the global hotkey/.test(message)) {
    process.stderr.write('hint: run "vtt doctor" to check the microphone, clipboard and hotkeys.\n')
  }
  if (process.env.VTT_DEBUG) process.stderr.write(`${error?.stack}\n`)
  process.exitCode = 1
}
