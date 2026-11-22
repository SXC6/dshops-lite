/**
 * Shell resolution and execution for the one shell this plugin can add.
 *
 * THE MODEL
 * ---------
 * The plugin page's "default terminal" setting (`defaultTerminal`, live) has
 * exactly two values, and only one of them adds a tool:
 *
 *   'pwsh'    — the host's own pwsh tool is the terminal, exactly as it is with
 *               this plugin switched off. This plugin publishes NO shell tool;
 *               publishing a second pwsh would only add schema cost and give
 *               the model two spellings of the same shell.
 *   'gitbash' — Git Bash becomes the default terminal through `ops_shell`,
 *               and the host's pwsh tool stays available beside it for
 *               PowerShell-specific work.
 *
 * THE RULE THIS FILE EXISTS FOR
 * -----------------------------
 * `ops_shell` may only be published when its backend has been *proved* to run
 * on this machine. Availability is never inferred from "the file exists", and a
 * configured path never silently degrades into another shell.
 *
 * The disaster this prevents: a bad dsh-ops release published `ops_bash`, its
 * bundled payload failed to start, the fallback PowerShell rung also failed,
 * and the model burned turn after turn calling a tool that could never
 * succeed. Absence beats a broken tool: if Git Bash does not prove out, this
 * plugin publishes NO shell tool and leaves the host's own shell tool
 * untouched.
 *
 * The shell here is a pre-existing terminal only. Nothing is downloaded, and no
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

/** How the resolved shell names its executable family. */
export function backendLabel(file) {
  const base = path.win32.basename(file).toLowerCase()
  if (base === 'bash.exe') return 'Git Bash (MSYS2)'
  return base
}

function argvFor(file, command) {
  return [file, '--noprofile', '--norc', '-c', command]
}

function probeCommand() {
  // One spawn proves both facts: the token line says the shell can run a
  // command, and the line after it is the version. The version read is
  // best-effort — if it prints nothing, the probe still passes and only the
  // version is lost.
  return `printf '%s\\n' '${PROBE_TOKEN}'; "\${BASH:-bash}" --version 2>/dev/null | head -n 1`
}

/**
 * Prove that one executable can actually run a command.
 *
 * A file that exists but cannot execute is the whole bug class being avoided,
 * so this spawns the real thing with a fixed, side-effect-free command. One
 * spawn does both jobs: it runs the command and reports the version from the
 * same stdout, so a passing probe costs a single process start.
 * @returns {{ok: boolean, detail: string, version?: string}} the verdict.
 */
export function probeShell(file, timeoutMs = 3000) {
  if (!fs.existsSync(file)) return { ok: false, absent: true, detail: 'not present on this machine' }
  if (!isSpawnableFile(file)) return { ok: false, detail: 'exists but is not an executable file' }
  if (isLauncher(file)) return { ok: false, detail: 'a terminal launcher, not a shell' }
  if (isWslLauncher(file)) return { ok: false, detail: 'a WSL launcher, not this machine\'s shell' }
  const argv = argvFor(file, probeCommand())
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
  const lines = (result.stdout ?? '').split(/\r?\n/)
  const tokenLine = lines.findIndex(line => line.includes(PROBE_TOKEN))
  if (tokenLine < 0) return { ok: false, detail: 'self-test produced no expected output' }
  // The version line follows the token; failing to read it drops only the
  // version, never the verdict.
  const version = lines.slice(tokenLine + 1).map(line => line.trim()).find(line => line !== '')
  return { ok: true, detail: 'self-test passed', version }
}

/**
 * Resolve the shell this deployment may publish for one default terminal.
 *
 * 'pwsh' resolves to no tool at all — deliberately, and without probing: the
 * host owns that terminal. 'gitbash' probes the Git Bash family only; if it
 * fails, the result is "unavailable", never a quiet switch to another shell.
 * Every attempt is reported so the reason is visible in the UI log.
 * @param {object} config - the row config.
 * @param {'pwsh'|'gitbash'} terminal - the live default terminal.
 * @returns {{
 *   backend: 'gitbash'|null, hostOwned: boolean, file: string|undefined,
 *   label: string, version?: string, detail: string,
 *   tried: Array<{file: string, ok: boolean, detail: string}>
 * }}
 */
export function resolveShell(config = {}, terminal = 'pwsh', env = process.env) {
  const shell = config.shell ?? {}
  // spawnSync blocks the whole event loop for this deadline, once per candidate,
  // serially: a YAML typo must not be able to freeze start-up for minutes.
  const timeoutMs = Number.isFinite(shell.probeTimeoutMs)
    ? Math.min(15000, Math.max(1000, shell.probeTimeoutMs))
    : 3000
  const tried = []

  if (terminal !== 'gitbash') {
    return {
      backend: null,
      hostOwned: true,
      file: undefined,
      label: 'none',
      detail: 'the default terminal is pwsh, so the host pwsh tool serves it; no shell tool is published.',
      tried,
    }
  }

  const candidates = gitbashCandidates(env, shell.gitbashPath)
  if (candidates.length === 0) {
    tried.push({ file: '(none found)', ok: false, detail: 'no candidate paths on this machine' })
  }
  for (const file of candidates) {
    const verdict = probeShell(file, timeoutMs)
    tried.push({ file, ok: verdict.ok, absent: verdict.absent === true, detail: verdict.detail })
    if (verdict.ok) {
      return {
        backend: 'gitbash',
        hostOwned: false,
        file,
        label: backendLabel(file),
        version: verdict.version,
        detail: `${backendLabel(file)} at ${file} passed its self-test.`,
        tried,
      }
    }
  }
  return {
    backend: null,
    hostOwned: true,
    file: undefined,
    label: 'none',
    detail: 'the default terminal is Git Bash but no Git Bash passed its self-test; '
      + 'no shell tool is published and the host pwsh tool is left untouched.',
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
  const limit = Number.isFinite(config.shell?.maxSpawnFailures) ? Math.max(1, Math.floor(config.shell.maxSpawnFailures)) : 5
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
          ? `The ${resolution.label} shell has failed ${failures} consecutive times in this session and is now disabled. `
            + 'Do NOT retry it. Use the host pwsh tool for further commands.'
          : `The ${resolution.label} shell failed to run that command (${failures}/${limit} consecutive failures). `
            + `It is disabled after ${limit} consecutive failures in this session.`
            + (cause === undefined ? '' : ` Cause: ${cause instanceof Error ? cause.message : String(cause)}`)
      )
      error.terminal = ended
      return error
    },
    argv(command) { return argvFor(resolution.file, command) },
  }
}