/**
 * Browser-half smoke test.
 *
 * The settings page cannot be clicked from here, so this drives the same code
 * with a stub React: it checks the slot registration the Plugins page keys on,
 * the two radio choices, and that Save sends one `set` path operation for
 * `defaultTerminal` with the revision the form was read at.
 *
 * Run: node _clienttest.mjs
 */
import assert from 'node:assert/strict'

let failures = 0
const check = (label, condition, extra = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`)
  if (!condition) failures += 1
}

// ---- stub React -------------------------------------------------------
// Hook slots persist across renders; the cursor resets on each render call, so
// a setState in one render is visible in the next — enough to drive the page.
const hookSlots = []
let hookCursor = 0
const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...props, children: children.length > 1 ? children : children[0] } }
  },
  useState(initial) {
    const index = hookCursor
    hookCursor += 1
    if (!(index in hookSlots)) hookSlots[index] = initial
    const set = (value) => {
      hookSlots[index] = typeof value === 'function' ? value(hookSlots[index]) : value
    }
    return [hookSlots[index], set]
  },
  useEffect() {},
}

const render = (component, props) => {
  hookCursor = 0
  return component(props)
}

/** Depth-first walk of the stub element tree. */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  visit(node)
  const children = node.props?.children
  for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) walk(child, visit)
}

// ---- load the bundle the way the page does ----------------------------
let registration
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      registration = { id, plugin: factory(name => (name === 'react' ? React : undefined)) }
    },
  },
}
await import('./client.js')

check('the bundle registers under the package name', registration?.id === 'dshops-lite', String(registration?.id))
const plugin = registration?.plugin ?? {}
check('the browser half injects only slots', Array.isArray(plugin.inject) && plugin.inject.join(',') === 'slots',
  JSON.stringify(plugin.inject))

// ---- apply against a stub slot system ---------------------------------
let localeRegistered
const slotEntries = new Map()
const ctx = {
  get: (name) => (name === 'locale'
    ? { register: (ns, dictionary) => { localeRegistered = { ns, dictionary }; return () => {} } }
    : undefined),
  effect: (run) => run(),
  slots: {
    inject: (owner, register) => { assert.equal(owner, 'plugins.row.config'); register() },
    register: (options, component) => {
      slotEntries.set(options.key, { options, component })
      return () => slotEntries.delete(options.key)
    },
  },
}
plugin.apply(ctx)

const entry = slotEntries.get('dshops-lite#dshops-lite')
check('it registers the row page under <package>#<row id>', entry !== undefined, [...slotEntries.keys()].join(', '))
check('the entry names the plugins.row.config slot', entry?.options?.name === 'plugins.row.config')
check('the entry binds a locale dictionary', entry?.options?.locale === 'dshopsLite')
check('the dictionary carries both baseline languages',
  localeRegistered?.ns === 'dshopsLite' && localeRegistered?.dictionary?.en !== undefined
    && localeRegistered?.dictionary?.zh !== undefined)

// ---- the page itself --------------------------------------------------
const component = entry.component
const t = (key) => key

const summary = render(component, { view: 'summary', t })
const summaryText = JSON.stringify(summary)
check('the summary view renders a one-liner', /Default terminal:/.test(summaryText), summaryText)

const noForm = render(component, { view: 'page', t })
check('a page without a form explains itself',
  /does not expose|no configuration for this row/.test(JSON.stringify(noForm)), JSON.stringify(noForm))

const calls = []
const form = {
  state: { status: 'ready', value: { defaultTerminal: 'pwsh' }, revision: 7, writable: true, base: {}, user: {} },
  mutate: async (ops, revision) => {
    calls.push({ ops, revision })
    return true
  },
}

// Render 1: the host value is pwsh, nothing staged yet.
hookSlots.length = 0
const first = render(component, { view: 'page', form, t })
const radios = []
let saveButton
walk(first, node => {
  if (node.type === 'input' && node.props?.type === 'radio') radios.push(node)
  if (node.type === 'button') saveButton = node
})
check('the page offers exactly two terminal choices', radios.length === 2, radios.map(r => r.props.value).join(', '))
check('the choices are pwsh and gitbash',
  radios.map(r => r.props.value).sort().join(',') === 'gitbash,pwsh')
check('the host value is the checked one', radios.find(r => r.props.value === 'pwsh')?.props.checked === true)
check('Save is disabled while nothing changed', saveButton?.props?.disabled === true)

// Switch to Git Bash, then render again: now the draft differs from the host.
radios.find(r => r.props.value === 'gitbash').props.onChange()
const second = render(component, { view: 'page', form, t })
let saveAfterChange
walk(second, node => { if (node.type === 'button') saveAfterChange = node })
check('Save becomes enabled once a change is staged', saveAfterChange?.props?.disabled === false)

await saveAfterChange.props.onClick()
check('Save writes one set operation for defaultTerminal',
  calls.length === 1 && calls[0].ops.length === 1
    && calls[0].ops[0].op === 'set'
    && calls[0].ops[0].path.join('.') === 'defaultTerminal'
    && calls[0].ops[0].value === 'gitbash',
  JSON.stringify(calls[0]))
check('Save sends the revision the form was read at', calls[0]?.revision === 7, String(calls[0]?.revision))

// A refused write must be reported, not swallowed.
const refusing = {
  state: { status: 'ready', value: { defaultTerminal: 'pwsh' }, revision: 8, writable: true, base: {}, user: {} },
  mutate: async () => false,
}
hookSlots.length = 0
const third = render(component, { view: 'page', form: refusing, t })
const thirdRadios = []
let thirdButton
walk(third, node => {
  if (node.type === 'input' && node.props?.type === 'radio') thirdRadios.push(node)
  if (node.type === 'button') thirdButton = node
})
thirdRadios.find(r => r.props.value === 'gitbash').props.onChange()
const fourth = render(component, { view: 'page', form: refusing, t })
let fourthButton
walk(fourth, node => { if (node.type === 'button') fourthButton = node })
await fourthButton.props.onClick()
const afterRefusal = render(component, { view: 'page', form: refusing, t })
let status
walk(afterRefusal, node => { if (node.props?.role === 'status') status = node })
check('a refused write surfaces a failure message',
  /refused the change|failed/i.test(String(status?.props?.children)), String(status?.props?.children))

// ---- locale-aware fallback --------------------------------------------
// The Host dictionary is optional (client.js registers it inside a try/catch),
// so with a t() that echoes the key the page must still speak the locale it was
// handed instead of always falling back to English.
const zhSummary = JSON.stringify(render(component, { view: 'summary', t, locale: 'zh' }))
check('a zh locale renders the Chinese summary', zhSummary.includes('默认终端：'), zhSummary)
check('a zh locale does not fall back to the English summary', !zhSummary.includes('Default terminal:'), zhSummary)

hookSlots.length = 0
const zhPage = JSON.stringify(render(component, { view: 'page', form, t, locale: 'zh' }))
check('a zh locale renders Chinese page copy', zhPage.includes('默认终端') && zhPage.includes('保存'),
  zhPage.slice(0, 160))
check('a zh locale page carries no English fallback copy',
  !zhPage.includes('Default terminal') && !zhPage.includes('Save'), zhPage.slice(0, 160))

// The Host may hand over a descriptor, a getter, or a regional tag instead.
const objectSummary = JSON.stringify(render(component, { view: 'summary', t, locale: { current: 'zh' } }))
const getterSummary = JSON.stringify(render(component, { view: 'summary', t, locale: () => ({ id: 'zh' }) }))
check('an object or getter locale resolves to its language',
  objectSummary.includes('默认终端：') && getterSummary.includes('默认终端：'), `${objectSummary} ${getterSummary}`)
const regionalSummary = JSON.stringify(render(component, { view: 'summary', t, locale: 'zh-CN' }))
check('a regional tag resolves to its baseline language', regionalSummary.includes('默认终端：'), regionalSummary)

// Unknown and absent locales must not throw and must read as English.
let deThrew = false
let deText = ''
try {
  hookSlots.length = 0
  deText = JSON.stringify(render(component, { view: 'page', form, t, locale: 'de' }))
} catch {
  deThrew = true
}
check('an unknown locale does not throw', deThrew === false)
check('an unknown locale reads as English',
  deText.includes('Default terminal') && !deText.includes('默认终端'), deText.slice(0, 160))

let noLocaleThrew = false
let noLocaleText = ''
try {
  hookSlots.length = 0
  noLocaleText = JSON.stringify(render(component, { view: 'page', form, t }))
} catch {
  noLocaleThrew = true
}
check('a page without a locale does not throw', noLocaleThrew === false)
check('a page without a locale reads as English',
  noLocaleText.includes('Default terminal') && !noLocaleText.includes('默认终端'), noLocaleText.slice(0, 160))

// Both dictionaries are one key set, so neither language can drift.
const enKeys = Object.keys(localeRegistered.dictionary.en).sort()
const zhKeys = Object.keys(localeRegistered.dictionary.zh).sort()
check('the en and zh dictionaries keep identical key sets',
  enKeys.length === 16 && zhKeys.join(',') === enKeys.join(','), `${enKeys.length} / ${zhKeys.length} keys`)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exitCode = failures === 0 ? 0 : 1