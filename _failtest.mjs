/**
 * Anti-disaster and live-setting assertions. These encode the requirement:
 *   a shell that cannot be proved to work must NOT be published, an explicit
 *   path must never silently become a different shell, the default-terminal
 *   setting must add or retire the shell tool without a restart, and a batch
 *   must report every operation truthfully instead of hiding a failure.
 *
 * Run: node _failtest.mjs
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Config, buildConfig, apply } from './index.js'
import { isLauncher, isWslLauncher, probeShell } from './lib/shell.js'

let checks = 0
let failures = 0
const check = (label, condition, extra = '') => {
  checks += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`)
  if (!condition) failures += 1
}

function harness(overrides = {}) {
  const registered = new Map()
  const warnings = []
  const events = new Map()
  const sections = []
  let promptText
  const ctx = {
    subprocess: overrides.subprocess ?? { spawn: () => { throw new Error('not used') } },
    tools: { register: (d) => { registered.set(d.name, d); return () => registered.delete(d.name) } },
    workingDirectory: { ensure: async () => process.cwd() },
    get(key) {
      if (key === 'systemPrompt') {
        return {
          section: (definition) => {
            // Record the registration so a test can prove there is only ONE
            // routing section, not just that the last text looked right.
            const entry = { name: definition.name, order: definition.order, text: definition.text }
            sections.push(entry)
            promptText = definition.text
            return () => {
              promptText = undefined
              const at = sections.indexOf(entry)
              if (at >= 0) sections.splice(at, 1)
            }
          },
        }
      }
      return undefined
    },
    logger: { warn: (m) => warnings.push(m) },
    on(event, listener) {
      const list = events.get(event) ?? []
      list.push(listener)
      events.set(event, list)
      return () => {
        const current = events.get(event) ?? []
        events.set(event, current.filter(candidate => candidate !== listener))
      }
    },
    inject() { /* the fake host serves no settings service */ },
    fiber: {},
    // A tripwire: the plugin must never restrict another plugin's tool.
    restrictCalled: false,
  }
  const emit = (event, ...args) => { for (const listener of events.get(event) ?? []) listener(...args) }
  return {
    ctx,
    registered,
    warnings,
    emit,
    prompt: () => promptText?.(),
    promptSections: () => sections.slice(),
  }
}

/** A config value the loader would hand over as a Volatile reference. */
const volatile = (initial) => {
  const box = { value: initial, get: () => box.value }
  return box
}

/** Render a tool value through the definition's own renderer. */
const renderText = (definition, args, value) =>
  definition.output.render(args, value).map(block => block?.text ?? '').join('\n')

/**
 * A subprocess stand-in that answers worker calls from a scripted list.
 *
 * `entries` are consumed in order: `{value}` returns a worker JSON result on
 * stdout with exit 0, `{exitCode, stderr}` simulates a broken transport,
 * `{throw}` simulates a spawn that cannot even start. The last entry repeats.
 * Every request envelope is recorded so a test can inspect exactly which tool
 * ran with which normalized arguments, and how many worker processes started.
 */
function workerScript(entries) {
  const requests = []
  let spawned = 0
  return {
    requests,
    get spawned() { return spawned },
    spawn(spec) {
      const payload = JSON.parse(spec.stdio.stdin.data)
      requests.push(payload)
      const entry = entries[Math.min(spawned, entries.length - 1)]
      spawned += 1
      if (entry?.throw !== undefined) throw entry.throw
      const exitCode = entry?.exitCode ?? 0
      const stdoutText = exitCode === 0 ? JSON.stringify(entry?.value ?? { status: 'completed' }) : ''
      const stderrText = entry?.stderr ?? ''
      const stdout = { readFrom: () => ({ text: stdoutText, lossy: false }) }
      const stderr = { readFrom: () => ({ text: stderrText, lossy: false }) }
      return {
        done: Promise.resolve({ exitCode, signal: entry?.signal ?? null }),
        collected: { stdout, stderr },
      }
    },
  }
}

// ---- 1. default terminal pwsh: no shell tool at all --------------------
{
  const { ctx, registered, warnings } = harness()
  apply(ctx, { defaultTerminal: 'pwsh' })
  check('defaultTerminal "pwsh" publishes no ops_shell', !registered.has('ops_shell'))
  check('...and still publishes the file tools', registered.has('ops_grep'))
  check('...and says the host pwsh tool serves the terminal',
    warnings.some(w => /no shell tool published/i.test(w) && /pwsh/i.test(w)), warnings.join(' | '))
}

// ---- 2. default terminal gitbash, explicit path that cannot run -------
{
  const { ctx, registered, warnings } = harness()
  apply(ctx, { defaultTerminal: 'gitbash', shell: { gitbashPath: 'D:\\nope\\not-bash.exe' } })
  check('gitbash with a bad configured path publishes no ops_shell', !registered.has('ops_shell'))
  check('...and still publishes the file tools', registered.has('ops_grep'))
  check('...and never falls through to another shell',
    ![...registered.keys()].some(name => name === 'ops_shell'), `tools=${[...registered.keys()].length}`)
  check('...and reports the failed candidate', warnings.some(w => w.includes('not-bash.exe')), warnings.join(' | '))
}

