/**
 * Rust worker invocation.
 *
 * The worker is one process per call: one JSON request on stdin, one JSON
 * result on stdout, exit code 0 even for tool-level failures. Two details are
 * load-bearing and easy to get wrong:
 *
 *  - stdin must be CLOSED. The worker reads to EOF; leaving the pipe open
 *    hangs the call forever, because its own watchdog starts only after decode.
 *  - a non-zero exit means "no result at all", not "an error result". Anything
 *    other than a clean 0 with parseable JSON has to be synthesized here.
 */
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Platforms the upstream worker is published for. */
const PLATFORMS = new Set(['win32-x64', 'linux-x64', 'darwin-arm64', 'darwin-x64'])

/** Worker file names, matching upstream `workerName()`. */
export function workerName(platform = process.platform) {
  return platform === 'win32' ? 'dsh-ops-worker.exe' : 'dsh-ops-worker'
}

/** `<platform>-<arch>` for the running host. */
export function targetId(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`
}

function readJson(file, what) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`${what} at ${file} could not be read: ${error.message}`)
  }
  // Windows editors and PowerShell add a UTF-8 BOM; JSON.parse rejects it.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${what} at ${file} is not valid JSON`)
  }
}

/**
 * Locate the worker executable.
 *
 * An explicit `workerPath` is trusted and used as-is (that is the seam for a
 * self-built binary). Otherwise `runtime/<target>/` next to this package is
 * used, and its `provenance.json` receipt is verified when present.
 * @returns {{file: string, detail: string, digest?: string}}
 */
export function resolveWorker(packageRoot, config = {}, platform = process.platform, arch = process.arch) {
  const explicit = typeof config.workerPath === 'string' ? config.workerPath.trim() : ''
  if (explicit !== '') {
    const file = path.resolve(explicit)
    if (!fs.existsSync(file)) throw new Error(`Configured workerPath does not exist: ${file}`)
    const stat = fs.statSync(file)
    if (!stat.isFile()) throw new Error(`Configured workerPath is not a file: ${file}`)
    const digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    return { file, detail: 'configured workerPath (provenance not checked)', digest }
  }
  const target = targetId(platform, arch)
  if (!PLATFORMS.has(target)) throw new Error(`Unsupported platform target: ${target}`)
  const dir = path.join(packageRoot, 'runtime', target)
  const file = path.join(dir, workerName(platform))
  if (!fs.existsSync(file)) {
    throw new Error(`No native worker at runtime/${target}/${workerName(platform)}; set workerPath or build native/ and copy it there.`)
  }
  if (!fs.statSync(file).isFile()) throw new Error(`Native worker path is not a file: ${file}`)
  const receiptFile = path.join(dir, 'provenance.json')
  if (fs.existsSync(receiptFile)) {
    // The digest is only consumed by the provenance check: hashing the whole
    // binary on every start is pure cost when there is no receipt to compare.
    const digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    const receipt = readJson(receiptFile, 'provenance receipt')
    if (receipt.target !== undefined && receipt.target !== target) {
      throw new Error(`Native worker provenance target ${receipt.target} does not match ${target}.`)
    }
    if (receipt.executable !== undefined && receipt.executable !== workerName(platform)) {
      throw new Error('Native worker provenance executable does not match.')
    }
    if (receipt.sha256 !== undefined && receipt.sha256 !== digest) {
      throw new Error('Native worker provenance mismatch: the binary was modified after it was staged.')
    }
    return { file, detail: `staged worker (provenance verified)`, digest }
  }
  return { file, detail: 'staged worker (no provenance receipt)' }
}

/**
 * Build the v1 envelope. Field names are snake_case inside `request` because the
 * Rust side does not rename them; `deny_unknown_fields` makes a typo a hard
 * refusal rather than a silent default.
 */
export function envelope(tool, args, options) {
  const maxBytes = Math.min(131072, Math.max(1024, options.maxBytes ?? 131072))
  const timeoutMs = Math.min(30000, Math.max(1, options.timeoutMs ?? 30000))
  return {
    version: 1,
    requestId: randomUUID(),
    component: 'file',
    budget: { timeoutMs, maxBytes },
    request: {
      root: options.root,
      scope: options.scope,
      tool,
      args,
      read_only: options.readOnly === true,
      deny_credential_names: options.denyCredentialNames !== false,
      ...(options.writeRoots && options.writeRoots.length > 0 ? { write_roots: options.writeRoots } : {}),
      ...(options.denyRoots && options.denyRoots.length > 0 ? { deny_roots: options.denyRoots } : {}),
    },
  }
}

/**
 * Run one worker call through the host's subprocess service.
 *
 * Returns the parsed result object on success. Tool-level failures come back as
 * `{status:'error', error:{...}}` and are returned, not thrown: the caller
 * decides how to surface them, because "read-only denied" and "worker missing"
 * deserve very different model-facing treatment.
 */
export async function invokeWorker(subprocess, file, requestEnvelope, options = {}) {
  const payload = JSON.stringify(requestEnvelope)
  const spec = {
    argv: [file],
    cwd: options.cwd,
    stdio: {
      stdin: { data: payload },
      stdout: { maxBytes: 131072 },
      stderr: { maxBytes: 16384 },
    },
    graceMs: 1000,
    ...(options.signal ? { signal: options.signal } : {}),
  }
  const handle = subprocess.spawn(spec)
  const outcome = await handle.done
  // One read per stream: `readFrom` walks the collected chunks, so reading
  // stdout twice paid that walk twice for a single boolean.
  const stdoutChunk = handle.collected?.stdout?.readFrom(0)
  const stderrChunk = handle.collected?.stderr?.readFrom(0)
  const stdoutText = stdoutChunk?.text ?? ''
  const stderrText = stderrChunk?.text ?? ''
  const lossy = stdoutChunk?.lossy === true
  const interrupted = Boolean(options.signal?.aborted || outcome?.signal)

  if (interrupted) {
    return { ok: false, transport: true, code: options.signal?.aborted ? 'ABORTED' : 'RESULT_UNKNOWN', message: 'The native call was interrupted.' }
  }
  if (outcome?.exitCode !== 0) {
    const tail = stderrText.trim().split(/\r?\n/).slice(-1)[0] ?? ''
    return {
      ok: false,
      transport: true,
      code: 'EXECUTOR_UNAVAILABLE',
      message: `The native worker exited with code ${outcome?.exitCode}${tail ? `: ${tail}` : ''}`,
    }
  }
  if (lossy) {
    return { ok: false, transport: true, code: 'OUTPUT_LIMIT', message: 'The native worker output exceeded the transport budget.' }
  }
  let value
  try {
    value = JSON.parse(stdoutText)
  } catch {
    return { ok: false, transport: true, code: 'RESULT_UNKNOWN', message: 'The native worker returned malformed JSON.' }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, transport: true, code: 'RESULT_UNKNOWN', message: 'The native worker returned an unexpected shape.' }
  }
  return { ok: true, value }
}