/**
 * Anti-disaster assertions. These encode the requirement:
 *   a shell that cannot be proved to work must NOT be published, and an
 *   explicit backend must never silently become a different one.
 *
 * Run: node _failtest.mjs
 */
import { apply } from './index.js'
import { isLauncher, isWslLauncher, probeShell } from './lib/shell.js'

let failures = 0
const check = (label, condition, extra = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`)
  if (!condition) failures += 1
}

function harness(overrides = {}) {
  const registered = new Map()
  const warnings = []
  const ctx = {
    subprocess: overrides.subprocess ?? { spawn: () => { throw new Error('not used') } },
    tools: { register: (d) => { registered.set(d.name, d); return () => registered.delete(d.name) } },
    workingDirectory: { ensure: async () => process.cwd() },
    get: () => undefined,
    logger: { warn: (m) => warnings.push(m) },
    // A tripwire: the plugin must never restrict another plugin's tool.
    restrictCalled: false,
  }
  return { ctx, registered, warnings }
}

// ---- 1. explicit gitbash pointing at a missing binary -------------------
{
  const { ctx, registered } = harness()
  apply(ctx, { shell: { backend: 'gitbash', gitbashPath: 'D:\\nope\\not-bash.exe' } })
  check('explicit gitbash with a bad path publishes no ops_shell', !registered.has('ops_shell'))
  check('...and still publishes the file tools', registered.has('ops_grep'))
  check('...and never falls through to pwsh',
    ![...registered.keys()].some(k => k === 'ops_shell'), `tools=${[...registered.keys()].length}`)
}

// ---- 2. explicit pwsh pointing at a missing binary ----------------------
{
  const { ctx, registered } = harness()
  apply(ctx, { shell: { backend: 'pwsh', pwshPath: 'D:\\nope\\not-pwsh.exe' } })
  check('explicit pwsh with a bad path publishes no ops_shell', !registered.has('ops_shell'))
}

// ---- 3. backend: none ---------------------------------------------------
{
  const { ctx, registered } = harness()
  apply(ctx, { shell: { backend: 'none' } })
  check('backend "none" publishes no ops_shell', !registered.has('ops_shell'))
}

// ---- 4. a launcher is never accepted as a shell ------------------------
{
  const launcher = 'D:\\Program Files\\Git\\git-bash.exe'
  const verdict = probeShell('gitbash', launcher, 5000)
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

// ---- 6. circuit breaker: repeated spawn failures retire the backend ----
{
  let spawns = 0
  const brokenSubprocess = {
    spawn() {
      spawns += 1
      throw new Error('spawn ENOENT (simulated)')
    },
  }
  const { ctx, registered } = harness({ subprocess: brokenSubprocess })
  apply(ctx, { shell: { backend: 'gitbash', maxSpawnFailures: 2 } })
  const shellTool = registered.get('ops_shell')
  check('ops_shell was published (real probe passed)', shellTool !== undefined)

  if (shellTool) {
    const exec = { agent: { session: { id: 'x' } }, signal: undefined }
    const messages = []
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await shellTool.execute({ command: 'echo hi' }, exec)
        messages.push('(no throw)')
      } catch (error) {
        messages.push(error.message)
      }
    }
    const firstRetryable = /One retry is allowed/.test(messages[0])
    const thirdTerminal = /disabled|Do not retry/i.test(messages[2])
    check('1st failure is reported with a bounded retry', firstRetryable, messages[0])
    check('3rd call fails fast with a terminal message', thirdTerminal, messages[2])
    check('spawn is not attempted again after the circuit opens', spawns <= 2, `spawns=${spawns}`)
  }
}

// ---- 7. an unfinished search must never claim "no matches" ------------
{
  // Deterministic renderer test: a synthetic scan-budget result, so this does
  // not depend on how many files happen to exist on the machine.
  const { ctx, registered } = harness()
  apply(ctx, { shell: { backend: 'none' } })
  const globDef = registered.get('ops_glob')
  check('ops_glob is registered for the renderer test', globDef !== undefined)

  if (globDef) {
    const budgetHit = {
      status: 'completed', phase: 'verify', complete: false, truncated: true,
      truncatedBy: 'scan-budget', scanComplete: false, pageComplete: true,
      items: [], matched: 0, matchedObserved: 0, nextOffset: 0,
      scannedFiles: 10000, failed: 1, skipped: 0,
    }
    const rendered = globDef.output.render({}, budgetHit).map(b => b.text).join('\n')
    check('scan-budget result does not say "(no matches)"', !rendered.includes('(no matches)'), rendered.split('\n')[0])
    check('scan-budget result says the search did not finish', /did not finish/.test(rendered))
    check('scan-budget result does not advise an offset retry', !/continue with offset/.test(rendered))

    const genuine = {
      status: 'completed', phase: 'verify', complete: true, truncated: false,
      truncatedBy: 'none', scanComplete: true, pageComplete: true,
      items: [], matched: 0, matchedObserved: 0, matchedTotal: 0, nextOffset: 0,
    }
    const cleanRender = globDef.output.render({}, genuine).map(b => b.text).join('\n')
    check('a completed empty search still says "(no matches)"', cleanRender.includes('(no matches)'), cleanRender.trim())

    const morePages = {
      status: 'completed', phase: 'verify', complete: false, truncated: true,
      truncatedBy: 'row-limit', scanComplete: true, pageComplete: false,
      items: ['a.js'], matched: 5, matchedObserved: 5, matchedTotal: 5, nextOffset: 1,
    }
    const pagedRender = globDef.output.render({}, morePages).map(b => b.text).join('\n')
    check('a page-limited result does advise the real offset retry', /continue with offset=1/.test(pagedRender), pagedRender.trim())
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
    const out = grepDef.output.render({ outputMode: 'files_with_matches' }, filesMode).map(b => b.text).join('\n')
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
  apply(ctx, { shell: { backend: 'none' } })
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
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exitCode = failures === 0 ? 0 : 1