/**
 * The ops_* file tools: definitions, argument normalization, and compact renderers.
 *
 * Two deliberate choices keep this cheap for the model:
 *  - `parameters` stay small and only document what the worker actually accepts.
 *  - results are rendered as dense line-oriented text instead of raw JSON, and
 *    every incomplete page says so with its `nextOffset`. Honest paging is what
 *    stops the retry loop that costs more than any schema saving.
 */
import path from 'node:path'

/** Upstream public prefix. Tool names are `ops_` + worker operation name. */
const PREFIX = 'ops_'

/** Resolve a model-supplied path against the session cwd and normalize it. */
export function absoluteTarget(raw, cwd) {
  const value = typeof raw === 'string' && raw.trim() !== '' ? raw : '.'
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value)
}

function text(value) {
  return [{ type: 'text', text: value }]
}

/**
 * Paging note for line-oriented reads (inspect_local_file, read_files).
 *
 * These always have a stable `nextOffset`, so "continue with offset=N" is real
 * advice and the only thing worth saying.
 */
function lineNote(value) {
  if (value.complete !== false) return ''
  const next = value.nextOffset
  return typeof next === 'number' && next > 0
    ? `[truncated; continue with offset=${next}]`
    : '[truncated; no continuation available]'
}

/**
 * Paging note for searches (glob, grep).
 *
 * A search can stop for two different reasons and they need different advice.
 * Hitting the scan budget leaves NO stable continuation — telling the model to
 * "continue with offset=0" would just repeat the same truncated scan.
 */
function searchNote(value) {
  const parts = []
  const by = value.truncatedBy
  if (by === 'scan-budget') parts.push(`scan budget reached after ${value.scannedFiles ?? '?'} files`)
  else if (by && by !== 'none') parts.push(`truncated by ${by}`)
  if (value.scanComplete === false && by !== 'scan-budget') parts.push('scan incomplete')
  if (value.pageComplete === false) parts.push('page incomplete')
  // `failed`/`skipped` are gap counters, not errors; the worker's nextAction
  // already explains them, so mentioning them here only adds noise.
  if (parts.length === 0) return ''
  const next = value.nextOffset
  const canContinue = value.pageComplete === false && typeof next === 'number' && next > 0
  return canContinue
    ? `[${parts.join(', ')}; continue with offset=${next}]`
    : `[${parts.join(', ')}; no continuation — narrow the path and search again]`
}

/** True when a search result must not be read as "nothing matched". */
function searchIncomplete(value) {
  return value.scanComplete === false || value.pageComplete === false
}

function itemsOf(value) {
  return Array.isArray(value.items) ? value.items : []
}

/**
 * Renderer for tools whose items are `{line, text}` records, optionally prefixed
 * by their path (read_files groups per file).
 */
function renderLines(value, options = {}) {
  const items = itemsOf(value)
  const lines = []
  if (options.header) lines.push(options.header)
  let lastPath
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    if (options.perFile && item.path !== lastPath) {
      lastPath = item.path
      const meta = item.error ? ` (error: ${item.error.message ?? item.error.code ?? 'failed'})` : ''
      lines.push(`--- ${item.path}${meta}`)
    }
    const lineNo = item.line ?? item.offset
    const body = item.text ?? ''
    lines.push(lineNo === undefined ? body : `${lineNo}\t${body}`)
  }
  if (items.length === 0 && !options.header) lines.push('(no rows)')
  const note = lineNote(value)
  if (note !== '') lines.push(note)
  return text(lines.join('\n'))
}

/** Map worker failure envelopes onto a thrown Error the host reports as isError. */
export function workerFailure(value) {
  const error = value?.error ?? {}
  const code = error.code ?? 'IO_ERROR'
  const message = error.message ?? 'The native operation failed.'
  const advice = error.nextAction ? ` ${error.nextAction}` : ''
  const retry = error.retryable === false ? ' Do not retry this call unchanged.' : ''
  const failure = new Error(`${code}: ${message}${advice}${retry}`)
  failure.code = code
  failure.detail = error
  return failure
}

/** Arguments the worker will reject if sent as null/undefined or empty. */
function compact(object) {
  const out = {}
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && value === '') continue
    if (Array.isArray(value) && value.length === 0) continue
    out[key] = value
  }
  return out
}

const revisionParam = {
  type: ['string'],
  description: 'Revision from ops_stat: 64-hex, or the literal "absent" when the file must not exist yet.',
}

/**
 * Every file tool, minus the shell.
 * @param {{invoke: Function, session: Function}} deps
 * @returns {Array<object>} host tool definitions.
 */
