/**
 * Offline self-test: drives apply() with a fake host, then runs the registered
 * tools against real files through the real Rust worker.
 *
 * Run: node _selftest.mjs
 */
import { spawn } from 'node:child_process'
import { apply } from './index.js'

/** Minimal stand-in for the host subprocess service. */
const subprocess = {
  spawn(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const outChunks = []
    const errChunks = []
    child.stdout.on('data', (c) => outChunks.push(c))
    child.stderr.on('data', (c) => errChunks.push(c))
    // Closing stdin is mandatory: the worker reads to EOF.
    if (spec.stdio?.stdin?.data !== undefined) child.stdin.end(spec.stdio.stdin.data)
    else child.stdin.end()
    const done = new Promise((resolve) => {
      child.on('close', (exitCode, signal) => resolve({ exitCode, signal }))
      child.on('error', () => resolve({ exitCode: null, signal: null }))
    })
    const stream = (chunks) => ({
      readFrom() {
        return { text: Buffer.concat(chunks).toString('utf8'), lossy: false }
      },
    })
    return { done, collected: { stdout: stream(outChunks), stderr: stream(errChunks) } }
  },
}

const registered = new Map()
const notices = []
const warnings = []
const ctx = {
  subprocess,
  tools: {
    register(definition) {
      if (registered.has(definition.name)) throw new Error(`duplicate ${definition.name}`)
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  },
  workingDirectory: { ensure: async () => process.cwd() },
  get: () => undefined,
  // The host logger has both levels: the split is part of the contract this
  // test pins (a successful registration must not be logged as a warning).
  logger: { info: (m) => notices.push(m), warn: (m) => warnings.push(m) },
}

apply(ctx, { defaultTerminal: 'gitbash' })

console.log('=== notices from apply() ===')
for (const n of notices) console.log('  ', n)
console.log('\n=== warnings from apply() ===')
for (const w of warnings) console.log('  ', w)
console.log(`\n=== registered tools (${registered.size}) ===`)
console.log('  ', [...registered.keys()].join(', '))

const exec = { agent: { session: { id: 'selftest' } }, signal: undefined }

let failures = 0

async function run(name, args, options = {}) {
  const definition = registered.get(name)
  if (!definition) {
    failures += 1
    console.log(`\n### ${name}: NOT REGISTERED`)
    return
  }
  try {
    const value = await definition.execute(args, exec)
    const blocks = definition.output.render(args, value)
    const text = blocks.map(b => b.text).join('\n')
    console.log(`\n### ${name} ${JSON.stringify(args)}`)
    console.log(text.split('\n').slice(0, 14).map(l => '    ' + l).join('\n'))
    if (text.split('\n').length > 14) console.log(`    … (${text.split('\n').length} lines)`)
    if (options.expectThrow) {
      failures += 1
      console.log(`    !! expected a hard failure, but it returned normally`)
    } else if (typeof options.verify === 'function') {
      // `verify` returns true when the expectation holds, or a short reason.
      let problem
      try {
        problem = options.verify(value, text)
      } catch (error) {
        problem = `verify threw: ${error.message}`
      }
      if (problem === true) {
        console.log(`    PASS — ${options.expect ?? 'expectation met'}`)
      } else {
        failures += 1
        console.log(`    FAIL — ${typeof problem === 'string' ? problem : (options.expect ?? 'expectation failed')}`)
      }
    }
  } catch (error) {
    if (options.expectThrow) {
      console.log(`\n### ${name} ${JSON.stringify(args)}`)
      console.log(`    OK — hard failure as expected: ${error.message}`)
      return
    }
    failures += 1
    console.log(`\n### ${name} THREW (unexpected): ${error.message}`)
  }
}

/**
 * Assertion helper for the cause-classification cases below: `run()` above wraps
 * one tool call around its assertion, while these cases also need the rejection
 * path and a scripted subprocess seam.
 */
function check(label, condition, extra = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`)
  if (!condition) failures += 1
}

/** Settle a promise into `{value}` or `{error}` without throwing. */
async function attempt(promise) {
  try {
    return { value: await promise }
  } catch (error) {
    return { error }
  }
}

/** Every line the stub hosts below logged, with its level. */
const stubNotes = []

/**
 * A second plugin instance whose subprocess seam is a scripted stub. apply()
 * still probes the real Git Bash — that is what publishes ops_shell — but every
 * ops_shell command goes through `spawnStub`, so a never-settling handle, an
 * already-aborted caller signal and a throwing spawn need no real process.
 * `maxSpawnFailures: 1` is deliberate: a counted failure shows up at once as a
 * retired shell.
 */
function stubHost(spawnStub, shell = {}) {
  const tools = new Map()
  const hostCtx = {
    subprocess: { spawn: spawnStub },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    workingDirectory: { ensure: async () => process.cwd() },
    get: () => undefined,
    logger: {
      info: (message) => stubNotes.push({ level: 'info', message }),
      warn: (message) => stubNotes.push({ level: 'warn', message }),
    },
  }
  apply(hostCtx, { defaultTerminal: 'gitbash', shell: { commandTimeoutMs: 40, maxSpawnFailures: 1, ...shell } })
  return tools.get('ops_shell')
}

await run('ops_stat', { path: 'package.json' })
await run('ops_glob', { pattern: ['lib/*.js'], limit: 5 })
await run('ops_grep', { pattern: 'resolveShell', glob: ['**/*.js'], outputMode: 'content', limit: 5 })
await run('ops_inspect_local_file', { path: 'lib/shell.js', offset: 1, limit: 3 })
await run('ops_read_files', { files: [{ path: 'package.json', limit: 2 }, { path: 'cordis.patch.yml', limit: 2 }] })
await run('ops_inspect_local_file', { path: 'no-such-file.txt' }, { expectThrow: true })

// A real batch through the real worker: two operations succeed, the missing
// file fails, and the batch as a whole must still return normally — one
// operation's failure must not throw away the other two results.
await run('ops_batch', {
  operations: [
    { op: 'stat', args: { path: 'package.json' } },
    { op: 'remove', args: { path: 'no-such-file.txt', expectedRevision: '0'.repeat(64) } },
    { op: 'stat', args: { path: 'lib/shell.js' } },
  ],
}, {
  expect: '2 successes, 1 failure, rendered [2/3 operations succeeded]',
  verify(value, text) {
    const results = Array.isArray(value?.results) ? value.results : []
    const succeeded = results.filter(item => item.ok === true).length
    const failed = results.filter(item => item.ok === false).length
    if (value?.total !== 3) return `total=${value?.total}`
    if (value?.failed !== 1) return `failed=${value?.failed}`
    if (value?.stopped !== false) return `stopped=${value?.stopped}`
    if (results.length !== 3) return `results=${results.length}`
    if (succeeded !== 2 || failed !== 1) return `succeeded=${succeeded} failed=${failed}`
    if (!/^\[2\/3 operations succeeded\]$/m.test(text)) return 'the summary line does not say [2/3 operations succeeded]'
    if (!/^\[2\] remove FAILED — NOT_FOUND: /m.test(text)) return 'the missing-path operation was not rendered as FAILED with NOT_FOUND'
    if (!results.some(item => item.ok === false && item.code === 'NOT_FOUND')) return 'the failure kept no worker NOT_FOUND code'
    return true
  },
})

await run('ops_shell', { command: 'echo hello-from-$0' })

// ---- cause classification through a stubbed subprocess seam ---------------
// The host seam deliberately carries no timeout or cancellation verdict, and a
// forced kill on Windows reports exit code 1 with no signal. These stubs pin how
// the plugin tells the causes apart and which causes may spend the failure
// budget. The 40 ms input is clamped up to the documented 1000 ms floor.

const stubExec = { agent: { session: { id: 'selftest-stub' } }, signal: undefined }

console.log('\n### ops_shell (stub): a hung command hits shell.commandTimeoutMs')
{
  let calls = 0
  const shellTool = stubHost((spec) => {
    calls += 1
    if (calls === 1) {
      // `done` never settles, so only the plugin's own deadline can end the call.
      return {
        done: new Promise(() => {}),
        collected: {
          stdout: { readFrom: () => ({ text: '', lossy: false }) },
          stderr: { readFrom: () => ({ text: '', lossy: false }) },
        },
      }
    }
    return subprocess.spawn(spec)
  })
  if (shellTool === undefined) {
    check('ops_shell is published for the stub tests (real Git Bash probe)', false)
  } else {
    // An unref'd deadline timer alone does not keep Node alive, so hold the loop
    // open while the hanging handle is awaited.
    const keepAlive = setInterval(() => {}, 1000)
    const started = Date.now()
    const first = await attempt(shellTool.execute({ command: 'echo hung' }, stubExec))
    const elapsed = Date.now() - started
    clearInterval(keepAlive)
    console.log(`    rejected after ${elapsed} ms: ${first.error?.message ?? '(returned normally)'}`)
    check('a handle whose done never settles is cut off by the plugin deadline',
      /terminated the command after \d+ ms/.test(first.error?.message ?? ''), first.error?.message)
    check('...at shell.commandTimeoutMs (the 40 ms input is clamped up to the 1000 ms floor)',
      elapsed >= 900 && elapsed < 5000, `${elapsed} ms`)
    const after = await shellTool.execute({ command: 'echo after-timeout' }, stubExec)
    check('...and the timeout is not counted: with maxSpawnFailures=1 the next command still runs',
      after.exitCode === 0 && /after-timeout/.test(after.stdout), JSON.stringify(after))
    check('a successful start-up logs its success lines at info, not at warn',
      stubNotes.some(entry => entry.level === 'info' && /registered native file tools/.test(entry.message))
        && !stubNotes.some(entry => entry.level === 'warn' && /registered native file tools|shell = /.test(entry.message)),
      stubNotes.map(entry => `${entry.level}: ${entry.message}`).join(' | '))
  }
}

console.log('\n### ops_shell (stub): an already-aborted caller signal is a cancellation')
{
  let calls = 0
  const shellTool = stubHost((spec) => {
    calls += 1
    return subprocess.spawn(spec)
  })
  if (shellTool === undefined) {
    check('ops_shell is published for the cancellation test', false)
  } else {
    const controller = new AbortController()
    controller.abort(new Error('turn cancelled'))
    const result = await attempt(shellTool.execute({ command: 'echo nope' }, { ...stubExec, signal: controller.signal }))
    console.log(`    rejected: ${result.error?.message ?? '(returned normally)'}`)
    check('an already-aborted exec.signal is reported as a cancellation',
      result.value === undefined && /cancelled/i.test(result.error?.message ?? ''), result.error?.message)
    check('...without starting a process', calls === 0, `spawns=${calls}`)
    check('...and without spending the failure budget (maxSpawnFailures=1 would retire it)',
      !/consecutive failures|disabled/i.test(result.error?.message ?? ''), result.error?.message)
    const after = await shellTool.execute({ command: 'echo after-cancel' }, stubExec)
    check('...so a following command still runs', after.exitCode === 0 && /after-cancel/.test(after.stdout),
      JSON.stringify(after))
  }
}

console.log('\n### ops_shell (stub): a spawn that throws still counts toward maxSpawnFailures')
{
  let calls = 0
  const shellTool = stubHost(() => {
    calls += 1
    throw new Error('spawn ENOENT (simulated backend fault)')
  }, { maxSpawnFailures: 2 })
  if (shellTool === undefined) {
    check('ops_shell is published for the backend-fault test', false)
  } else {
    const first = await attempt(shellTool.execute({ command: 'echo hi' }, stubExec))
    const second = await attempt(shellTool.execute({ command: 'echo hi' }, stubExec))
    const third = await attempt(shellTool.execute({ command: 'echo hi' }, stubExec))
    console.log(`    first: ${first.error?.message ?? '(returned normally)'}`)
    check('a spawn that throws is counted as failure 1 of 2',
      first.error?.terminal !== true && /1\/2 consecutive failures/.test(first.error?.message ?? '')
        && /simulated backend fault/.test(first.error?.message ?? ''), first.error?.message)
    check('...the second counted failure retires the shell',
      second.error?.terminal === true && /disabled/.test(second.error?.message ?? ''), second.error?.message)
    check('...and a third call fails fast without spawning again',
      calls === 2 && /disabled/.test(third.error?.message ?? ''), `spawns=${calls}`)
  }
}

console.log('\n### ops_shell (stub): a mid-flight cancel beats a Windows-style exit code 1')
{
  let calls = 0
  const controller = new AbortController()
  const shellTool = stubHost((spec) => {
    calls += 1
    if (calls > 1) return subprocess.spawn(spec)
    // The cancel lands while the command is in flight, and the seam reports what
    // a forced kill reports on Windows: exit code 1, no signal. Only the caller's
    // signal can tell that apart from an ordinary command failure.
    controller.abort(new Error('turn cancelled mid-flight'))
    return {
      done: Promise.resolve({ exitCode: 1, signal: null }),
      collected: {
        stdout: { readFrom: () => ({ text: '', lossy: false }) },
        stderr: { readFrom: () => ({ text: 'Terminated\n', lossy: false }) },
      },
    }
  })
  if (shellTool === undefined) {
    check('ops_shell is published for the mid-flight cancellation test', false)
  } else {
    const result = await attempt(shellTool.execute({ command: 'sleep 30' }, { ...stubExec, signal: controller.signal }))
    console.log(`    rejected: ${result.error?.message ?? '(returned normally)'}`)
    check('a caller cancel is classified by the signal, not by the exit code',
      result.value === undefined && /cancelled/i.test(result.error?.message ?? ''), result.error?.message)
    check('...and it neither counts a failure nor retires the shell',
      !/consecutive failures|disabled/i.test(result.error?.message ?? ''), result.error?.message)
    const after = await shellTool.execute({ command: 'echo after-midflight-cancel' }, stubExec)
    check('...so a following command still runs',
      after.exitCode === 0 && /after-midflight-cancel/.test(after.stdout), JSON.stringify(after))
  }
}

// ---- output-contract conformance ---------------------------------------
// Every tool declares its output shape so a code-mode consumer reads a typed
// contract instead of an untyped bag. A declaration that drifts from the real
// value is worse than none, because it reads as truth — so validate the real
// worker result against the declaration for every tool.
{
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'dshops-contract-'))
  const P = (name) => path.join(box, name)
  const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v)

  /** Minimal subset of JSON Schema: type, required, properties, items, oneOf. */
  function validate(schema, value, at, problems) {
    if (schema === undefined || schema === true) return
    if (Array.isArray(schema.oneOf)) {
      const branches = schema.oneOf.map((sub) => {
        const found = []
        validate(sub, value, at, found)
        return found
      })
      if (!branches.some((found) => found.length === 0)) {
        problems.push(`${at}: matched no oneOf branch (${JSON.stringify(value)?.slice(0, 80)})`)
      }
      return
    }
    const want = schema.type
    if (typeof want === 'string') {
      const actual = typeOf(value)
      const fits = want === 'integer'
        ? typeof value === 'number' && Number.isInteger(value)
        : want === 'number' ? actual === 'number' : want === actual
      if (!fits) problems.push(`${at}: declared ${want}, got ${actual}`)
    }
    if (value !== null && typeof value === 'object') {
      for (const key of schema.required ?? []) {
        if (!(key in value)) problems.push(`${at}: required "${key}" missing`)
      }
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        if (key in value && value[key] !== undefined) validate(sub, value[key], `${at}.${key}`, problems)
      }
    }
    if (schema.items !== undefined && Array.isArray(value)) {
      value.forEach((item, index) => validate(schema.items, item, `${at}[${index}]`, problems))
    }
  }

  const call = async (name, args) => {
    const tool = registered.get(name)
    if (tool === undefined) throw new Error(`${name} is not registered`)
    return tool.execute(args, exec)
  }
  const conform = async (name, args) => {
    const tool = registered.get(name)
    const value = await call(name, args)
    const problems = []
    validate(tool.output?.schema, value, name, problems)
    check(`${name}: the value matches its declared output schema`, problems.length === 0, problems.join('; '))
    return value
  }

  try {
    fs.mkdirSync(P('sub'))
    fs.writeFileSync(P('a.txt'), 'alpha\nbeta\ngamma\n')
    fs.writeFileSync(P('b.js'), 'import x from "y"\nconst TOKEN = 1\n')
    fs.writeFileSync(P('sub/c.md'), '# title\n')
    fs.writeFileSync(P('big.txt'), Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n'))

    await conform('ops_stat', { path: P('a.txt') })
    await conform('ops_stat', { path: P('missing.txt') })
    await conform('ops_inspect_local_file', { path: P('a.txt'), limit: 2 })
    await conform('ops_inspect_local_file', { path: P('a.txt'), encoding: 'hex', limit: 1 })
    await conform('ops_read_files', { files: [{ path: P('a.txt'), limit: 1 }, { path: P('b.js'), limit: 1 }] })
    await conform('ops_read_files', { files: [{ path: P('a.txt'), limit: 1 }, { path: P('missing.txt') }] })
    await conform('ops_glob', { path: box, pattern: ['*.txt'] })
    await conform('ops_glob', { path: box, pattern: ['**/*'], outputMode: 'details' })
    await conform('ops_glob', { path: box, pattern: ['*.txt'], limit: 1 })
    await conform('ops_grep', { path: box, pattern: 'alpha' })
    await conform('ops_grep', { path: box, pattern: 'TOKEN', outputMode: 'files_with_matches' })
    await conform('ops_grep', { path: box, pattern: 'line', outputMode: 'count' })
    await conform('ops_grep', { path: box, pattern: 'nothing-matches-this' })
    await conform('ops_diff', { path: P('a.txt'), content: 'alpha\nGAMMA\n' })
    await conform('ops_batch', { operations: [{ op: 'stat', args: { path: P('a.txt') } }] })
    await conform('ops_batch', {
      operations: [
        { op: 'stat', args: { path: P('a.txt') } },
        { op: 'remove', args: { path: P('missing.txt'), expectedRevision: '0'.repeat(64) } },
      ],
    })

    await conform('ops_write_file', { path: P('w.txt'), content: 'one\ntwo\n', expectedRevision: 'absent' })
    const rev = async (p) => (await call('ops_stat', { path: p })).revision
    await conform('ops_edit_file', { path: P('w.txt'), expectedRevision: await rev(P('w.txt')), edits: [{ oldText: 'two', newText: 'TWO' }] })
    await conform('ops_replace', { path: box, pattern: 'ONE', replacement: 'one', glob: ['w.txt'], dryRun: true })
    await conform('ops_copy', { path: P('w.txt'), to: P('w2.txt'), expectedRevision: await rev(P('w.txt')) })
    await conform('ops_move', { path: P('w2.txt'), to: P('w3.txt'), expectedRevision: await rev(P('w2.txt')) })
    await conform('ops_remove', { path: P('w3.txt'), expectedRevision: await rev(P('w3.txt')) })

    // A miss carries no `path` in the worker's value, and printing the
    // literal "undefined" at the model is noise it may read as a fact.
    const missing = await call('ops_stat', { path: P('nope.txt') })
    const missingText = registered.get('ops_stat').output.render({ path: P('nope.txt') }, missing)[0].text
    check('ops_stat on a miss echoes the path instead of "undefined"',
      missingText.includes(P('nope.txt')) && !/undefined/.test(missingText), missingText.split('\n')[0])

    // ops_shell is published here (Git Bash proved out) and declares its own
    // contract, so it has to hold too.
    await conform('ops_shell', { command: 'echo contract' })
  } finally {
    fs.rmSync(box, { recursive: true, force: true })
  }

  // A tool added without a contract would silently fall back to an untyped bag,
  // which is the exact hole this section closes.
  for (const [name, tool] of registered) {
    const properties = tool.output?.schema?.properties
    check(`${name}: declares an output contract`,
      properties !== undefined && Object.keys(properties).length > 0,
      JSON.stringify(tool.output?.schema ?? null).slice(0, 90))
  }
}

console.log(`\n=== done: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`} ===`)
process.exitCode = failures === 0 ? 0 : 1