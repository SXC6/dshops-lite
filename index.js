/**
 * dshops-lite — a lean DSH plugin.
 *
 * What it adds: the ops_* file/search tools backed by the native Rust worker,
 * and at most ONE shell tool (Git Bash), published only when the plugin page's
 * "default terminal" setting asks for Git Bash and Git Bash proved it can run.
 *
 * What it deliberately does not add: a bundled bash payload, PTC/run_code,
 * progressive tool discovery, agent presets, doc readers, panels. Those are the
 * parts of dsh-ops that cost tokens and round trips.
 *
 * Two rules shape everything here:
 *
 * 1. A tool is registered only when it can actually run. A shell that cannot
 *    start is not published at all — the host's own pwsh tool stays available
 *    and the model never gets a tool that always fails.
 * 2. With the default terminal set to pwsh, this plugin publishes NO shell tool
 *    at all: the host's pwsh tool already is that terminal, and a second
 *    spelling of the same shell is pure schema cost.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createShellRuntime, resolveShell } from './lib/shell.js'
import { envelope, invokeWorker, resolveWorker } from './lib/worker.js'
import { absoluteTarget, fileToolDefinitions } from './lib/tools.js'

export const name = 'dshops-lite'

/**
 * Services this plugin needs. Declared as strings so the plugin imports no
 * host values at load time.
 */
export const inject = ['tools', 'subprocess', 'workingDirectory']

/**
 * The deployment's schemastery, reached through the profile's peer routing: a
 * link-installed package resolves a bare `@deepseek-ai/*` specifier from the
 * running installation when its own manifest lists that name under
 * `peerDependencies`. The import stays optional so this module also loads in a
 * plain Node process (the offline self-tests), where no such routing exists.
 * @type {typeof import('@deepseek-ai/schemastery').default | undefined}
 */
const Schema = await import('@deepseek-ai/schemastery')
  .then(module => module.default)
  .catch(() => undefined)

/** The two terminals the plugin page offers. */
export const DEFAULT_TERMINALS = ['pwsh', 'gitbash']

/**
 * Config schema. `defaultTerminal` is `.volatile()` on purpose: the Settings
 * form projection carries ONLY volatile fields, and a volatile edit updates the
 * running instance in place instead of remounting it. Everything else is
 * ordinary configuration, edited in cordis.patch.yml.
 */
export function buildConfig(Schema) {
  return Schema.object({
    defaultTerminal: Schema.union(DEFAULT_TERMINALS)
      .default('pwsh')
      .volatile()
      .description('Default terminal. "pwsh" leaves the host pwsh tool alone; "gitbash" publishes ops_shell.'),
    shell: Schema.object({
      gitbashPath: Schema.string().default('')
        .description('Absolute path to bash.exe. Empty means auto-discover.'),
      probeTimeoutMs: Schema.number().step(1000).min(1000).default(3000)
        .description('Deadline for the start-up self-test of each candidate.'),
      maxSpawnFailures: Schema.number().step(1).min(1).default(5)
        .description('Consecutive runtime failures before Git Bash is disabled for the session.'),
      stdoutMaxBytes: Schema.number().step(1024).min(4096).max(1048576).default(262144)
        .description('Bytes of stdout collected from one ops_shell command before the stream is capped.'),
      stderrMaxBytes: Schema.number().step(1024).min(4096).max(1048576).default(65536)
        .description('Bytes of stderr collected from one ops_shell command before the stream is capped.'),
      graceMs: Schema.number().step(100).min(0).max(10000).default(1000)
        .description('Grace period before a cancelled ops_shell command is terminated.'),
    }).description('Git Bash discovery and guard rails.'),
    workerPath: Schema.string().default('')
      .description('Absolute path to a replacement worker binary. Empty means runtime/<platform>/.'),
    toolTimeoutMs: Schema.number().step(1000).min(1000).default(30000)
      .description('Per-call worker deadline for the ops_* file tools.'),
    maxResultBytes: Schema.number().step(1024).min(1024).max(131072).default(131072)
      .description('Result size budget in bytes for one ops_* call.'),
    denyCredentialReads: Schema.boolean().default(true)
      .description('Refuse reads of credential-looking files (~/.ssh, .npmrc, ...).'),
    promptSection: Schema.boolean().default(true)
      .description('Add the ops_* routing note to the system prompt.'),
  }).description('dshops-lite configuration.')
}

