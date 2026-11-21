/**
 * dshops-lite — a lean DSH plugin.
 *
 * What it adds: the ops_* file/search tools backed by the native Rust worker,
 * and at most ONE shell tool whose backend was proved to work at start-up.
 *
 * What it deliberately does not add: a bundled bash payload, PTC/run_code,
 * progressive tool discovery, agent presets, doc readers, panels. Those are the
 * parts of dsh-ops that cost tokens and round trips.
 *
 * The one non-negotiable rule: a tool is registered only when it can actually
 * run. A shell that cannot start is not published at all — the host's own shell
 * tool stays available and the model never gets a tool that always fails.
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

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url))

const PROMPT_SECTION = [
  'For file work prefer the ops_* tools: ops_grep to search, ops_glob to list,',
  'ops_inspect_local_file or ops_read_files to read, ops_edit_file/ops_replace to',
  'change a file. Read ops_stat first and pass its revision to writes.',
  'When ops_shell exists it runs on one fixed backend; if it reports a failure,',
  'do not retry it — use the host shell tool instead.',
].join(' ')

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

  // ---- native worker ----------------------------------------------------
  let worker
  try {
    worker = resolveWorker(PACKAGE_ROOT, config)
  } catch (error) {
    // No worker means no file tools. Say why once, leave the host untouched.
    ctx.logger?.warn?.(`dshops-lite: native worker unavailable, ops_* file tools are disabled. ${error.message}`)
    console.warn(`dshops-lite: native worker unavailable, ops_* file tools are disabled. ${error.message}`)
  }

  const invoke = async (tool, args, { cwd, scope, readOnly, exec }) => {
    if (!worker) throw new Error('The native worker is not available in this deployment.')
    const request = envelope(tool, args, {
      root: cwd,
      scope,
      readOnly,
      denyCredentialNames: config.denyCredentialReads !== false,
      timeoutMs: Number.isFinite(config.toolTimeoutMs) ? config.toolTimeoutMs : 30000,
      maxBytes: 131072,
    })
    return invokeWorker(ctx.subprocess, worker.file, request, { cwd, signal: exec.signal })
  }

  if (worker) {
    const session = (exec) => sessionFacts(ctx, exec)
    for (const definition of fileToolDefinitions({ invoke, session })) {
      try {
        disposers.push(ctx.tools.register(definition))
      } catch (error) {
        console.warn(`dshops-lite: could not register ${definition.name}: ${error.message}`)
      }
    }
    console.warn(`dshops-lite: registered native file tools from ${worker.detail}.`)
  }

  // ---- shell ------------------------------------------------------------
  const resolution = resolveShell(config)
  const shell = createShellRuntime(resolution, config)
  // Log only what an operator can act on: a candidate that exists but failed,
  // and one summary line for the paths that simply are not installed.
  const failedCandidates = resolution.tried.filter(attempt => !attempt.ok && !attempt.absent)
  const absentCount = resolution.tried.filter(attempt => attempt.absent).length
  for (const attempt of failedCandidates) {
    console.warn(`dshops-lite: shell candidate failed its self-test — ${attempt.file}: ${attempt.detail}`)
  }
  if (absentCount > 0) {
    console.warn(`dshops-lite: ${absentCount} shell candidate path(s) not installed on this machine.`)
  }
  if (resolution.backend === null) {
    // The important branch: publishing nothing is the correct outcome here.
    console.warn(`dshops-lite: no shell tool published. ${resolution.detail}`)
  } else {
    console.warn(`dshops-lite: shell backend = ${resolution.label} (${resolution.file}). ops_shell will be published.`)
    const versionNote = resolution.version ? ` Detected: ${resolution.version}.` : ''
    try {
      disposers.push(ctx.tools.register({
        name: 'ops_shell',
        description: `Run a command in ${resolution.label}. Backend is fixed at ${resolution.file} and `
          + `cannot fall back to a different shell; if it fails it is disabled for the session.${versionNote}`,
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            command: { type: 'string', description: 'Command line to run on the configured backend.' },
            cwd: { type: 'string', description: 'Working directory; defaults to the session cwd.' },
            timeoutMs: { type: 'number', description: 'Per-call timeout in milliseconds.' },
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
            ].filter(Boolean).join('\n'),
          }],
        },
        async execute(args, exec) {
          if (shell.dead) {
            throw new Error(
              `The ${resolution.label} shell is disabled for this session after repeated failures. `
              + 'Do not retry it; use the host shell tool.'
            )
          }
          const { cwd: sessionCwd } = await sessionFacts(ctx, exec)
          const cwd = typeof args.cwd === 'string' && args.cwd !== '' ? absoluteTarget(args.cwd, sessionCwd) : sessionCwd
          const argv = shell.argv(String(args.command ?? ''))
          let handle
          let outcome
          try {
            handle = ctx.subprocess.spawn({
              argv,
              cwd,
              stdio: { stdout: { maxBytes: 262144 }, stderr: { maxBytes: 65536 } },
              graceMs: 1000,
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
              return stream ? stream.readFrom(0)?.text ?? '' : ''
            } catch {
              return ''
            }
          }
          const stdout = read(handle?.collected?.stdout)
          const stderr = read(handle?.collected?.stderr)
          const exitCode = outcome?.exitCode
          if (exitCode === 0) {
            shell.noteSuccess()
            return { exitCode, stdout, stderr }
          }
          // A non-zero status may be the command's own failure, which is a normal
          // result, not a backend failure. Only an unusable backend retires.
          const backendBroken = exitCode === null || exitCode === undefined
            || /cannot find|not recognized|No such file or directory|is not recognized/i.test(stderr)
            || outcome?.signal != null
          if (backendBroken) throw shell.noteFailure(new Error(stderr.trim().split(/\r?\n/)[0] ?? `exit ${exitCode}`))
          shell.noteSuccess()
          return { exitCode, stdout, stderr }
        },
      }))
    } catch (error) {
      console.warn(`dshops-lite: could not register ops_shell: ${error.message}`)
    }
  }

  // ---- small routing note ----------------------------------------------
  if (config.promptSection !== false) {
    try {
      const prompt = ctx.get('systemPrompt')
      if (prompt && typeof prompt.section === 'function') {
        disposers.push(prompt.section({
          name: 'dshops-lite:routing',
          order: 3200,
          interpolate: false,
          text: () => PROMPT_SECTION,
        }))
      }
    } catch (error) {
      console.warn(`dshops-lite: could not add the routing prompt section: ${error.message}`)
    }
  }

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // Disposal must never take the host down.
      }
    }
  }
}