// ---- 3. the live default-terminal setting republishes the tool --------
{
  const terminal = volatile('pwsh')
  const { ctx, registered, emit, prompt, promptSections } = harness()
  apply(ctx, { defaultTerminal: terminal })
  check('live setting starts on pwsh without ops_shell', !registered.has('ops_shell'))

  const routing = prompt() ?? ''
  check('the prompt adds exactly one routing section', promptSections().length === 1,
    `${promptSections().length} section(s)`)
  check('...and it names the search tool the model should reach for', routing.includes('ops_grep'))
  // The terminal identity is a fact about ops_shell only. Repeating it in the
  // prompt costs tokens and can contradict the live setting, so it must not
  // appear there at all.
  check('...and it carries no terminal-identity sentence',
    !/default terminal|host pwsh|Git Bash/i.test(routing), routing)
  check('...and it is a single paragraph under 400 characters',
    routing.length > 0 && routing.length < 400 && !routing.includes('\n'), `${routing.length} chars`)

  terminal.value = 'gitbash'
  emit('loader/volatile-update', [['defaultTerminal']])
  check('switching to Git Bash publishes ops_shell', registered.has('ops_shell'))
  const description = registered.get('ops_shell')?.description ?? ''
  check('...describes Git Bash as the default terminal here',
    /Git Bash/.test(description) && /the default terminal here/.test(description))
  check('...and says the host pwsh tool stays available', /pwsh/.test(description))
  // The description must state the real threshold: "if it fails it is disabled"
  // read as "one failure retires it" and made the model abandon a working shell.
  check('...and states the configured consecutive-failure budget',
    /after 5 consecutive failures/.test(description), description)
  check('...the routing prompt still adds no terminal identity',
    !/default terminal|host pwsh|Git Bash/i.test(prompt() ?? ''), prompt())
  check('...and the routing prompt text is unchanged by the setting', prompt() === routing)

  terminal.value = 'pwsh'
  emit('loader/volatile-update', [['defaultTerminal']])
  check('switching back to pwsh retires ops_shell', !registered.has('ops_shell'))
  check('...and the file tools survive the switch', registered.has('ops_grep'))
}

// ---- 4. a launcher is never accepted as a shell ------------------------
{
  const launcher = 'D:\\Program Files\\Git\\git-bash.exe'
  const verdict = probeShell(launcher, 5000)
  check('git-bash.exe (GUI launcher) is refused', verdict.ok === false, verdict.detail)
}

// ---- 5. WSL launchers are recognised regardless of presence ----------
{
  // Asserting on the guard itself: a presence check would pass even if the WSL
  // rule were deleted, because these paths need not exist.
  const sysRoot = 'C:\\Windows'
  const local = 'C:\\Users\\someone\\AppData\\Local'
  check('System32\\bash.exe is classified as a WSL launcher',
    isWslLauncher(`${sysRoot}\\System32\\bash.exe`, { SystemRoot: sysRoot, LOCALAPPDATA: local }))
  check('the Store bash alias is classified as a WSL launcher',
    isWslLauncher(`${local}\\Microsoft\\WindowsApps\\bash.exe`, { SystemRoot: sysRoot, LOCALAPPDATA: local }))
  check('Git Bash is NOT classified as a WSL launcher',
    isWslLauncher('D:\\Program Files\\Git\\bin\\bash.exe', { SystemRoot: sysRoot, LOCALAPPDATA: local }) === false)
  check('git-bash.exe is classified as a launcher', isLauncher('D:\\Program Files\\Git\\git-bash.exe'))
  check('bin\\bash.exe is NOT classified as a launcher', isLauncher('D:\\Program Files\\Git\\bin\\bash.exe') === false)
}

// ---- 6. circuit breaker: the shipped DEFAULT budget is 5 failures ------
{
  let spawns = 0
  const brokenSubprocess = {
    spawn() {
      spawns += 1
      throw new Error('spawn ENOENT (simulated)')
    },
  }
  const { ctx, registered } = harness({ subprocess: brokenSubprocess })
  // Deliberately no shell.maxSpawnFailures here: the default must be the
  // shipped 5. The old sequence was two retries then a terminal failure.
  apply(ctx, { defaultTerminal: 'gitbash' })
  const shellTool = registered.get('ops_shell')
  check('ops_shell was published (real probe passed)', shellTool !== undefined)

  if (shellTool) {
    const exec = { agent: { session: { id: 'x' } }, signal: undefined }
    const errors = []
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        await shellTool.execute({ command: 'echo hi' }, exec)
        errors.push(new Error('(returned a value instead of failing)'))
      } catch (error) {
        errors.push(error)
      }
    }
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const error = errors[attempt - 1]
      check(`default budget: failure ${attempt} of 5 is non-terminal and says ${attempt}/5`,
        error.terminal !== true && error.message.includes(`${attempt}/5`), error.message)
    }
    check('default budget: the retry hint no longer promises "One retry is allowed"',
      errors.slice(0, 4).every(error => !/One retry is allowed/.test(error.message)))
    check('default budget: the 5th failure is terminal (disabled / do not retry)',
      errors[4].terminal === true && /disabled/.test(errors[4].message) && /do not retry/i.test(errors[4].message),
      errors[4].message)
    check('default budget: a 6th call fails fast without spawning again',
      spawns === 5 && /disabled/.test(errors[5].message), `spawns=${spawns}`)
  }
}

// ---- 6a. an explicit failure budget still overrides the default -------
{
  let spawns = 0
  const brokenSubprocess = {
    spawn() {
      spawns += 1
      throw new Error('spawn ENOENT (simulated)')
    },
  }
  const { ctx, registered } = harness({ subprocess: brokenSubprocess })
  apply(ctx, { defaultTerminal: 'gitbash', shell: { maxSpawnFailures: 2 } })
  const shellTool = registered.get('ops_shell')
  check('ops_shell is published for the override test', shellTool !== undefined)

  if (shellTool) {
    const exec = { agent: { session: { id: 'x' } }, signal: undefined }
    const errors = []
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await shellTool.execute({ command: 'echo hi' }, exec)
        errors.push(new Error('(returned a value instead of failing)'))
      } catch (error) {
        errors.push(error)
      }
    }
    check('an explicit maxSpawnFailures: 2 is still honored (1/2 is non-terminal)',
      errors[0].terminal !== true && errors[0].message.includes('1/2'), errors[0].message)
    check('...the 2nd failure is terminal at 2/2, not at the default 5',
      errors[1].terminal === true && /disabled/.test(errors[1].message), errors[1].message)
    check('...and the 3rd call fails fast without spawning',
      spawns === 2 && /disabled/.test(errors[2].message), `spawns=${spawns}`)
  }
}

