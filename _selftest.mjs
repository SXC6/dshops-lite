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
  logger: { warn: (m) => warnings.push(m) },
}

apply(ctx, { shell: { backend: 'auto' } })

console.log('=== warnings from apply() ===')
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

await run('ops_stat', { path: 'package.json' })
await run('ops_glob', { pattern: ['lib/*.js'], limit: 5 })
await run('ops_grep', { pattern: 'resolveShell', glob: ['**/*.js'], outputMode: 'content', limit: 5 })
await run('ops_inspect_local_file', { path: 'lib/shell.js', offset: 1, limit: 3 })
await run('ops_read_files', { files: [{ path: 'package.json', limit: 2 }, { path: 'cordis.patch.yml', limit: 2 }] })
await run('ops_inspect_local_file', { path: 'no-such-file.txt' }, { expectThrow: true })
await run('ops_shell', { command: 'echo hello-from-$0' })

console.log(`\n=== done: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`} ===`)
process.exitCode = failures === 0 ? 0 : 1