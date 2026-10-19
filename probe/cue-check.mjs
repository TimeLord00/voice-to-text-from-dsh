/**
 * Cue check: write the four dictation cues to disk so they can be played, and ask the audio device
 * whether it accepts them.
 *
 * The cues are synthesized in src/sound.mjs and normally only ever exist in memory, handed to PlaySound
 * with SND_MEMORY. This probe writes them to test-output/cues/*.wav — double-click one to hear exactly
 * what the tool will play — and reports the length, the bytes, the peak level and `playCue`'s answer.
 * PlaySound accepting the buffer is as far as this can be verified from here: whether the sound reaches
 * the speakers is the user's own check.
 *
 * Usage: node probe/cue-check.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CUE_KINDS, cueDurationMs, renderCue } from '../src/sound.mjs'
import { beep, playCue } from '../src/win32.mjs'
import { canonicalToFloat } from '../src/wav.mjs'

const dir = join(process.cwd(), 'test-output', 'cues')
mkdirSync(dir, { recursive: true })

process.stdout.write('dictation cues\n')
for (const kind of CUE_KINDS) {
  const wav = renderCue(kind)
  writeFileSync(join(dir, `${kind}.wav`), wav)
  const samples = canonicalToFloat(wav)
  const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
  process.stdout.write(`  ${kind.padEnd(6)} ${String(cueDurationMs(kind)).padStart(4)} ms  ${String(wav.length).padStart(6)} bytes  `
    + `peak ${peak.toFixed(3)}  playCue -> ${playCue(kind)}\n`)
}

// A missing or muted device must not take dictation down with it; beep() falls back to MessageBeep.
beep('start')
beep('error', 0.3)
process.stdout.write(`\nwrote ${CUE_KINDS.length} files to ${dir}\n`)