// ---- 6b. an ordinary command failure is a result, not a broken backend ---
{
  // `cat missing.txt` and `command-not-found` produce non-zero statuses whose
  // stderr looks like "No such file or directory". Treating that text as a
  // backend failure retired a working shell after two ordinary mistakes.
  let spawns = 0
  const failingSubprocess = {
    spawn() {
      spawns += 1
      const stdout = { readFrom: () => ({ text: '', lossy: false }) }
      const stderr = { readFrom: () => ({ text: 'bash: cat: No such file or directory', lossy: false }) }
      return {
        done: Promise.resolve({ exitCode: 1, signal: null }),
        collected: { stdout, stderr },
        terminate() {},
      }
    },
  }
  const { ctx, registered } = harness({ subprocess: failingSubprocess })
  apply(ctx, { defaultTerminal: 'gitbash' })
  const shellTool = registered.get('ops_shell')
  check('ops_shell is published for the ordinary-failure test', shellTool !== undefined)
  if (shellTool) {
    const exec = { agent: { session: { id: 'x' } }, signal: undefined }
    const results = []
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        results.push(await shellTool.execute({ command: 'cat missing.txt' }, exec))
      } catch (error) {
        results.push(error)
      }
    }
    check('a non-zero command returns as a value instead of throwing',
      results.every(result => !(result instanceof Error)) && results[0].exitCode === 1,
      JSON.stringify(results[0] instanceof Error ? results[0].message : results[0]))
    check('...and stderr is reported to the model', results[0]?.stderr?.includes('No such file'),
      String(results[0]?.stderr))
    // Five ordinary failures is exactly the default budget: they must not count,
    // so the shell stays usable.
    check('...and the shell is still usable after five ordinary failures', spawns === 5, `spawns=${spawns}`)
  }

  const timed = registered.get('ops_shell')?.parameters?.properties ?? {}
  check('ops_shell advertises no parameter it cannot honor', timed.timeoutMs === undefined,
    Object.keys(timed).join(', '))
}

// ---- 6c. read-only sessions do not run the shell -----------------------
{
  // The worker refuses writes in a read-only session; a shell that ignored the
  // same policy would punch a hole straight through that promise.
  let spawns = 0
  const readonlyCtxHook = { resolve: async () => ({ mode: 'read-only' }) }
  const subprocess = {
    spawn() {
      spawns += 1
      return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: {} }
    },
  }
  const { ctx, registered } = harness({ subprocess })
  const get = ctx.get
  ctx.get = (key) => (key === 'sandboxPolicy' ? readonlyCtxHook : get.call(ctx, key))
  apply(ctx, { defaultTerminal: 'gitbash' })
  const shellTool = registered.get('ops_shell')
  check('ops_shell is published for the read-only test', shellTool !== undefined)
  if (shellTool) {
    const exec = { agent: { session: { id: 'x' } }, signal: undefined }
    let message = ''
    try {
      await shellTool.execute({ command: 'echo hi > out.txt' }, exec)
    } catch (error) {
      message = error.message
    }
    check('a read-only session refuses the command', /read-only/.test(message), message)
    check('...without spawning anything', spawns === 0, `spawns=${spawns}`)
  }
}

// ---- 6d. a capped stream is never reported as complete ----------------
{
  const lossySubprocess = {
    spawn() {
      const stdout = { readFrom: () => ({ text: 'a'.repeat(20), lossy: true }) }
      const stderr = { readFrom: () => ({ text: '', lossy: false }) }
      return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout, stderr } }
    },
  }
  const { ctx, registered } = harness({ subprocess: lossySubprocess })
  apply(ctx, { defaultTerminal: 'gitbash' })
  const shellTool = registered.get('ops_shell')
  if (shellTool) {
    const exec = { agent: { session: { id: 'x' } }, signal: undefined }
    const value = await shellTool.execute({ command: 'seq 1 1000000' }, exec)
    const rendered = renderText(shellTool, {}, value)
    check('a lossy stream says it was truncated', /stdout truncated at the collector cap/.test(rendered), rendered)
    check('...and the value carries the fact', Array.isArray(value.truncated) && value.truncated.includes('stdout'),
      JSON.stringify(value.truncated))

    // The declared output contract must be the shape execute() really returns.
    // A code-mode consumer reads these fields directly, so a declaration that
    // drifted from the value is worse than no declaration: it reads as truth.
    const schema = shellTool.output?.schema ?? {}
    const declared = Object.keys(schema.properties ?? {}).sort()
    const actual = Object.keys(value).sort()
    check('ops_shell declares its output fields',
      JSON.stringify(declared) === JSON.stringify(['exitCode', 'stderr', 'stdout', 'truncated']),
      declared.join(','))
    check('...and the declaration is exactly what execute() returns',
      JSON.stringify(declared) === JSON.stringify(actual), `declared=${declared} actual=${actual}`)
    check('...with every declared field required',
      JSON.stringify([...(schema.required ?? [])].sort()) === JSON.stringify(declared),
      JSON.stringify(schema.required))
    check('...and "truncated" can only name the two streams',
      JSON.stringify(schema.properties?.truncated?.items?.enum) === JSON.stringify(['stdout', 'stderr']),
      JSON.stringify(schema.properties?.truncated?.items?.enum))
    check('...and the declared field types match the returned values',
      schema.properties?.exitCode?.type === 'integer'
        && schema.properties?.stdout?.type === 'string'
        && schema.properties?.stderr?.type === 'string'
        && schema.properties?.truncated?.type === 'array'
        && Number.isInteger(value.exitCode)
        && typeof value.stdout === 'string'
        && typeof value.stderr === 'string'
        && Array.isArray(value.truncated),
      JSON.stringify({ schema: Object.fromEntries(declared.map(k => [k, schema.properties[k]?.type])), value: { exitCode: typeof value.exitCode, stdout: typeof value.stdout, stderr: typeof value.stderr, truncated: Array.isArray(value.truncated) } }))
  }
}

