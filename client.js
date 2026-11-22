/**
 * dshops-lite — browser half.
 *
 * One page: the row's own configuration on the sidebar Plugins page (Settings →
 * Built-in plugins is a read-only inventory). It renders the
 * `plugins.row.config` slot entry keyed `dshops-lite#dshops-lite`, which is what
 * gives the row a Configure control; the page owner supplies `form.state` and
 * `form.mutate()` because the Host row exposes a volatile Config field.
 *
 * Only the two terminal choices are rendered here. Everything else in the row
 * config (paths, timeouts) is ordinary configuration and stays in
 * cordis.patch.yml, where the plugin reads it at start-up.
 *
 * Written as plain browser JS in the client module system's lazy-CJS factory
 * format, with React taken from the platform module table and no Harness
 * package imported at runtime.
 */
window.__ModuleLoader__.load({
  id: 'dshops-lite',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const FALLBACK = {
      en: {
        title: 'Default terminal',
        description: 'The terminal this plugin offers the agent. A change applies immediately.',
        paramsHint: 'Probe timeout, output budgets and the rest are configured in the profile cordis.patch.yml.',
        pwshLabel: 'PowerShell (host tool)',
        pwshHint: 'Nothing is added: the host pwsh tool is the terminal, exactly as with this plugin off.',
        gitbashLabel: 'Git Bash',
        gitbashHint: 'ops_shell runs Git Bash and becomes the default terminal; the host pwsh tool stays available. Needs Git for Windows, and if the probe fails no shell tool is added.',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved. The change applies immediately.',
        failed: 'The Host refused the change. Check the current value and try again; if it still fails, reload the page.',
        unchanged: 'No changes staged.',
        loading: 'Reading configuration…',
        unavailable: 'This configuration is not writable here (read-only, or overridden by a higher-priority layer).',
        noForm: 'The Host exposes no configuration for this row, so it cannot be edited here.',
        summary: 'Default terminal: PowerShell (host tool) or Git Bash.',
      },
      zh: {
        title: '默认终端',
        description: '本插件提供给模型的终端，保存后立即生效。',
        paramsHint: '探活超时、输出预算等其余参数在 profile 的 cordis.patch.yml 中配置。',
        pwshLabel: 'PowerShell（宿主工具）',
        pwshHint: '不额外提供工具：宿主 pwsh 工具就是终端，与未开启本插件时一致。',
        gitbashLabel: 'Git Bash',
        gitbashHint: 'ops_shell 使用 Git Bash 并作为默认终端，宿主 pwsh 工具仍可用。需要先安装 Git for Windows；探活失败时不会发布 shell 工具。',
        save: '保存',
        saving: '正在保存…',
        saved: '已保存，设置立即生效。',
        failed: '宿主拒绝了这次修改。请确认当前值后重试；仍失败再刷新页面。',
        unchanged: '尚未改动。',
        loading: '正在读取配置…',
        unavailable: '当前配置不可写：可能只读，或被更高优先级的配置覆盖。',
        noForm: '宿主没有为这一行提供配置，无法在此编辑。',
        summary: '默认终端：PowerShell（宿主工具）或 Git Bash。',
      },
    }

    /** A locale is a tag, a getter, or a descriptor such as { current }. */
    const readLocale = (value, depth = 0) => {
      try {
        if (typeof value === 'string') return value.trim() === '' ? undefined : value
        if (typeof value === 'function' && depth < 3) return readLocale(value(), depth + 1)
        if (value !== null && typeof value === 'object' && depth < 3) {
          for (const field of ['current', 'id', 'locale']) {
            const found = readLocale(value[field], depth + 1)
            if (typeof found === 'string') return found
          }
        }
      } catch {
        // A Host getter that throws means "no locale signal", not a broken page.
      }
      return undefined
    }

    /** The language this page speaks: the Host's tag when this file ships it, else English. */
    const resolveLocale = (props, snapshot) => {
      const tag = readLocale(props && props.locale)
        ?? readLocale(snapshot && snapshot.locale)
        ?? readLocale(props && props.snapshot && props.snapshot.locale)
      if (typeof tag !== 'string') return 'en'
      const primary = tag.trim().toLowerCase().split(/[-_]/)[0]
      return Object.prototype.hasOwnProperty.call(FALLBACK, primary) ? primary : 'en'
    }

    /** Copy for one key: the Host's dictionary, then the active locale, then English. */
    const translator = (t, locale) => (key) => {
      const fromHost = typeof t === 'function' ? t(key) : undefined
      if (typeof fromHost === 'string' && fromHost !== '' && fromHost !== key) return fromHost
      const localized = FALLBACK[locale]
      if (localized && typeof localized[key] === 'string') return localized[key]
      return typeof FALLBACK.en[key] === 'string' ? FALLBACK.en[key] : key
    }

    const color = {
      label: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      tertiary: 'var(--dsw-alias-label-tertiary)',
      border: 'var(--dsw-alias-border-l2)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      accent: 'var(--dsw-alias-state-business-primary)',
      danger: 'var(--dsw-alias-state-error-primary)',
      button: 'var(--dsw-alias-button-primary-fill)',
      buttonLabel: 'var(--dsw-alias-label-primary-inverted)',
    }

    const styles = {
      section: { display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '640px', color: color.label },
      title: { margin: 0, fontSize: '14px', lineHeight: '20px', fontWeight: 600 },
      description: { margin: 0, fontSize: '12px', lineHeight: '18px', color: color.secondary },
      group: { display: 'flex', flexDirection: 'column', gap: '8px', margin: 0, padding: 0 },
      option: (checked) => ({
        display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '10px 12px',
        border: `1px solid ${checked ? color.accent : color.border}`,
        borderRadius: '8px', background: color.surface, cursor: 'pointer',
      }),
      radio: { margin: '2px 0 0 0', accentColor: color.accent, flex: '0 0 auto' },
      optionText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
      optionLabel: { fontSize: '13px', lineHeight: '18px', fontWeight: 500 },
      optionHint: { fontSize: '12px', lineHeight: '18px', color: color.tertiary },
      actions: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      button: (disabled) => ({
        height: '28px', padding: '0 14px', borderRadius: '6px', border: 'none',
        background: disabled ? color.surface : color.button,
        color: disabled ? color.tertiary : color.buttonLabel,
        font: 'inherit', fontSize: '13px', cursor: disabled ? 'default' : 'pointer',
      }),
      status: (tone) => ({
        fontSize: '12px', lineHeight: '18px',
        color: tone === 'error' ? color.danger : tone === 'muted' ? color.tertiary : color.secondary,
      }),
    }

    const OPTIONS = [
      { value: 'pwsh', label: 'pwshLabel', hint: 'pwshHint' },
      { value: 'gitbash', label: 'gitbashLabel', hint: 'gitbashHint' },
    ]

    /** The row's page: two terminal choices, one save control, one status line. */
    function ConfigPage(props) {
      const { view } = props
      const form = props.form
      const snapshot = form && form.state ? form.state : undefined
      const tx = translator(props.t, resolveLocale(props, snapshot))
      const hostValue = snapshot && snapshot.value ? snapshot.value.defaultTerminal : undefined
      // Hooks run before the summary short-circuit: React requires the same hook
      // order on every render, and the Host may switch this entry between views.
      const [staged, setStaged] = React.useState(typeof hostValue === 'string' ? hostValue : 'pwsh')
      const [phase, setPhase] = React.useState('idle')

      // The owner re-renders us when the Host's accepted value moves; follow it
      // so the radios never show a stale choice after a save or an external edit.
      React.useEffect(() => {
        if (typeof hostValue === 'string') setStaged(hostValue)
      }, [hostValue])

      if (view === 'summary') return h('span', null, tx('summary'))

      if (form === undefined || snapshot === undefined) {
        return h('section', { style: styles.section },
          h('p', { style: styles.description }, tx('noForm')))
      }

      if (snapshot.status === 'loading') {
        return h('section', { style: styles.section },
          h('p', { style: styles.description }, tx('loading')))
      }

      if (snapshot.status === 'unavailable' || snapshot.writable === false) {
        return h('section', { style: styles.section },
          h('p', { style: styles.description }, tx('unavailable')))
      }

      const dirty = typeof hostValue === 'string' && staged !== hostValue
      const busy = phase === 'saving'
      const disabled = busy || !dirty

      const save = async () => {
        if (disabled) return
        setPhase('saving')
        try {
          const accepted = await form.mutate(
            [{ op: 'set', path: ['defaultTerminal'], value: staged }],
            snapshot.revision,
          )
          setPhase(accepted ? 'saved' : 'failed')
        } catch {
          setPhase('failed')
        }
      }

      const settled = phase === 'saved' && !dirty
      const statusTone = phase === 'failed' ? 'error' : settled ? 'normal' : 'muted'
      const statusText = phase === 'saving'
        ? tx('saving')
        : settled
          ? tx('saved')
          : phase === 'failed'
            ? tx('failed')
            : dirty ? '' : tx('unchanged')

      return h('section', { style: styles.section },
        h('h4', { style: styles.title }, tx('title')),
        h('p', { style: styles.description }, tx('description')),
        h('p', { style: styles.description }, tx('paramsHint')),
        h('div', { role: 'radiogroup', 'aria-label': tx('title'), style: styles.group },
          OPTIONS.map(option => h('label', {
            key: option.value,
            style: styles.option(staged === option.value),
          },
          h('input', {
            type: 'radio',
            name: 'dshops-lite-default-terminal',
            value: option.value,
            checked: staged === option.value,
            disabled: busy,
            style: styles.radio,
            onChange: () => { setStaged(option.value); setPhase('idle') },
          }),
          h('span', { style: styles.optionText },
            h('span', { style: styles.optionLabel }, tx(option.label)),
            h('span', { style: styles.optionHint }, tx(option.hint))))),
        ),
        h('div', { style: styles.actions },
          h('button', {
            type: 'button',
            style: styles.button(disabled),
            disabled,
            onClick: save,
          }, busy ? tx('saving') : tx('save')),
          h('span', { role: 'status', 'aria-live': 'polite', style: styles.status(statusTone) }, statusText)),
      )
    }

    /** Register the page, and the dictionary its copy rides. */
    function apply(ctx) {
      const locale = ctx.get('locale')
      if (locale && typeof locale.register === 'function') {
        try {
          ctx.effect(() => locale.register('dshopsLite', { en: FALLBACK.en, zh: FALLBACK.zh }), 'dshops-lite: locale')
        } catch (error) {
          // The page still renders with this file's own fallback copy.
          console.warn('dshops-lite: could not register the locale dictionary', error)
        }
      }
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: 'dshops-lite#dshops-lite',
        locale: 'dshopsLite',
      }, ConfigPage))
    }

    return { inject: ['slots'], apply }
  },
})