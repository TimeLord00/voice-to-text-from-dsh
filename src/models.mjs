/**
 * Model discovery, verification and download.
 *
 * A first run normally downloads nothing: the tool reuses the SenseVoice weights a DSH
 * installation already cached. Downloads only happen on a machine without them, and every file is
 * checked against the release-pinned size and SHA-256 from config.mjs before it is used.
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ASSETS, MODEL_ORIGINS, assetUrl, modelPlan, resolveModels } from './config.mjs'

/**
 * Describe every model file: where it should live and whether it is already there.
 * @param {object} config - effective configuration.
 * @returns {{files: Array<{key: string, asset: object, path: string, present: boolean}>, resolved: object|null, missing: string[]}}
 */
export function modelStatus(config) {
  const plan = modelPlan(config)
  const precision = config.precision
  const files = [
    { key: `model (${precision})`, asset: ASSETS.models[precision], path: plan.model },
    { key: 'tokens.txt', asset: ASSETS.tokens, path: plan.tokens },
    { key: 'silero_vad.onnx', asset: ASSETS.vad, path: plan.vad },
  ].map((file) => ({ ...file, present: existsSync(file.path) }))
  return { files, resolved: resolveModels(config), missing: files.filter((file) => !file.present).map((file) => file.key) }
}

/**
 * Hash a file without loading it into memory.
 * @param {string} path - file to hash.
 * @returns {Promise<string>} lowercase hex digest.
 */
export async function sha256File(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/**
 * Verify the on-disk models against the pinned sizes and digests.
 * @param {object} config - effective configuration.
 * @returns {Promise<Array<{key: string, path: string, ok: boolean, detail: string}>>} one result per existing file.
 */
export async function verifyModels(config) {
  const { files } = modelStatus(config)
  const results = []
  for (const file of files) {
    if (!file.present) {
      results.push({ key: file.key, path: file.path, ok: false, detail: 'missing' })
      continue
    }
    const size = statSync(file.path).size
    if (size !== file.asset.bytes) {
      results.push({ key: file.key, path: file.path, ok: false, detail: `size ${size} != ${file.asset.bytes}` })
      continue
    }
    const digest = await sha256File(file.path)
    results.push({ key: file.key, path: file.path, ok: digest === file.asset.sha256, detail: digest === file.asset.sha256 ? 'sha256 ok' : `sha256 ${digest.slice(0, 12)}... != ${file.asset.sha256.slice(0, 12)}...` })
  }
  return results
}

/**
 * Download every missing model file, verifying the digest before the file is kept.
 * @param {object} config - effective configuration.
 * @param {{log?: (line: string) => void, force?: boolean}} [options] - progress sink and overwrite flag.
 * @returns {Promise<Array<{key: string, path: string, status: string}>>} per-file outcome.
 */
export async function fetchModels(config, options = {}) {
  const log = options.log ?? (() => {})
  const { files } = modelStatus(config)
  const results = []
  for (const file of files) {
    const needsDownload = options.force || !file.present || statSync(file.path).size !== file.asset.bytes
    if (!needsDownload) {
      log(`have    ${file.key} (${(file.asset.bytes / 1048576).toFixed(0)} MB) at ${file.path}`)
      results.push({ key: file.key, path: file.path, status: 'present' })
      continue
    }
    mkdirSync(dirname(file.path), { recursive: true })
    let lastError = null
    let done = false
    for (const origin of MODEL_ORIGINS) {
      try {
        await download(assetUrl(file.asset, origin), file.path, file.asset, log)
        done = true
        results.push({ key: file.key, path: file.path, status: `downloaded from ${origin}` })
        break
      } catch (error) {
        lastError = error
        log(`failed  ${file.key} from ${origin}: ${error.message}`)
      }
    }
    if (!done) throw new Error(`Could not download ${file.key}: ${lastError?.message ?? 'no origin reachable'}`)
  }
  log(`models are ready in ${files[0].path.replace(/[\\/][^\\/]+$/, '')}`)
  return results
}

/**
 * Stream one asset to disk and verify it before the final rename.
 * @param {string} url - absolute URL.
 * @param {string} destination - final path.
 * @param {{bytes: number, sha256: string}} asset - expected size and digest.
 * @param {(line: string) => void} log - progress sink.
 * @returns {Promise<void>} resolves once the verified file is in place.
 */
async function download(url, destination, asset, log) {
  const partial = `${destination}.part`
  rmSync(partial, { force: true })
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
  const hash = createHash('sha256')
  const counter = { bytes: 0, nextReport: 0 }
  const total = Number(response.headers.get('content-length')) || asset.bytes
  const monitor = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk)
      counter.bytes += chunk.length
      if (counter.bytes >= counter.nextReport) {
        counter.nextReport = counter.bytes + 32 * 1048576
        log(`  ...${(counter.bytes / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB`)
      }
      callback(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(response.body), monitor, createWriteStream(partial))
  } catch (error) {
    rmSync(partial, { force: true })
    throw error
  }
  const digest = hash.digest('hex')
  if (counter.bytes !== asset.bytes || digest !== asset.sha256) {
    rmSync(partial, { force: true })
    throw new Error(`verification failed (${counter.bytes} bytes, sha256 ${digest.slice(0, 12)}...); expected ${asset.bytes} bytes, ${asset.sha256.slice(0, 12)}...`)
  }
  renameSync(partial, destination)
  log(`saved   ${destination}`)
}