// ---- 6e. collector caps and result budgets are clamped, never trusted ----
{
  // A patch can name any number; the spawn call must never receive a cap
  // outside the documented range (a 10 MB stdout cap is a memory hazard).
  const specs = []
  const subprocess = {
    spawn(spec) {
      specs.push(spec)
      return {
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: '', lossy: false }) },
          stderr: { readFrom: () => ({ text: '', lossy: false }) },
        },
      }
    },
  }
  const { ctx, registered } = harness({ subprocess })
  apply(ctx, {
    defaultTerminal: 'gitbash',
    shell: { stdoutMaxBytes: 99_999_999, stderrMaxBytes: 1, graceMs: 99_999 },
  })
  const shellTool = registered.get('ops_shell')
  check('ops_shell is published for the clamp test', shellTool !== undefined)
  if (shellTool) {
    await shellTool.execute({ command: 'echo hi' }, { agent: { session: { id: 'x' } }, signal: undefined })
    const spec = specs[0] ?? {}
    check('an oversized stdout cap is clamped to the documented maximum',
      spec.stdio?.stdout?.maxBytes === 1048576, JSON.stringify(spec.stdio?.stdout))
    check('an undersized stderr cap is clamped to the documented minimum',
      spec.stdio?.stderr?.maxBytes === 4096, JSON.stringify(spec.stdio?.stderr))
    check('an oversized grace period is clamped to the documented maximum',
      spec.graceMs === 10000, String(spec.graceMs))
  }

  // The worker request budget is clamped the same way before it becomes an
  // envelope: a bad patch cannot raise the transport cap, starve a result, or
  // hand the worker a deadline the host never promised.
  const exec = { agent: { session: { id: 'x' } }, signal: undefined }
  const statValue = { value: { status: 'completed', path: 'x', exists: false } }

  const bigScript = workerScript([statValue])
  const bigHarness = harness({ subprocess: bigScript })
  apply(bigHarness.ctx, { defaultTerminal: 'pwsh', maxResultBytes: 99_999_999 })
  await bigHarness.registered.get('ops_stat').execute({ path: 'x' }, exec)
  check('an oversized maxResultBytes is clamped to the transport cap',
    bigScript.requests[0]?.budget?.maxBytes === 131072,
    String(bigScript.requests[0]?.budget?.maxBytes))

  const tinyScript = workerScript([statValue])
  const tinyHarness = harness({ subprocess: tinyScript })
  apply(tinyHarness.ctx, { defaultTerminal: 'pwsh', maxResultBytes: 1 })
  await tinyHarness.registered.get('ops_stat').execute({ path: 'x' }, exec)
  check('an undersized maxResultBytes is clamped to the documented floor',
    tinyScript.requests[0]?.budget?.maxBytes === 1024,
    String(tinyScript.requests[0]?.budget?.maxBytes))

  const slowScript = workerScript([statValue])
  const slowHarness = harness({ subprocess: slowScript })
  apply(slowHarness.ctx, { defaultTerminal: 'pwsh', toolTimeoutMs: 99_999_999 })
  await slowHarness.registered.get('ops_stat').execute({ path: 'x' }, exec)
  check('an oversized toolTimeoutMs is clamped to the worker\'s own deadline',
    slowScript.requests[0]?.budget?.timeoutMs === 30000,
    String(slowScript.requests[0]?.budget?.timeoutMs))
}

// ---- 7. an unfinished search must never claim "no matches" ------------
{
  // Deterministic renderer test: a synthetic scan-budget result, so this does
  // not depend on how many files happen to exist on the machine.
  const { ctx, registered } = harness()
  apply(ctx, { defaultTerminal: 'pwsh' })
  const globDef = registered.get('ops_glob')
  check('ops_glob is registered for the renderer test', globDef !== undefined)

  if (globDef) {
    const budgetHit = {
      status: 'completed', phase: 'verify', complete: false, truncated: true,
      truncatedBy: 'scan-budget', scanComplete: false, pageComplete: true,
      items: [], matched: 0, matchedObserved: 0, nextOffset: 0,
      scannedFiles: 10000, failed: 1, skipped: 0,
    }
    const rendered = renderText(globDef, {}, budgetHit)
    check('scan-budget result does not say "(no matches)"', !rendered.includes('(no matches)'), rendered.split('\n')[0])
    check('scan-budget result says the search did not finish', /did not finish/.test(rendered))
    check('scan-budget result does not advise an offset retry', !/continue with offset/.test(rendered))
    check('scan-budget result still says no continuation and to narrow the path',
      /no continuation/.test(rendered) && /narrow the path/.test(rendered), rendered.split('\n').at(-1))

    const genuine = {
      status: 'completed', phase: 'verify', complete: true, truncated: false,
      truncatedBy: 'none', scanComplete: true, pageComplete: true,
      items: [], matched: 0, matchedObserved: 0, matchedTotal: 0, nextOffset: 0,
    }
    const cleanRender = renderText(globDef, {}, genuine)
    check('a completed empty search still says "(no matches)"', cleanRender.includes('(no matches)'), cleanRender.trim())
    check('a clean result mentions no truncation at all',
      !/truncat|incomplete|scan budget|continue with offset|narrow the path/i.test(cleanRender), cleanRender.trim())

    // The shipped worker reports a limit-truncated page as pageComplete:true — the
    // page itself was fully rendered, only more rows remain. Resumability therefore
    // has to come from the truncation cause; gating it on pageComplete made the
    // real offset retry unreachable and told the model to re-search instead.
    const morePages = {
      status: 'completed', phase: 'verify', complete: false, truncated: true,
      truncatedBy: 'row-limit', scanComplete: true, pageComplete: true,
      items: ['a.js'], matched: 5, matchedObserved: 5, matchedTotal: 5, nextOffset: 1,
    }
    const pagedRender = renderText(globDef, {}, morePages)
    check('a row-limited page (the real shape: pageComplete true) advises the real offset retry',
      /continue with offset=1/.test(pagedRender), pagedRender.trim())
    check('...and a resumable note does not contradict itself with a page/scan gap',
      !/page incomplete|scan incomplete/.test(pagedRender), pagedRender.trim())
  }

  // grep files_with_matches: `matchedTotal` counts lines, `items` counts files.
  const grepDef = registered.get('ops_grep')
  if (grepDef) {
    const filesMode = {
      status: 'completed', phase: 'verify', complete: true, truncated: false,
      truncatedBy: 'none', scanComplete: true, pageComplete: true,
      items: [{ path: 'a.js' }, { path: 'b.js' }], matched: 3, matchedObserved: 3,
      matchedTotal: 3, nextOffset: 2,
    }
    const out = renderText(grepDef, { outputMode: 'files_with_matches' }, filesMode)
    check('files_with_matches reports files and lines separately', /2 file\(s\); 3 matching line\(s\)/.test(out), out.split('\n').slice(-1)[0])
    check('files_with_matches does not call line counts "rows"', !/of 3 rows/.test(out))
  }
}