/**
 * Exported only when the schema builder resolves; without it the plugin still
 * works from cordis.patch.yml, it just has no page of its own.
 */
export const Config = Schema === undefined ? undefined : buildConfig(Schema)

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url))

/**
 * Routing note for the file tools. One compact sentence; the terminal identity
 * lives in the ops_shell tool description, so it is not repeated here.
 */
const ROUTING_SECTION = 'For file work use the ops_* tools: ops_grep to search, ops_glob to list,'
  + ' ops_inspect_local_file or ops_read_files to read, ops_edit_file or ops_replace to change a'
  + ' file, and ops_batch to run several operations in one call. Pass the ops_stat revision to tools'
  + ' that take expectedRevision; ops_replace never takes one.'

/**
 * Read a config value that the loader may hand over as a Volatile reference.
 * @param {unknown} value - plain value or Volatile<T>.
 * @returns {unknown} the current value.
 */
function liveValue(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

/**
 * Clamp a numeric config value into its documented range. A missing or invalid
 * value falls back to the default, so a bad patch can never hand the host a
 * buffer or timeout outside its own contract.
 */
function clamp(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** @returns {'pwsh'|'gitbash'} the current default terminal. */
function readTerminal(config) {
  return liveValue(config?.defaultTerminal) === 'gitbash' ? 'gitbash' : 'pwsh'
}

/** Session facts the tools need: working directory, scope id, read-only flag. */
async function sessionFacts(ctx, exec) {
  let cwd
  try {
    cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
  } catch {
    cwd = undefined
  }
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    // A worker call needs an absolute root. Without one, refuse rather than
    // guess: a wrong root means every later path is resolved against it.
    throw new Error('No absolute session working directory is available; refusing to guess the worker root.')
  }
  // The worker rejects non-normalized paths lexically, so normalize once here.
  cwd = path.normalize(cwd)
  const session = exec.agent?.session
  const scope = typeof session?.id === 'string' && session.id !== '' ? session.id : 'dshops-lite'
  let readOnly = false
  try {
    const policy = ctx.get('sandboxPolicy')
    if (policy && typeof policy.resolve === 'function') {
      const resolved = await Promise.resolve(policy.resolve({ session }))
      readOnly = resolved?.mode === 'read-only'
    }
  } catch {
    readOnly = false
  }
  return { cwd, scope, readOnly }
}

/**
 * @param {object} ctx - the plugin context.
 * @param {object} config - the row config from cordis.patch.yml.
 */
export function apply(ctx, config = {}) {
  const disposers = []
  const keep = (disposer) => { if (typeof disposer === 'function') disposers.push(disposer) }

  // One log line per event: the host's own log when there is a logger, stderr
  // when this module runs in a plain Node process (the offline self-tests).
  const note = (message) => {
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(message)
    else console.warn(message)
  }

  if (Config === undefined) {
    note('dshops-lite: schemastery did not resolve, so the plugin page cannot edit the default terminal.')
  }

  // ---- native worker ----------------------------------------------------
  let worker
  try {
    worker = resolveWorker(PACKAGE_ROOT, config)
  } catch (error) {
    // No worker means no file tools. Say why once, leave the host untouched.
    note(`dshops-lite: native worker unavailable, ops_* file tools are disabled. ${error.message}`)
  }

  const invoke = async (tool, args, { cwd, scope, readOnly, exec }) => {
    if (!worker) throw new Error('The native worker is not available in this deployment.')
    const request = envelope(tool, args, {
      root: cwd,
      scope,
      readOnly,
      denyCredentialNames: config.denyCredentialReads !== false,
      timeoutMs: Number.isFinite(config.toolTimeoutMs) ? config.toolTimeoutMs : 30000,
      maxBytes: clamp(config.maxResultBytes, 1024, 131072, 131072),
    })
    return invokeWorker(ctx.subprocess, worker.file, request, { cwd, signal: exec.signal })
  }

  if (worker) {
    const session = (exec) => sessionFacts(ctx, exec)
    for (const definition of fileToolDefinitions({ invoke, session })) {
      try {
        keep(ctx.tools.register(definition))
      } catch (error) {
        note(`dshops-lite: could not register ${definition.name}: ${error.message}`)
      }
    }
    note(`dshops-lite: registered native file tools from ${worker.detail}.`)
  }

  // ---- shell ------------------------------------------------------------
  // The live state the shell tool reads. `publishShell()` and `retireShell()`
  // bracket every resolution, including the one a settings edit triggers, so
  // the model never sees two shell tools or a retired one.
  const state = { terminal: readTerminal(config), disposeTool: null }

  const retireShell = () => {
    if (typeof state.disposeTool === 'function') {
      try {
        state.disposeTool()
      } catch {
        // Disposal must never take the host down.
      }
    }
    state.disposeTool = null
  }

  const publishShell = () => {
    const resolution = resolveShell(config, state.terminal)
    const shell = createShellRuntime(resolution, config)
    // Log only what an operator can act on: a candidate that exists but failed,
    // one summary line for the paths that simply are not installed, and the
    // configured path when the operator named one that did not prove out.
    const failedCandidates = resolution.tried.filter(attempt => !attempt.ok && !attempt.absent)
    const absentCount = resolution.tried.filter(attempt => attempt.absent).length
    for (const attempt of failedCandidates) {
      note(`dshops-lite: shell candidate failed its self-test — ${attempt.file}: ${attempt.detail}`)
    }
    if (absentCount > 0) {
      note(`dshops-lite: ${absentCount} shell candidate path(s) not installed on this machine.`)
    }
    const configured = typeof config.shell?.gitbashPath === 'string' ? config.shell.gitbashPath.trim() : ''
    if (configured !== '' && resolution.backend === null) {
      const attempt = resolution.tried.find(candidate => candidate.file === configured)
      note(`dshops-lite: the configured Git Bash path ${configured} did not pass`
        + `${attempt === undefined ? '' : ` (${attempt.detail})`}.`)
    }
    if (resolution.backend === null) {
      // The important branch: publishing nothing is the correct outcome here.
      note(`dshops-lite: no shell tool published. ${resolution.detail}`)
      return
    }
    note(`dshops-lite: shell = ${resolution.label} (${resolution.file}); ops_shell will be published.`)
    const versionNote = resolution.version ? ` Detected: ${resolution.version}.` : ''
    // Quote the configured budget so the description states the real threshold
    // instead of a vague "it fails".
    const failureBudget = Number.isFinite(config.shell?.maxSpawnFailures)
      ? Math.max(1, Math.floor(config.shell.maxSpawnFailures))
      : 5
    try {
      state.disposeTool = ctx.tools.register({
        name: 'ops_shell',
        description: `Run a command in ${resolution.label}, the default terminal here. Backend is fixed at `
          + `${resolution.file} and cannot fall back to a different shell; after ${failureBudget} consecutive `
          + `failures it is disabled for the session.${versionNote} The host pwsh tool remains available `
          + `for PowerShell-specific work.`,
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            command: { type: 'string', description: 'Command line to run on Git Bash.' },
            cwd: { type: 'string', description: 'Working directory; defaults to the session cwd.' },
          },
          required: ['command'],
        },
        output: {
          schema: { type: 'object' },
          render: (_args, value) => [{
            type: 'text',
            text: [
              `exit: ${value.exitCode}`,
              value.stdout ? `--- stdout ---\n${value.stdout}` : '',
              value.stderr ? `--- stderr ---\n${value.stderr}` : '',
              // A capped stream is never reported as a complete one.
              Array.isArray(value.truncated) && value.truncated.length > 0
                ? `[${value.truncated.join(' and ')} truncated at the collector cap; narrow the command to see the rest]`
                : '',
            ].filter(Boolean).join('\n'),
          }],
        },
        async execute(args, exec) {
          if (shell.dead) {
            throw new Error(
              `The ${resolution.label} shell is disabled for this session after repeated failures. `
              + 'Do not retry it; use the host pwsh tool.'
            )
          }
          const { cwd: sessionCwd, readOnly } = await sessionFacts(ctx, exec)
          // The worker enforces read-only for every file operation; a shell that
          // ignored it would be a hole straight through that promise. The host's
          // own pwsh tool keeps its sandbox for these sessions.
          if (readOnly) {
            throw new Error(
              'This session is read-only, so ops_shell does not run commands. '
              + 'Do not retry it; use the host pwsh tool, which applies the sandbox policy.'
            )
          }
          const cwd = typeof args.cwd === 'string' && args.cwd !== '' ? absoluteTarget(args.cwd, sessionCwd) : sessionCwd
          const argv = shell.argv(String(args.command ?? ''))
          let handle
          let outcome
          try {
            handle = ctx.subprocess.spawn({
              argv,
              cwd,
              stdio: {
                stdout: { maxBytes: clamp(config.shell?.stdoutMaxBytes, 4096, 1048576, 262144) },
                stderr: { maxBytes: clamp(config.shell?.stderrMaxBytes, 4096, 1048576, 65536) },
              },
              graceMs: clamp(config.shell?.graceMs, 0, 10000, 1000),
              signal: exec.signal,
            })
            outcome = await handle.done
          } catch (error) {
            // A spawn failure is the exact event that used to cascade. Record it,
            // and hand back a terminal error once the budget is spent.
            throw shell.noteFailure(error)
          }
          const read = (stream) => {
            try {
              const chunk = stream ? stream.readFrom(0) : undefined
              return { text: chunk?.text ?? '', lossy: chunk?.lossy === true }
            } catch {
              return { text: '', lossy: false }
            }
          }
          const stdout = read(handle?.collected?.stdout)
          const stderr = read(handle?.collected?.stderr)
          const truncated = [
            stdout.lossy ? 'stdout' : '',
            stderr.lossy ? 'stderr' : '',
          ].filter(Boolean)
          const exitCode = outcome?.exitCode
          // A non-zero status is the command's own result — `grep` finding
          // nothing, `cat` missing a file, an unknown command (exit 127) — and
          // must come back as a normal value. Treating its stderr text as a
          // backend failure retired a perfectly good shell after repeated
          // ordinary mistakes, which is the loop this plugin exists to prevent.
          const backendBroken = exitCode === null || exitCode === undefined || outcome?.signal != null
          if (backendBroken) {
            throw shell.noteFailure(new Error(stderr.text.trim().split(/\r?\n/)[0] ?? `exit ${String(exitCode)}`))
          }
          shell.noteSuccess()
          return { exitCode, stdout: stdout.text, stderr: stderr.text, truncated }
        },
      })
    } catch (error) {
      note(`dshops-lite: could not register ops_shell: ${error.message}`)
    }
  }

  publishShell()

  // A volatile edit (the default-terminal setting) updates this instance in
  // place, so the shell has to be re-resolved here rather than at next mount.
  if (typeof ctx.on === 'function') {
    keep(ctx.on('loader/volatile-update', () => {
      const next = readTerminal(config)
      if (next === state.terminal) return
      state.terminal = next
      retireShell()
      publishShell()
    }))
  }

  // ---- small routing note ----------------------------------------------
  if (config.promptSection !== false) {
    try {
      const prompt = ctx.get('systemPrompt')
      if (prompt && typeof prompt.section === 'function') {
        keep(prompt.section({
          name: 'dshops-lite:routing',
          order: 3200,
          interpolate: false,
          // Evaluated per assembly; the note itself is static now that the
          // terminal identity is carried by the ops_shell description.
          text: () => ROUTING_SECTION,
        }))
      }
    } catch (error) {
      note(`dshops-lite: could not add the routing prompt section: ${error.message}`)
    }
  }

  // ---- settings page ownership -----------------------------------------
  // This row draws its own page in Plugins, so it must opt out of a generated
  // one. Registered through an optional child context: a deployment without the
  // settings service simply has no page to opt out of.
  try {
    ctx.inject?.(['settings'], (child) => {
      if (typeof child.settings?.configure !== 'function' || typeof child.effect !== 'function') return
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber), 'dshops-lite: settings page')
    })
  } catch (error) {
    note(`dshops-lite: could not declare the settings page policy: ${error.message}`)
  }

  return () => {
    retireShell()
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // Disposal must never take the host down.
      }
    }
  }
}