export function fileToolDefinitions(deps) {
  const { invoke, session } = deps
  const def = (spec) => ({
    name: PREFIX + spec.name,
    description: spec.description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: spec.properties,
      required: spec.required ?? [],
    },
    output: {
      schema: { type: 'object' },
      // Forward BOTH arguments: a renderer may need the call arguments to
      // describe its result honestly (e.g. grep's outputMode changes what the
      // counts mean).
      render: (args, value) => (spec.render ?? ((v) => renderLines(v)))(args, value),
    },
    async execute(args, exec) {
      const { cwd, scope, readOnly } = await session(exec)
      const normalized = spec.normalize(args, cwd)
      const result = await invoke(spec.name, normalized, { cwd, scope, readOnly, exec })
      if (result.ok === false && result.transport) throw new Error(result.message)
      if (result.value?.status === 'error') throw workerFailure(result.value)
      return result.value ?? {}
    },
  })

  const definitions = [
    def({
      name: 'inspect_local_file',
      description: 'Read a line range of one file. Line numbers are 1-based; the result reports lineCount and nextOffset.',
      properties: {
        path: { type: 'string', description: 'File to read (relative to the workspace or absolute).' },
        offset: { type: 'number', description: 'First line to return, 1-based. Default 1.' },
        limit: { type: 'number', description: 'Maximum lines to return. Default 200, max 10000.' },
        encoding: { type: 'string', enum: ['utf-8', 'hex'], description: 'utf-8 (default) or hex view.' },
      },
      required: ['path'],
      normalize: (args, cwd) => compact({ path: absoluteTarget(args.path, cwd), offset: args.offset, limit: args.limit, ...(args.encoding === 'hex' ? { view: 'hex' } : args.encoding === 'utf-8' ? { encoding: 'utf-8' } : {}) }),
    }),
    def({
      name: 'read_files',
      description: 'Read line ranges from several files in one call. Returns per-file results; an incomplete read sets status "partial".',
      properties: {
        files: {
          type: 'array',
          description: 'Up to 32 files, each {path, offset?, limit?}.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string' },
              offset: { type: 'number' },
              limit: { type: 'number' },
            },
            required: ['path'],
          },
        },
      },
      required: ['files'],
      normalize: (args, cwd) => compact({
        files: (Array.isArray(args.files) ? args.files : []).slice(0, 32).map(file => compact({
          path: absoluteTarget(file?.path, cwd), offset: file?.offset, limit: file?.limit,
        })),
      }),
      render: (_args, value) => {
        const items = itemsOf(value)
        const lines = []
        for (const file of items) {
          const meta = file.error ? ` (error: ${file.error.message ?? file.error.code ?? 'failed'})` : ''
          lines.push(`--- ${file.path}${meta}`)
          for (const row of Array.isArray(file.items) ? file.items : []) {
            lines.push(`${row.line ?? ''}\t${row.text ?? ''}`)
          }
          // Each entry is a per-file inspect envelope, so it pages by line.
          const note = lineNote(file)
          if (note !== '') lines.push(note)
        }
        if (items.length === 0) lines.push('(no files)')
        // The per-file notes already say each file was cut off; an outer note is
        // only worth printing when the worker itself reports files still pending.
        if (value.pending > 0) {
          lines.push(`[partial; ${value.pending} file(s) pending, continue with index=${value.nextIndex}]`)
        }
        return text(lines.join('\n'))
      },
    }),
    def({
      name: 'glob',
      description: 'Find files or directories by glob pattern. Matched paths are absolute. scanComplete and pageComplete report coverage; nextOffset continues an incomplete page.',
      properties: {
        path: { type: 'string', description: 'Directory to search. Defaults to the workspace root.' },
        pattern: { type: 'array', items: { type: 'string' }, description: 'One or more glob patterns, e.g. ["src/**/*.ts"].' },
        kind: { type: 'string', enum: ['file', 'directory'], description: 'Restrict to files or directories.' },
        outputMode: { type: 'string', enum: ['paths', 'details'], description: 'paths (default) or details with size and mtime.' },
        sort: { type: 'string', enum: ['path', 'modified'], description: 'Sort order.' },
        includeHidden: { type: 'boolean', description: 'Include dot-files and ignored paths.' },
        offset: { type: 'number', description: '0-based row offset into the result.' },
        limit: { type: 'number', description: 'Maximum rows. Default 100.' },
      },
      required: ['pattern'],
      normalize: (args, cwd) => compact({
        path: absoluteTarget(args.path, cwd),
        pattern: Array.isArray(args.pattern) ? args.pattern : [args.pattern].filter(Boolean),
        kind: args.kind, outputMode: args.outputMode, sort: args.sort,
        includeHidden: args.includeHidden, offset: args.offset, limit: args.limit,
      }),
      render: (_args, value) => {
        const items = itemsOf(value)
        const lines = []
        for (const item of items) {
          if (typeof item === 'string') lines.push(item)
          else if (item && typeof item === 'object') {
            const size = item.bytes === undefined ? '' : ` ${item.bytes}`
            const when = item.modified === undefined ? '' : ` ${item.modified}`
            lines.push(`${item.path}${size}${when}`)
          }
        }
        if (items.length === 0) {
          lines.push(searchIncomplete(value)
            ? '(no matches in the part that was scanned — the search did not finish)'
            : '(no matches)')
        }
        const total = value.matchedTotal ?? value.matched
        if (total !== undefined) lines.push(`[${items.length} of ${total} rows]`)
        const note = searchNote(value)
        if (note !== '') lines.push(note)
        return text(lines.join('\n'))
      },
    }),
    def({
      name: 'grep',
      description: 'Search file contents with a regular expression. outputMode picks matched lines, file names, or per-file counts.',
      properties: {
        path: { type: 'string', description: 'Directory to search. Defaults to the workspace root.' },
        pattern: { type: 'string', description: 'Rust regular expression.' },
        glob: { type: 'array', items: { type: 'string' }, description: 'Restrict to matching paths, e.g. ["**/*.ts"].' },
        outputMode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'content (default), files_with_matches, or count.' },
        caseInsensitive: { type: 'boolean', description: 'Ignore case.' },
        lineNumbers: { type: 'boolean', description: 'Include line numbers for content mode.' },
        beforeContext: { type: 'number', description: 'Lines of context before a match.' },
        afterContext: { type: 'number', description: 'Lines of context after a match.' },
        multiline: { type: 'boolean', description: 'Allow patterns to span lines.' },
        includeHidden: { type: 'boolean', description: 'Include dot-files and ignored paths.' },
        offset: { type: 'number', description: '0-based row offset into the result.' },
        limit: { type: 'number', description: 'Maximum rows. Default 100.' },
      },
      required: ['pattern'],
      normalize: (args, cwd) => compact({
        path: absoluteTarget(args.path, cwd), pattern: args.pattern, glob: args.glob,
        outputMode: args.outputMode, caseInsensitive: args.caseInsensitive,
        lineNumbers: args.lineNumbers, beforeContext: args.beforeContext, afterContext: args.afterContext,
        multiline: args.multiline, includeHidden: args.includeHidden,
        offset: args.offset, limit: args.limit,
      }),
      render: (args, value) => {
        const items = itemsOf(value)
        const lines = []
        for (const item of items) {
          if (!item || typeof item !== 'object') continue
          if (item.count !== undefined) lines.push(`${item.path}: ${item.count}`)
          else if (item.text !== undefined) lines.push(`${item.path}:${item.line ?? ''}: ${item.text}`)
          else lines.push(item.path)
        }
        if (items.length === 0) {
          lines.push(searchIncomplete(value)
            ? '(no matches in the part that was scanned — the search did not finish)'
            : '(no matches)')
        }
        const total = value.matchedTotal
        // In files_with_matches mode `matchedTotal` counts matching LINES while
        // `items` counts files, so "N of M rows" would compare unlike things.
        if (total !== undefined) {
          lines.push(args?.outputMode === 'files_with_matches'
            ? `[${items.length} file(s); ${total} matching line(s)]`
            : `[${items.length} of ${total} rows]`)
        }
        const note = searchNote(value)
        if (note !== '') lines.push(note)
        return text(lines.join('\n'))
      },
    }),
    def({
      name: 'stat',
      description: 'Read one path\'s existence, size, line count and revision. Take the revision before a write or edit.',
      properties: { path: { type: 'string', description: 'File or directory to inspect.' } },
      required: ['path'],
      normalize: (args, cwd) => compact({ path: absoluteTarget(args.path, cwd) }),
      render: (_args, value) => text([
        `path: ${value.path}`,
        `exists: ${value.exists}`,
        value.exists === false ? '' : `bytes: ${value.bytes}`,
        value.exists === false ? '' : `lines: ${value.lineCount}`,
        value.exists === false ? '' : `revision: ${value.revision}`,
        value.modifiedMs === undefined ? '' : `modifiedMs: ${value.modifiedMs}`,
      ].filter(line => line !== '').join('\n')),
    }),
    def({
      name: 'write_file',
      description: 'Write a whole file. expectedRevision guards against clobbering a concurrent change: pass the revision from ops_stat, or "absent" for a new file.',
      properties: {
        path: { type: 'string', description: 'File to write.' },
        content: { type: 'string', description: 'Full file content.' },
        expectedRevision: revisionParam,
        dryRun: { type: 'boolean', description: 'Report the change without writing.' },
      },
      required: ['path', 'content', 'expectedRevision'],
      normalize: (args, cwd) => compact({
        path: absoluteTarget(args.path, cwd), content: args.content,
        expectedRevision: args.expectedRevision, dryRun: args.dryRun,
      }),
      render: (_args, value) => text(JSON.stringify(value)),
    }),
    def({
      name: 'edit_file',
      description: 'Replace exact text inside one file. Each edit\'s oldText must match exactly once. expectedRevision guards concurrency.',
      properties: {
        path: { type: 'string', description: 'File to edit.' },
        expectedRevision: revisionParam,
        edits: {
          type: 'array',
          description: 'One or more {oldText, newText} replacements.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { oldText: { type: 'string' }, newText: { type: 'string' } },
            required: ['oldText', 'newText'],
          },
        },
        dryRun: { type: 'boolean', description: 'Report the change without writing.' },
      },
      required: ['path', 'expectedRevision', 'edits'],
      normalize: (args, cwd) => compact({
        path: absoluteTarget(args.path, cwd), expectedRevision: args.expectedRevision,
        edits: Array.isArray(args.edits) ? args.edits : [], dryRun: args.dryRun,
      }),
      render: (_args, value) => text(JSON.stringify(value)),
    }),
    def({
      name: 'replace',
      // The worker implementation is `str::match_indices` + `str::replace`
      // (crates/ops-search/src/lib.rs), i.e. a LITERAL substring replace. It is
      // not regex: a backslash or `$1` is matched and emitted verbatim. Saying
      // otherwise here makes the model write a regex, get zero matches, and
      // conclude the file has no occurrences.
      description: 'Replace a literal substring across files (not a regex: pattern and replacement are taken verbatim). dryRun reports the affected files and counts without writing.',
      properties: {
        path: { type: 'string', description: 'Directory or file to rewrite.' },
        pattern: { type: 'string', description: 'Exact literal text to find. Regex syntax such as \\( or .* is matched literally.' },
        replacement: { type: 'string', description: 'Literal replacement text. $1 style backreferences are not expanded.' },
        glob: { type: 'array', items: { type: 'string' }, description: 'Restrict to matching paths.' },
        maxReplacements: { type: 'number', description: 'Cap on individual replacements.' },
        dryRun: { type: 'boolean', description: 'Report without writing.' },
      },
      required: ['path', 'pattern', 'replacement'],
      normalize: (args, cwd) => compact({
        path: absoluteTarget(args.path, cwd), pattern: args.pattern, replacement: args.replacement,
        glob: args.glob, maxReplacements: args.maxReplacements, dryRun: args.dryRun,
      }),
      render: (_args, value) => text(JSON.stringify(value)),
    }),
    def({
      name: 'diff',
      description: 'Show the difference between a file on disk and proposed content, without writing.',
      properties: {
        path: { type: 'string', description: 'File to compare.' },
        content: { type: 'string', description: 'Proposed full content.' },
        offset: { type: 'number', description: 'First diff hunk to return.' },
        limit: { type: 'number', description: 'Maximum hunks.' },
      },
      required: ['path', 'content'],
      normalize: (args, cwd) => compact({
        path: absoluteTarget(args.path, cwd), content: args.content,
        offset: args.offset, limit: args.limit,
      }),
      render: (_args, value) => text(JSON.stringify(value)),
    }),
    def({
      name: 'copy',
      description: 'Copy a file or directory. expectedRevision guards the source.',
      properties: {
        path: { type: 'string', description: 'Source.' },
        to: { type: 'string', description: 'Destination.' },
        expectedRevision: revisionParam,
      },
      required: ['path', 'to'],
      normalize: (args, cwd) => compact({
        path: absoluteTarget(args.path, cwd), to: absoluteTarget(args.to, cwd),
        expectedRevision: args.expectedRevision,
      }),
      render: (_args, value) => text(JSON.stringify(value)),
    }),
    def({
      name: 'move',
      description: 'Move or rename a path. expectedRevision guards the source.',
      properties: {
        path: { type: 'string', description: 'Source.' },
        to: { type: 'string', description: 'Destination.' },
        expectedRevision: revisionParam,
      },
      required: ['path', 'to'],
      normalize: (args, cwd) => compact({
        path: absoluteTarget(args.path, cwd), to: absoluteTarget(args.to, cwd),
        expectedRevision: args.expectedRevision,
      }),
      render: (_args, value) => text(JSON.stringify(value)),
    }),
    def({
      name: 'remove',
      description: 'Delete a path. expectedRevision must match the current revision; there is no force flag.',
      properties: {
        path: { type: 'string', description: 'Path to delete.' },
        expectedRevision: revisionParam,
      },
      required: ['path', 'expectedRevision'],
      normalize: (args, cwd) => compact({ path: absoluteTarget(args.path, cwd), expectedRevision: args.expectedRevision }),
      render: (_args, value) => text(JSON.stringify(value)),
    }),
  ]
  return definitions
}