// ---- 8. tool descriptions must match what the worker really does -------
{
  // ops_replace is a literal `str::replace` in Rust, while ops_grep compiles a
  // regex. Advertising regex on replace makes the model write `\(` or `.*`,
  // get silently zero matches, and report "not found" for text that is there.
  const { ctx, registered } = harness()
  apply(ctx, { defaultTerminal: 'pwsh' })
  const replace = registered.get('ops_replace')
  const grep = registered.get('ops_grep')
  check('ops_replace is registered', replace !== undefined)
  check('ops_grep is registered', grep !== undefined)
  if (replace) {
    const text = `${replace.description} ${JSON.stringify(replace.parameters)}`.toLowerCase()
    check('ops_replace advertises a literal replace', text.includes('literal'))
    check('ops_replace does not advertise regex matching', !text.includes('regular expression'))
    check('ops_replace does not advertise backreferences', !/\$1/.test(text) || text.includes('not expanded'))
  }
  if (grep) {
    const text = `${grep.description} ${JSON.stringify(grep.parameters)}`.toLowerCase()
    check('ops_grep still advertises a regular expression', text.includes('regular expression'))
  }

  // The revision guard is create-only for write_file. The worker rejects
  // "absent" for edit/copy/move/remove, so those descriptions must not offer
  // it: a model that sends "absent" to ops_edit_file would be told the file
  // exists (it does) and the call would be refused, which reads as a bug.
  const revisionDescription = (name) =>
    registered.get(`ops_${name}`)?.parameters?.properties?.expectedRevision?.description ?? ''
  check('every write tool describes its revision guard',
    ['write_file', 'edit_file', 'copy', 'move', 'remove']
      .every(name => /64-hex/i.test(revisionDescription(name))),
    ['write_file', 'edit_file', 'copy', 'move', 'remove'].map(name => `${name}:${revisionDescription(name)}`).join(' | '))
  check('ops_write_file offers "absent" as its create-only revision',
    /"absent"/.test(revisionDescription('write_file')), revisionDescription('write_file'))
  for (const name of ['edit_file', 'copy', 'move', 'remove']) {
    check(`ops_${name} does not offer "absent" as a revision`,
      revisionDescription(name).length > 0
        && !/absent/i.test(revisionDescription(name))
        && !/absent/i.test(registered.get(`ops_${name}`)?.description ?? ''),
      revisionDescription(name))
  }

  // A guard the worker requires must be required in the schema too. copy/move
  // used to list only path/to, so a model that followed the schema omitted
  // expectedRevision and the worker answered INVALID_ARGUMENT (retryable:false)
  // — a tool that refuses a call made exactly as advertised.
  const requiredOf = (name) => registered.get(`ops_${name}`)?.parameters?.required ?? []
  for (const name of ['write_file', 'edit_file', 'copy', 'move', 'remove']) {
    check(`ops_${name} makes expectedRevision required in its schema`,
      requiredOf(name).includes('expectedRevision'), JSON.stringify(requiredOf(name)))
  }
  const replaceParameters = registered.get('ops_replace')?.parameters ?? {}
  check('ops_replace takes no expectedRevision at all',
    replaceParameters.properties?.expectedRevision === undefined
      && !(replaceParameters.required ?? []).includes('expectedRevision'))
}

