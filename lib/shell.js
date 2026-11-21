/**
 * Shell backend resolution and execution.
 *
 * THE RULE THIS FILE EXISTS FOR
 * -----------------------------
 * A shell tool may only be published when its backend has been *proved* to run
 * on this machine. Availability is never inferred from "the file exists", and
 * an explicitly requested backend never silently degrades into another one.
 *
 * The disaster this prevents: a bad dsh-ops release published `ops_bash`, its
 * bundled payload failed to start, the fallback PowerShell rung also failed,
 * and the model burned turn after turn calling a tool that could never
 * succeed. Absence beats a broken tool: if nothing proves out, this plugin
 * publishes NO shell tool and leaves the host's own shell tool untouched.
 *
 * Backends here are pre-existing terminals only. Nothing is downloaded, and no
 * bash payload is shipped.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** Token the probe expects on stdout. Shared by every backend. */
const PROBE_TOKEN = 'dshops-shell-ok'

/**
 * Programs that are launchers rather than shells.
 *
 * `git-bash.exe` opens a Mintty window and would hang a captured-stdio call
 * forever; `git-cmd.exe` opens a console. Selecting either one as a tool shell
 * manufactures exactly the failure mode this plugin is meant to remove.
 */
const LAUNCHER_BASENAMES = new Set(['git-bash.exe', 'git-cmd.exe', 'wish.exe', 'start.exe'])

function winNormalize(file) {
  return path.win32.normalize(file).replace(/[\\/]+$/, '').toLowerCase()
}

