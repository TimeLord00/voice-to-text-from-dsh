/**
 * Local HTTP API, so applications that cannot press a hotkey can still use the recognizer.
 *
 * Routes (all bound to 127.0.0.1; every one except `/health` requires the bearer token when
 * `token` is configured):
 *
 *   GET  /health                     readiness, model paths, engine state
 *   POST /transcribe?language=zh     body = a WAV file (any rate/channels; converted here)
 *   POST /v1/audio/transcriptions    OpenAI-compatible: multipart `file`, optional `language`
 *   GET  /transcribe?file=<path>     transcribe a WAV that is already on this machine
 *   POST /dictate                    start microphone capture
 *   POST /dictate/stop               stop, transcribe, paste into the focused window
 *   POST /dictate/cancel             drop the recording
 *
 * `/dictate*` is only mounted when the server is started with dictation enabled.
 */
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { LANGUAGES, resolveModels } from './config.mjs'
import { describeCanonical, toCanonicalWav } from './wav.mjs'
import { SpeechInputError } from './engine.mjs'

/** Upper bound on an uploaded body before conversion (a 2-minute 48 kHz stereo WAV is ~46 MB). */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

/** An error that already knows which HTTP status it deserves. */
class HttpError extends Error {
  /**
   * @param {number} status - HTTP status code to answer with.
   * @param {string} message - client-facing message.
   */
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/**
 * Start the HTTP API.
 * @param {object} config - effective configuration.
 * @param {import('./engine.mjs').SpeechEngine} engine - recognizer used for every request.
 * @param {{dictation?: import('./dictation.mjs').Dictation, log?: (line: string) => void}} [options]
 *   optional dictation bridge and log sink.
 * @returns {Promise<{server: import('node:http').Server, url: string, port: number, close: () => Promise<void>}>}
 *   the listening server and its base URL.
 */
export async function startApiServer(config, engine, options = {}) {
  const log = options.log ?? (() => {})
  const dictation = options.dictation ?? null
  const state = { requests: 0, lastText: '', startedAt: new Date().toISOString() }

  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500
      if (status >= 500) log(`request failed: ${error?.stack ?? error}`)
      send(response, status, { error: error.message })
    })
  })

  /**
   * Route one request.
   * @param {import('node:http').IncomingMessage} request - incoming request.
   * @param {import('node:http').ServerResponse} response - outgoing response.
   * @returns {Promise<void>} resolves when the response has been written.
   */
  async function handle(request, response) {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${config.port}`)
    const route = `${request.method} ${url.pathname}`
    if (url.pathname === '/health') {
      if (request.method !== 'GET') {
        send(response, 405, { error: 'use GET /health' })
        return
      }
      const models = resolveModels(config)
      send(response, 200, {
        ok: Boolean(models),
        startedAt: state.startedAt,
        requests: state.requests,
        engine: { loaded: engine.loaded, modelDir: models?.modelDir ?? null, source: models?.source ?? null },
        languages: LANGUAGES,
        dictation: dictation ? dictation.state : null,
      })
      return
    }
    if (!authorized(request, config.token)) {
      send(response, 401, { error: 'missing or invalid bearer token' })
      return
    }
    state.requests += 1
    if (route === 'GET /') {
      send(response, 200, {
        name: 'voice-to-text',
        hint: 'POST a WAV to /transcribe, or use /v1/audio/transcriptions with OpenAI-compatible clients.',
        routes: ['GET /health', 'POST /transcribe', 'POST /v1/audio/transcriptions', 'GET /transcribe?file=', ...(dictation ? ['POST /dictate', 'POST /dictate/stop', 'POST /dictate/cancel'] : [])],
      })
      return
    }
    if (route === 'GET /transcribe') {
      const file = url.searchParams.get('file')
      if (!file) throw new HttpError(400, 'missing ?file=<path>')
      if (!existsSync(file)) throw new HttpError(404, `file not found: ${file}`)
      const result = transcribeBuffer(readFileSync(file), languageFrom(url, config))
      state.lastText = result.text
      log(`GET /transcribe ${basename(file)} -> ${result.text.length} chars`)
      send(response, 200, result)
      return
    }
    if (route === 'POST /transcribe') {
      const body = await readBody(request)
      const result = transcribeBuffer(body, languageFrom(url, config))
      state.lastText = result.text
      log(`POST /transcribe ${body.length} bytes -> ${result.text.length} chars`)
      send(response, 200, result)
      return
    }
    if (route === 'POST /v1/audio/transcriptions') {
      const body = await readBody(request)
      const contentType = request.headers['content-type'] ?? ''
      let audio = body
      let fields = {}
      if (contentType.includes('multipart/form-data')) {
        try {
          ({ audio, fields } = parseMultipart(body, contentType))
        } catch (error) {
          throw new HttpError(400, error.message)
        }
      }
      const language = fields.language && LANGUAGES.includes(fields.language) ? fields.language : config.language
      const result = transcribeBuffer(audio, language)
      state.lastText = result.text
      log(`POST /v1/audio/transcriptions ${audio.length} bytes -> ${result.text.length} chars (model ${fields.model ?? '-'})`)
      send(response, 200, { text: result.text })
      return
    }
    if (dictation && route === 'POST /dictate') {
      send(response, 200, await stateOrConflict(() => dictation.begin()))
      return
    }
    if (dictation && route === 'POST /dictate/stop') {
      const result = await stateOrConflict(() => dictation.finish())
      state.lastText = result.text
      send(response, 200, result)
      return
    }
    if (dictation && route === 'POST /dictate/cancel') {
      send(response, 200, await stateOrConflict(() => dictation.discard()))
      return
    }
    send(response, 404, { error: `no route for ${route}` })
  }

  /**
   * Convert any WAV to canonical form and run the recognizer.
   * @param {Uint8Array|Buffer} bytes - uploaded or on-disk WAV.
   * @param {string} language - SenseVoice language hint.
   * @returns {object} transcription result for the API.
   */
  function transcribeBuffer(bytes, language) {
    if (!bytes?.length) throw new HttpError(400, 'empty request body; send a WAV file')
    let canonical
    try {
      canonical = toCanonicalWav(bytes)
    } catch (error) {
      throw new HttpError(400, error.message)
    }
    let result
    try {
      result = engine.transcribe(canonical, language)
    } catch (error) {
      if (error instanceof SpeechInputError) throw new HttpError(400, error.message)
      throw error
    }
    const size = describeCanonical(canonical)
    return { text: result.text, seconds: Number(size.seconds.toFixed(2)), inferenceMs: Math.round(result.inferenceSeconds * 1000), segments: result.segments, language }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : config.port
  const url = `http://127.0.0.1:${port}`
  return {
    server,
    url,
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/**
 * Run a dictation state transition, turning its state errors into 409 answers.
 *
 * Dictation reports "not recording", "still transcribing" and "recording too short" by throwing
 * plain errors; over HTTP those are conflicts with the session state, not server faults.
 * @template T
 * @param {() => Promise<T>|T} action - the state transition.
 * @returns {Promise<T>} whatever the transition returned.
 */
async function stateOrConflict(action) {
  try {
    return await action()
  } catch (error) {
    throw new HttpError(409, error.message)
  }
}

/**
 * Check the bearer token when one is configured.
 * @param {import('node:http').IncomingMessage} request - incoming request.
 * @param {string|null} token - required token, or null for open loopback access.
 * @returns {boolean} whether the request may proceed.
 */
function authorized(request, token) {
  if (!token) return true
  const header = request.headers.authorization ?? ''
  const value = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  return value === token
}

/**
 * Validate the `language` query parameter.
 * @param {URL} url - request URL.
 * @param {object} config - effective configuration.
 * @returns {string} a supported language hint.
 */
function languageFrom(url, config) {
  const requested = url.searchParams.get('language')
  if (!requested) return config.language
  if (!LANGUAGES.includes(requested)) throw new HttpError(400, `unsupported language "${requested}"; expected one of ${LANGUAGES.join(', ')}`)
  return requested
}

/**
 * Read a request body with a hard size cap.
 * @param {import('node:http').IncomingMessage} request - incoming request.
 * @returns {Promise<Buffer>} complete body.
 */
async function readBody(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > MAX_UPLOAD_BYTES) throw new HttpError(413, `request body exceeds ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * Extract the first file part of a multipart body.
 *
 * Deliberately minimal: OpenAI-compatible clients send one `file` field plus text fields, which is
 * all this needs to understand. Binary parts are located by boundary scanning rather than by any
 * form of line parsing, so audio bytes are never reinterpreted.
 * @param {Buffer} body - raw request body.
 * @param {string} contentType - request content type, including the boundary.
 * @returns {{audio: Buffer, fields: Record<string, string>}} the uploaded audio and text fields.
 */
function parseMultipart(body, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  const boundary = (match?.[1] ?? match?.[2] ?? '').trim()
  if (!boundary) throw new Error('multipart body without a boundary')
  const delimiter = Buffer.from(`--${boundary}`)
  const fields = {}
  let audio = null
  let cursor = body.indexOf(delimiter)
  while (cursor >= 0) {
    const headerStart = cursor + delimiter.length
    const headerEnd = body.indexOf('\r\n\r\n', headerStart)
    if (headerEnd < 0) break
    const headers = body.toString('latin1', headerStart, headerEnd)
    const next = body.indexOf(delimiter, headerEnd)
    const contentEnd = next < 0 ? body.length : next - 2
    const content = body.subarray(headerEnd + 4, Math.max(headerEnd + 4, contentEnd))
    const name = /name="([^"]*)"/i.exec(headers)?.[1]
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1]
    if (name === 'file' && filename !== undefined) audio = content
    else if (name && !filename) fields[name] = content.toString('utf8').trim()
    cursor = next
  }
  if (!audio) throw new Error('multipart body has no file part')
  return { audio: Buffer.from(audio), fields }
}

/**
 * Write a JSON response.
 * @param {import('node:http').ServerResponse} response - response to write.
 * @param {number} status - HTTP status code.
 * @param {object} payload - JSON-serializable body.
 * @returns {void}
 */
function send(response, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' })
  response.end(body)
}