// ---- 9. the config schema is what the plugin page edits ---------------
{
  // Under a DSH shell the deployment's own schemastery is reachable from
  // DSH_INSTALL_DIR, so the schema is exercised for real even though a plain
  // `node` process cannot resolve @deepseek-ai/* from this package. Inside the
  // packaged app that path lives in app.asar, which only the Desktop runtime
  // (ELECTRON_RUN_AS_NODE=1) can read; a failed read is a skip, not a failure.
  const install = process.env.DSH_INSTALL_DIR
  let schema = Config
  let skipReason = 'set DSH_INSTALL_DIR to run them against the deployment'
  if (schema === undefined && install !== undefined) {
    const schemaPath = path.join(install, '..', 'schemastery', 'lib', 'index.mjs')
    try {
      schema = buildConfig((await import(pathToFileURL(schemaPath).href)).default)
    } catch (error) {
      skipReason = `could not load ${schemaPath}: ${error.code ?? error.message}`
    }
  }

  if (schema === undefined) {
    console.log(`SKIP  config-schema checks — ${skipReason}`)
  } else {
    const readLive = (value) => (typeof value?.get === 'function' ? value.get() : value)
    const rejects = (config) => {
      try {
        schema(config)
        return false
      } catch {
        return true
      }
    }

    check('Config is exported (the Settings form needs it)', Config !== undefined || install !== undefined)

    const parsed = schema({})
    check('defaultTerminal defaults to pwsh', readLive(parsed.defaultTerminal) === 'pwsh')
    // The form projection keeps only volatile fields, so the flag on the SCHEMA
    // is what makes the setting editable at all.
    check('defaultTerminal is declared volatile, so the page can edit it',
      schema.dict?.defaultTerminal?.meta?.volatile === true)

    // The guard rails are configuration with shipped defaults; an operator
    // reading cordis.patch.yml must find these exact numbers.
    check('shell.maxSpawnFailures defaults to 5', readLive(parsed.shell?.maxSpawnFailures) === 5,
      String(readLive(parsed.shell?.maxSpawnFailures)))
    check('shell.probeTimeoutMs defaults to 3000', readLive(parsed.shell?.probeTimeoutMs) === 3000,
      String(readLive(parsed.shell?.probeTimeoutMs)))
    check('shell.stdoutMaxBytes defaults to 262144', readLive(parsed.shell?.stdoutMaxBytes) === 262144,
      String(readLive(parsed.shell?.stdoutMaxBytes)))
    check('shell.stderrMaxBytes defaults to 65536', readLive(parsed.shell?.stderrMaxBytes) === 65536,
      String(readLive(parsed.shell?.stderrMaxBytes)))
    check('shell.graceMs defaults to 1000', readLive(parsed.shell?.graceMs) === 1000,
      String(readLive(parsed.shell?.graceMs)))
    check('maxResultBytes defaults to 131072', readLive(parsed.maxResultBytes) === 131072,
      String(readLive(parsed.maxResultBytes)))

    // A cordis.patch-style row that names every new field must pass unchanged.
    const patched = schema({
      defaultTerminal: 'gitbash',
      shell: {
        gitbashPath: '',
        probeTimeoutMs: 5000,
        maxSpawnFailures: 7,
        stdoutMaxBytes: 131072,
        stderrMaxBytes: 32768,
        graceMs: 500,
      },
      workerPath: '',
      toolTimeoutMs: 45000,
      maxResultBytes: 65536,
      denyCredentialReads: false,
      promptSection: true,
    })
    check('a patch-shaped config with every new field validates and is not clamped',
      readLive(patched.defaultTerminal) === 'gitbash'
        && readLive(patched.shell?.probeTimeoutMs) === 5000
        && readLive(patched.shell?.maxSpawnFailures) === 7
        && readLive(patched.shell?.stdoutMaxBytes) === 131072
        && readLive(patched.shell?.stderrMaxBytes) === 32768
        && readLive(patched.shell?.graceMs) === 500
        && readLive(patched.maxResultBytes) === 65536
        && readLive(patched.toolTimeoutMs) === 45000,
      JSON.stringify({
        shell: patched.shell,
        maxResultBytes: readLive(patched.maxResultBytes),
        toolTimeoutMs: readLive(patched.toolTimeoutMs),
      }))

    check('maxSpawnFailures: 0 is rejected (the circuit must be able to open)', rejects({ shell: { maxSpawnFailures: 0 } }))
    check('probeTimeoutMs: 500 is rejected (too short to prove a shell)', rejects({ shell: { probeTimeoutMs: 500 } }))
    check('maxResultBytes: 200000 is rejected (above the transport cap)',
      rejects({ maxResultBytes: 200000 }))
    check('stdoutMaxBytes: 1000 is rejected (below the collector floor)',
      rejects({ shell: { stdoutMaxBytes: 1000 } }))
    check('graceMs: 20000 is rejected (above the termination cap)',
      rejects({ shell: { graceMs: 20000 } }))

    let rejected = false
    try {
      schema({ defaultTerminal: 'cmd' })
    } catch {
      rejected = true
    }
    check('an unknown terminal value is rejected at load time', rejected)
  }
}

// ---- 10. a renderer must show the worker's rows, not the call arguments ---
{
  // The default renderer once received `args` in place of the result value, so
  // ops_inspect_local_file rendered "(no rows)" for every file: the tool worked,
  // the display lied, and the model believed the file was empty.
  const { ctx, registered } = harness()
  apply(ctx, { defaultTerminal: 'pwsh' })
  const inspect = registered.get('ops_inspect_local_file')
  check('ops_inspect_local_file is registered for the renderer test', inspect !== undefined)
  if (inspect) {
    const value = {
      status: 'completed', phase: 'verify', complete: true, truncated: false,
      items: [
        { line: 1, path: 'C:\\work\\a.txt', text: 'alpha' },
        { line: 2, path: 'C:\\work\\a.txt', text: 'beta' },
      ],
      lineCount: 2, matched: 2, nextOffset: 3, total: 2,
    }
    const out = renderText(inspect, { path: 'a.txt', limit: 2 }, value)
    check('inspect_local_file renders the rows it received', out.includes('1\talpha') && out.includes('2\tbeta'), out)
    check('inspect_local_file does not claim "(no rows)" for a real read', !out.includes('(no rows)'), out)
  }
}