function envValue(env, ...names) {
  for (const name of names) {
    const value = env?.[name]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

/**
 * Whether a candidate is a WSL launcher masquerading as bash.
 *
 * `%SystemRoot%\System32\bash.exe` and the Store alias under `%LOCALAPPDATA%`
 * both run commands inside a Linux distribution: silently a different machine,
 * a different filesystem, and a different toolchain. Never select them.
 */
export function isWslLauncher(file, env = process.env) {
  const candidate = winNormalize(file)
  const systemRoot = envValue(env, 'SystemRoot', 'SYSTEMROOT')
  if (systemRoot && candidate === winNormalize(path.win32.join(systemRoot, 'System32', 'bash.exe'))) return true
  const localAppData = envValue(env, 'LOCALAPPDATA', 'LocalAppData')
  if (localAppData) {
    if (candidate === winNormalize(path.win32.join(localAppData, 'Microsoft', 'WindowsApps', 'bash.exe'))) return true
    if (candidate === winNormalize(path.win32.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe'))) return false
  }
  return false
}

/** Whether a path names a launcher that must never be used as a tool shell. */
export function isLauncher(file) {
  return LAUNCHER_BASENAMES.has(path.win32.basename(file).toLowerCase())
}

function isSpawnableFile(file) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return false
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function onPath(names, env) {
  const raw = envValue(env, 'PATH', 'Path') ?? ''
  const found = []
  for (const entry of raw.split(path.win32.delimiter)) {
    if (entry === '') continue
    for (const name of names) {
      const candidate = path.win32.join(entry, name)
      if (isSpawnableFile(candidate)) found.push(candidate)
    }
  }
  return found
}

/**
 * Git roots derived from the `git.exe` that is actually on PATH.
 *
 * A machine may install Git anywhere (`D:\Program Files\Git` is common when the
 * system drive is not where programs live), so guessing `%ProgramFiles%` is not
 * enough. `git.exe` on PATH is authoritative evidence of the real root: either
 * `<root>\cmd\git.exe` or `<root>\bin\git.exe`.
 * @returns {string[]} candidate Git roots, most specific first.
 */
function gitRootsFromPath(env) {
  const roots = []
  const push = (root) => {
    if (root && !roots.some(r => winNormalize(r) === winNormalize(root))) roots.push(root)
  }
  for (const git of onPath(['git.exe'], env)) {
    const dir = path.win32.dirname(git)              // ...\cmd or ...\bin
    const parent = path.win32.dirname(dir)           // ...\Git
    const base = path.win32.basename(dir).toLowerCase()
    if (base === 'cmd' || base === 'bin') push(parent)
    push(dir)
  }
  return roots
}

/**
 * Git Bash candidates, most specific first.
 * @returns {string[]} absolute candidates, launchers and WSL excluded.
 */
export function gitbashCandidates(env = process.env, configured = '') {
  const seen = new Set()
  const push = (list, file) => {
    if (typeof file !== 'string' || file.trim() === '') return
    const key = winNormalize(file)
    if (seen.has(key) || isLauncher(file) || isWslLauncher(file, env)) return
    seen.add(key)
    list.push(path.win32.normalize(file))
  }
  const list = []
  // An explicitly configured path is authoritative and tried alone.
  if (typeof configured === 'string' && configured.trim() !== '') {
    push(list, configured.trim())
    return list
  }
  const programFiles = envValue(env, 'ProgramFiles', 'PROGRAMFILES') ?? 'C:\\Program Files'
  const programFilesX86 = envValue(env, 'ProgramFiles(x86)', 'PROGRAMFILES(X86)') ?? 'C:\\Program Files (x86)'
  const localAppData = envValue(env, 'LOCALAPPDATA', 'LocalAppData')
  const userProfile = envValue(env, 'USERPROFILE')
  // bin\bash.exe is the shell; usr\bin\bash.exe is the same MSYS2 bash.
  for (const root of [programFiles, programFilesX86]) {
    push(list, path.win32.join(root, 'Git', 'bin', 'bash.exe'))
    push(list, path.win32.join(root, 'Git', 'usr', 'bin', 'bash.exe'))
  }
  if (localAppData) {
    push(list, path.win32.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'))
    push(list, path.win32.join(localAppData, 'Programs', 'Git', 'usr', 'bin', 'bash.exe'))
  }
  // Installs outside %ProgramFiles% (a non-system drive, a custom root): derive
  // them from the git.exe that is on PATH instead of guessing drive letters.
  for (const root of gitRootsFromPath(env)) {
    push(list, path.win32.join(root, 'bin', 'bash.exe'))
    push(list, path.win32.join(root, 'usr', 'bin', 'bash.exe'))
  }
  for (const candidate of onPath(['bash.exe'], env)) push(list, candidate)
  if (userProfile) {
    push(list, path.win32.join(userProfile, 'scoop', 'shims', 'bash.exe'))
    push(list, path.win32.join(userProfile, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'))
  }
  push(list, 'C:\\ProgramData\\chocolatey\\bin\\bash.exe')
  push(list, 'C:\\msys64\\usr\\bin\\bash.exe')
  push(list, 'C:\\tools\\msys64\\usr\\bin\\bash.exe')
  return list
}

/**
 * PowerShell candidates, PowerShell 7 before Windows PowerShell 5.1.
 *
 * 5.1 is included deliberately: many Windows machines have no `pwsh.exe` at
 * all, and the host's own shell tool already works through it. Omitting it
 * would report "no PowerShell" on machines that plainly have one.
 * @returns {string[]} absolute candidates.
 */
export function pwshCandidates(env = process.env, configured = '') {
  const list = []
  const push = (file) => {
    if (typeof file === 'string' && file.trim() !== '' && !list.some(f => winNormalize(f) === winNormalize(file))) {
      list.push(path.win32.normalize(file))
    }
  }
  if (typeof configured === 'string' && configured.trim() !== '') {
    push(configured.trim())
    return list
  }
  const programFiles = envValue(env, 'ProgramFiles', 'PROGRAMFILES') ?? 'C:\\Program Files'
  const programFilesX86 = envValue(env, 'ProgramFiles(x86)', 'PROGRAMFILES(X86)') ?? 'C:\\Program Files (x86)'
  const localAppData = envValue(env, 'LOCALAPPDATA', 'LocalAppData')
  const systemRoot = envValue(env, 'SystemRoot', 'SYSTEMROOT') ?? 'C:\\Windows'
  push(path.win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe'))
  push(path.win32.join(programFiles, 'PowerShell', '7-preview', 'pwsh.exe'))
  if (localAppData) push(path.win32.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe'))
  for (const candidate of onPath(['pwsh.exe'], env)) push(candidate)
  push(path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  return list
}

/** How one backend names its executable family. */
export function backendLabel(file) {
  const base = path.win32.basename(file).toLowerCase()
  if (base === 'powershell.exe') return 'Windows PowerShell 5.1'
  if (base === 'pwsh.exe') return 'PowerShell 7+'
  if (base === 'bash.exe') return 'Git Bash (MSYS2)'
  return base
}

function argvFor(kind, file, command) {
  if (kind === 'gitbash') return [file, '--noprofile', '--norc', '-c', command]
  return [file, '-NoProfile', '-NonInteractive', '-Command', command]
}

function probeCommand(kind) {
  return kind === 'gitbash'
    ? `printf '%s' '${PROBE_TOKEN}'`
    : `Write-Output '${PROBE_TOKEN}'`
}

/**
 * Prove that one executable can actually run a command.
 *
 * A file that exists but cannot execute is the whole bug class being avoided,
 * so this spawns the real thing with a fixed, side-effect-free command.
 * @returns {{ok: boolean, detail: string, version?: string}} the verdict.
 */
export function probeShell(kind, file, timeoutMs) {
  if (!fs.existsSync(file)) return { ok: false, absent: true, detail: 'not present on this machine' }
  if (!isSpawnableFile(file)) return { ok: false, detail: 'exists but is not an executable file' }
  if (isLauncher(file)) return { ok: false, detail: 'a terminal launcher, not a shell' }
  if (isWslLauncher(file)) return { ok: false, detail: 'a WSL launcher, not this machine\'s shell' }
  const argv = argvFor(kind, file, probeCommand(kind))
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    timeout: Math.max(1000, timeoutMs),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) return { ok: false, detail: `could not start: ${result.error.message}` }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim().split(/\r?\n/)[0] ?? ''
    return { ok: false, detail: `self-test exited ${result.status}${stderr ? `: ${stderr}` : ''}` }
  }
  if (!(result.stdout ?? '').includes(PROBE_TOKEN)) {
    return { ok: false, detail: 'self-test produced no expected output' }
  }
  const version = spawnSync(argv[0], kind === 'gitbash' ? ['--version'] : ['-NoLogo', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
    encoding: 'utf8', timeout: Math.max(1000, timeoutMs), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  })
  const raw = (version.stdout ?? '').trim().split(/\r?\n/)[0] ?? ''
  return { ok: true, detail: 'self-test passed', version: raw === '' ? undefined : raw }
}

/**
 * Resolve the one shell backend this deployment may publish.
 *
 * `auto` tries Git Bash then PowerShell. An explicit backend tries only its own
 * family: if it fails, the result is "unavailable", never a quiet switch to the
 * other one. Every attempt is reported so the reason is visible in the UI log.
 * @returns {{
 *   backend: 'gitbash'|'pwsh'|null, file: string|undefined, label: string,
 *   version?: string, detail: string,
 *   tried: Array<{kind: string, file: string, ok: boolean, detail: string}>
 * }}
 */
export function resolveShell(config = {}, env = process.env) {
  const shell = config.shell ?? {}
  const timeoutMs = Number.isFinite(shell.probeTimeoutMs) ? shell.probeTimeoutMs : 15000
  const requested = shell.backend ?? 'auto'
  const tried = []

  if (requested === 'none') {
    return { backend: null, file: undefined, label: 'none', detail: 'shell.backend is "none"; no shell tool is published.', tried }
  }

  const order = requested === 'auto'
    ? [
        { kind: 'gitbash', candidates: gitbashCandidates(env, shell.gitbashPath) },
        { kind: 'pwsh', candidates: pwshCandidates(env, shell.pwshPath) },
      ]
    : [{
        kind: requested,
        candidates: requested === 'gitbash'
          ? gitbashCandidates(env, shell.gitbashPath)
          : pwshCandidates(env, shell.pwshPath),
      }]

  for (const { kind, candidates } of order) {
    if (candidates.length === 0) {
      tried.push({ kind, file: '(none found)', ok: false, detail: 'no candidate paths on this machine' })
      continue
    }
    for (const file of candidates) {
      const verdict = probeShell(kind, file, timeoutMs)
      tried.push({ kind, file, ok: verdict.ok, absent: verdict.absent === true, detail: verdict.detail })
      if (verdict.ok) {
        return {
          backend: kind,
          file,
          label: backendLabel(file),
          version: verdict.version,
          detail: `${backendLabel(file)} at ${file} passed its self-test.`,
          tried,
        }
      }
    }
  }
  const reason = requested === 'auto'
    ? 'neither Git Bash nor PowerShell passed its self-test'
    : `the requested ${requested} backend did not pass its self-test`
  return {
    backend: null,
    file: undefined,
    label: 'none',
    detail: `${reason}; no shell tool is published and the host shell tool is left untouched.`,
    tried,
  }
}

/**
 * Runtime side of the same rule.
 *
 * A backend that starts failing during a session is retired after
 * `maxSpawnFailures` attempts so the model cannot loop on it. The failure is
 * then reported as terminal, with an explicit instruction not to retry and to
 * use the host shell tool instead.
 */
export function createShellRuntime(resolution, config = {}) {
  const limit = Number.isFinite(config.shell?.maxSpawnFailures) ? Math.max(1, config.shell.maxSpawnFailures) : 2
  let failures = 0
  let dead = resolution.backend === null
  return {
    get dead() { return dead },
    get backend() { return resolution.backend },
    get file() { return resolution.file },
    noteSuccess() { if (!dead) failures = 0 },
    /** @returns {Error & {terminal?: boolean}} */
    noteFailure(cause) {
      failures += 1
      const ended = failures >= limit
      if (ended) dead = true
      const error = new Error(
        ended
          ? `The ${resolution.label} shell has failed ${failures} times in this session and is now disabled. `
            + 'Do NOT retry it. Use the host shell tool for further commands.'
          : `The ${resolution.label} shell failed to run that command (${failures}/${limit}). `
            + 'One retry is allowed; if it fails again this tool is disabled for the session.'
            + (cause === undefined ? '' : ` Cause: ${cause instanceof Error ? cause.message : String(cause)}`)
      )
      error.terminal = ended
      return error
    },
    argv(command) { return argvFor(resolution.backend, resolution.file, command) },
  }
}