// ---- 11. ops_batch: one call, many operations, honest per-operation lines ---
{
  let spawns = 0
  const guardedSubprocess = {
    spawn() {
      spawns += 1
      throw new Error('a worker must not start for this batch test')
    },
  }
  const { ctx, registered } = harness({ subprocess: guardedSubprocess })
  apply(ctx, { defaultTerminal: 'pwsh' })
  const batch = registered.get('ops_batch')
  check('ops_batch is registered', batch !== undefined)
  check('...and does not disturb the single-operation tools', registered.has('ops_stat') && registered.has('ops_glob'))

  const exec = { agent: { session: { id: 'batch' } }, signal: undefined }
  if (batch) {
    const parameters = batch.parameters ?? {}
    const operations = parameters.properties?.operations
    // Only operations whose value survives a one-line summary are chainable: a
    // read's remaining lines could not be returned, so reads are rejected.
    const expectedOps = ['stat', 'write_file', 'edit_file', 'replace', 'diff', 'copy', 'move', 'remove']
    check('ops_batch advertises operations as an array', operations?.type === 'array')
    check('...whose items require op and args',
      JSON.stringify(operations?.items?.required) === JSON.stringify(['op', 'args']),
      JSON.stringify(operations?.items?.required))
    check('...with exactly the 8 chainable operations as its enum',
      JSON.stringify(operations?.items?.properties?.op?.enum) === JSON.stringify(expectedOps),
      JSON.stringify(operations?.items?.properties?.op?.enum))
    check('...and batch itself is not chainable (no recursion)',
      !(operations?.items?.properties?.op?.enum ?? []).includes('batch'))
    check('ops_batch advertises stopOnError as a boolean',
      parameters.properties?.stopOnError?.type === 'boolean')
    check('ops_batch requires operations', JSON.stringify(parameters.required) === JSON.stringify(['operations']))
    check('...and the description says reads are rejected because no output is returned',
      /Read operations/.test(batch.description) && /rejected/.test(batch.description)
        && /no operation output/.test(batch.description), batch.description.slice(0, 140))
    // The 1-32 bound is enforced by execute() before any worker starts, so the
    // schema needs no array keywords. Parameters are projected to the model as
    // they are, so keeping them to the supported subset avoids expressing a
    // constraint twice — once here and once in code that actually enforces it.
    const serialized = JSON.stringify(parameters)
    check('ops_batch parameters stay inside the documented subset (no minItems/maxItems)',
      !/"minItems"/.test(serialized) && !/"maxItems"/.test(serialized))

    // -- invalid batches are refused before any worker starts -------------
    const badBatches = [
      ['an empty operations array', { operations: [] }, /1-32 operations, got 0/],
      ['33 operations', {
        operations: Array.from({ length: 33 }, (_, index) => ({ op: 'stat', args: { path: `f${index}.txt` } })),
      }, /1-32 operations, got 33/],
      ['an unknown operation name', { operations: [{ op: 'frobnicate', args: {} }] }, /no operation "frobnicate"/],
      ['an ops_-prefixed operation name', { operations: [{ op: 'ops_stat', args: { path: 'x' } }] }, /no operation "ops_stat"/],
      ['a nested ops_batch operation', { operations: [{ op: 'batch', args: { operations: [] } }] }, /no operation "batch"/],
      ['a read operation (glob)', { operations: [{ op: 'glob', args: { pattern: ['*'] } }] },
        /no operation "glob".*Allowed operations: stat, write_file, edit_file, replace, diff, copy, move, remove/],
    ]
    for (const [label, args, pattern] of badBatches) {
      let message = ''
      try {
        const value = await batch.execute(args, exec)
        message = `(returned ${JSON.stringify(value)})`
      } catch (error) {
        message = error.message
      }
      check(`ops_batch refuses ${label} before any worker starts`, pattern.test(message), message)
    }
    check('...and no invalid batch started a worker process', spawns === 0, `spawns=${spawns}`)

    // -- the renderer reports each operation, never a failure as success --
    const twoOkOneFailed = {
      results: [
        { index: 1, op: 'stat', ok: true, summary: 'path: D:\\code\\dshops-lite\\package.json' },
        { index: 2, op: 'inspect_local_file', ok: false, code: 'NOT_FOUND', message: 'NOT_FOUND: inspect_local_file: missing' },
        { index: 3, op: 'glob', ok: true, summary: 'D:\\code\\dshops-lite\\lib\\shell.js' },
      ],
      total: 3,
      failed: 1,
      stopped: false,
    }
    const rendered = renderText(batch, { operations: [{ op: 'stat', args: {} }] }, twoOkOneFailed)
    const renderedLines = rendered.split('\n')
    check('ops_batch renderer emits one line per operation plus a summary line',
      renderedLines.length === 4, `${renderedLines.length} lines`)
    check('...the successful lines are marked ok with their summary',
      /^\[1\] stat ok — path: /m.test(rendered) && /^\[3\] glob ok — /m.test(rendered))
    const failedLine = renderedLines.find(line => line.startsWith('[2] ')) ?? ''
    check('...the failed line carries the worker code and says FAILED',
      /^\[2\] inspect_local_file FAILED — NOT_FOUND: /m.test(failedLine), failedLine)
    check('...and the failed line never claims ok', !/\bok\b/i.test(failedLine), failedLine)
    check('...the summary counts exactly the successes', renderedLines.at(-1) === '[2/3 operations succeeded]',
      renderedLines.at(-1))
    check('...and a failure is never counted as a success',
      rendered.split('\n').filter(line => /\bok\b/.test(line)).length === 2, rendered)

    const emptyRendered = renderText(batch, {}, { results: [], total: 0, failed: 0, stopped: false })
    check('an empty batch result renders "(no operations)"', emptyRendered === '(no operations)', emptyRendered)

    // -- stopOnError: the last line says how many operations were skipped --
    const stoppedValue = {
      results: [
        { index: 1, op: 'stat', ok: true, summary: 'path: a.txt' },
        { index: 2, op: 'stat', ok: false, code: 'NOT_FOUND', message: 'NOT_FOUND: stat: missing' },
      ],
      total: 5,
      failed: 1,
      stopped: true,
    }
    const stoppedRendered = renderText(batch, { operations: [] }, stoppedValue)
    check('a stopped batch says where it stopped and how many were skipped',
      stoppedRendered.split('\n').at(-1) === '[stopped at operation 2; 3 remaining operation(s) skipped]',
      stoppedRendered.split('\n').at(-1))
    check('...and a stopped batch is not reported as all-success',
      !/operations succeeded/.test(stoppedRendered))

    // -- a batch actually stops at the first failure when asked -----------
    const script = workerScript([
      { value: { status: 'completed', path: path.resolve('package.json'), exists: true, bytes: 934, lineCount: 1, revision: 'r1' } },
      { value: { status: 'error', error: { code: 'NOT_FOUND', message: 'remove: missing', nextAction: 'Check the path.' } } },
      { value: { status: 'completed', copied: true } },
    ])
    const stopHarness = harness({ subprocess: script })
    apply(stopHarness.ctx, { defaultTerminal: 'pwsh' })
    const stopBatch = stopHarness.registered.get('ops_batch')
    const stopExec = { agent: { session: { id: 'batch' } }, signal: undefined }
    const stopValue = await stopBatch.execute({
      operations: [
        { op: 'stat', args: { path: 'package.json' } },
        { op: 'remove', args: { path: 'no-such-file.txt', expectedRevision: 'r1' } },
        { op: 'copy', args: { path: 'lib/shell.js', to: 'lib/shell.copy.js', expectedRevision: 'r1' } },
      ],
      stopOnError: true,
    }, stopExec)
    check('a stopOnError batch stops at the first failing operation',
      stopValue.stopped === true && stopValue.results.length === 2 && stopValue.total === 3,
      JSON.stringify(stopValue))
    check('...the first operation really succeeded through the worker',
      stopValue.results[0].ok === true && /^path: /.test(stopValue.results[0].summary ?? ''),
      JSON.stringify(stopValue.results[0]))
    check('...the failed operation keeps the worker failure code',
      stopValue.results[1].ok === false && stopValue.results[1].code === 'NOT_FOUND',
      JSON.stringify(stopValue.results[1]))
    check('...and no worker started for the skipped third operation', script.spawned === 2, `spawns=${script.spawned}`)
    check('...the batch passed operations through the single-tool normalize',
      script.requests[0]?.request?.tool === 'stat'
        && path.isAbsolute(script.requests[0]?.request?.args?.path ?? '')
        && script.requests[1]?.request?.tool === 'remove',
      JSON.stringify(script.requests.map(r => r?.request?.tool)))
    const stopRendered = renderText(stopBatch, { operations: [] }, stopValue)
    check('...and its rendering explains the skipped operation count',
      stopRendered.split('\n').at(-1) === '[stopped at operation 2; 1 remaining operation(s) skipped]',
      stopRendered.split('\n').at(-1))
    check('...and its rendering marks the failed operation FAILED',
      /^\[2\] remove FAILED — NOT_FOUND: /m.test(stopRendered), stopRendered)

    // -- a summary cut at 240 characters must show the cut -----------------
    // Long paths are the easiest real way to overflow one line; the ellipsis is
    // what keeps a batch summary from reading like a complete value.
    const longPath = 'd'.repeat(300)
    const longHarness = harness({
      subprocess: workerScript([
        { value: { status: 'completed', path: longPath, exists: true, bytes: 1, lineCount: 1, revision: 'r1' } },
      ]),
    })
    apply(longHarness.ctx, { defaultTerminal: 'pwsh' })
    const longValue = await longHarness.registered.get('ops_batch').execute({
      operations: [{ op: 'stat', args: { path: 'long.txt' } }],
    }, stopExec)
    const longSummary = longValue.results[0]?.summary ?? ''
    check('a batch summary longer than 240 characters shows the cut with an ellipsis',
      longSummary.length === 241 && longSummary.endsWith('…'), `${longSummary.length} chars`)

    // -- a transport fault throws the whole batch: no partial success -----
    let transportThrew = false
    let transportReturned = false
    let transportMessage = ''
    const brokenHarness = harness({
      subprocess: workerScript([{ throw: new Error('spawn ENOENT (simulated transport)') }]),
    })
    apply(brokenHarness.ctx, { defaultTerminal: 'pwsh' })
    try {
      await brokenHarness.registered.get('ops_batch').execute({
        operations: [
          { op: 'stat', args: { path: 'package.json' } },
          { op: 'copy', args: { path: 'lib/shell.js', to: 'lib/shell.copy.js', expectedRevision: 'r1' } },
        ],
      }, stopExec)
      transportReturned = true
    } catch (error) {
      transportThrew = true
      transportMessage = error.message
    }
    check('a spawn failure throws the whole batch instead of returning partial results',
      transportThrew && !transportReturned && /simulated transport/.test(transportMessage), transportMessage)

    let exitThrew = false
    let exitMessage = ''
    const exitHarness = harness({ subprocess: workerScript([{ exitCode: 1, stderr: 'worker crashed' }]) })
    apply(exitHarness.ctx, { defaultTerminal: 'pwsh' })
    try {
      await exitHarness.registered.get('ops_batch').execute({
        operations: [
          { op: 'stat', args: { path: 'package.json' } },
          { op: 'copy', args: { path: 'lib/shell.js', to: 'lib/shell.copy.js', expectedRevision: 'r1' } },
        ],
      }, stopExec)
    } catch (error) {
      exitThrew = true
      exitMessage = error.message
    }
    check('a broken worker transport throws at the failing operation index',
      exitThrew && /ops_batch failed at operation 1 \(stat\)/.test(exitMessage) && /exited with code 1/.test(exitMessage),
      exitMessage)
  }
}

console.log(`\n${checks} assertions, ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exitCode = failures === 0 ? 0 : 1