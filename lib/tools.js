/**
 * The ops_* file tools: definitions, argument normalization, and compact renderers.
 *
 * Two deliberate choices keep this cheap for the model:
 *  - `parameters` stay small and only document what the worker actually accepts.
 *  - results are rendered as dense line-oriented text instead of raw JSON, and
 *    every incomplete page says so with its `nextOffset`. Honest paging is what
 *    stops the retry loop that costs more than any schema saving.
 *
 * ops_batch exists for a third saving: it chains several of these tools inside
 * one model call. It saves model round trips, NOT worker spawns — every
 * operation is still its own native process.
 */
import path from 'node:path'

/** Upstream public prefix. Tool names are `ops_` + worker operation name. */
const PREFIX = 'ops_'

/**
 * Single worker operations `ops_batch` may chain, listed in the order the model
 * sees them.
 *
 * Only operations whose whole value survives a one-line summary are here. A
 * batch reports one line per operation and returns no operation output, so a
 * read (inspect_local_file, read_files, glob, grep) would silently drop every
 * line after its first — call ops_read_files for several reads, or the single
 * tool when the content itself is needed.
 *
 * The worker's own "batch" op is deliberately absent: it only handles
 * copy/move/remove, and it creates a `.dsh-ops/` audit directory plus an
 * exclusive lock in the workspace. Chaining ordinary calls here costs one
 * process per operation but leaves no audit state behind.
 */
const BATCHABLE = [
  'stat', 'write_file', 'edit_file', 'replace', 'diff', 'copy', 'move', 'remove',
]

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
  const by = value.truncatedBy
  const next = value.nextOffset
  // A row limit is resumable: it pages the rows by offset, and the same call with
  // offset=nextOffset really does return the next page. `pageComplete` is TRUE for
  // that shape (the page was fully rendered), so it cannot decide resumability —
  // only the truncation cause can. A scan budget is different: it stops the walk
  // itself, and offset=0 would just repeat the same truncated scan.
  const canContinue = by === 'row-limit' && typeof next === 'number' && Number.isFinite(next) && next > 0
  const parts = []
  if (by === 'scan-budget') parts.push(`scan budget reached after ${value.scannedFiles ?? '?'} files`)
  else if (by && by !== 'none') parts.push(`truncated by ${by}`)
  // `failed`/`skipped` are gap counters, not errors; the worker's nextAction
  // already explains them, so mentioning them here only adds noise. "scan/page
  // incomplete" only restates a row limit and would contradict the advice, so it
  // stays out when the page has a real continuation.
  if (!canContinue) {
    if (value.scanComplete === false && by !== 'scan-budget') parts.push('scan incomplete')
    if (value.pageComplete === false) parts.push('page incomplete')
  }
  if (parts.length === 0) return ''
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

/**
 * First line of a tool's own renderer, capped at 240 characters.
 *
 * ops_batch reports one line per operation, and reusing the real renderer keeps
 * those lines truthful — stat's path/exists lines, a write's JSON verdict —
 * instead of inventing a second, weaker result format that can disagree with the
 * single-tool output. A line that had to be cut ends with "…", so the cut is
 * never silent.
 */
function summaryLine(spec, args, value) {
  const blocks = spec.render ? spec.render(args, value) : renderLines(value)
  const first = (Array.isArray(blocks) ? blocks.map(block => block?.text ?? '').join('\n') : '').split('\n')[0]
  return first.length > 240 ? `${first.slice(0, 240)}…` : first
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

/**
 * Revision guard for an operation on a path that must already exist: the
 * observed 64-hex SHA-256 from ops_stat. "absent" is NOT accepted for these —
 * only a create can require non-existence, so that case has its own param.
 */
const existingRevisionParam = {
  type: ['string'],
  description: 'Revision from ops_stat: the observed 64-hex SHA-256 of this path.',
}

/** Revision guard for a create-only write: 64-hex, or "absent" to require non-existence. */
const createRevisionParam = {
  type: ['string'],
  description: 'Revision from ops_stat: a 64-hex SHA-256, or the literal "absent" to require that the file does not exist yet.',
}

// ---- output contracts -------------------------------------------------------
// `output.schema` is what a code-mode (PTC) consumer sees when it reads a tool
// result. Left as `{ type: 'object' }` the tool is an untyped bag: reading a
// field that is not there yields undefined rather than a type error, and a
// caller that guesses the wrong nesting silently renders nothing. These
// declarations name the fields a consumer can rely on.
//
// They stay open (`additionalProperties: true`) on purpose: the worker also
// emits diagnostic counters (skipped, failed, scannedFiles, skipReasons, ...)
// whose exact set evolves, and a closed list would become a contract that lies
// as soon as the worker grows one. `required` lists only fields that are
// present in every observed shape, so a strict consumer cannot be broken by an
// optional diagnostic being absent.
//
// These cost nothing on the native path: the model still reads `render` text.
const str = (description) => ({ type: 'string', ...(description === undefined ? {} : { description }) })
const num = (description) => ({ type: 'number', ...(description === undefined ? {} : { description }) })
const bool = (description) => ({ type: 'boolean', ...(description === undefined ? {} : { description }) })
const obj = (properties, required) => ({
  type: 'object',
  additionalProperties: true,
  properties,
  ...(required === undefined ? {} : { required }),
})
const list = (items, description) => ({ type: 'array', items, ...(description === undefined ? {} : { description }) })

// Envelope fields shared by most observing tools.
const OUT_STATUS = str("'completed' when the whole request was served; a failed call throws instead of returning.")
const OUT_PHASE = str("Pipeline phase that produced the value; 'verify' for observation results.")
const OUT_COMPLETE = bool('False when this is a partial page; continue with nextOffset.')
const OUT_TRUNCATED = bool('True when part of the result was cut. A cut is never silent.')
const OUT_NEXT_OFFSET = num('Offset of the next page: 1-based for line reads, 0-based for searches.')
const OUT_TOTAL = num('Rows the operation produced in total, when it reports one.')

// A text row carries a 1-based `line`; a hex row carries a 0-based byte
// `offset` and names its `view` instead. Two shapes, one array.
const LINE_ITEM = {
  oneOf: [
    obj({ line: num('1-based line number.'), path: str(), text: str() }, ['line', 'text']),
    obj({ offset: num('0-based byte offset of the row in hex view.'), path: str(), text: str(), view: str() }, ['offset', 'text']),
  ],
}
const REVISION = '64-hex SHA-256 of the file content, as returned by ops_stat.'

const OUT_INSPECT = obj({
  status: OUT_STATUS, phase: OUT_PHASE, complete: OUT_COMPLETE, truncated: OUT_TRUNCATED,
  path: str('Resolved absolute path.'),
  revision: str(REVISION),
  bytes: num('Size of the whole file.'),
  lineCount: num('Lines in the whole file, not in this page.'),
  items: list(LINE_ITEM, 'One entry per returned line; empty when the range is past the end.'),
  nextOffset: OUT_NEXT_OFFSET,
}, ['status', 'items'])

const OUT_READ_FILES = obj({
  status: OUT_STATUS, complete: OUT_COMPLETE, truncated: OUT_TRUNCATED,
  items: list(obj({
    path: str(), status: str(), revision: str(REVISION), bytes: num(), lineCount: num(),
    complete: bool('False when this file is paged; continue with its own nextOffset.'),
    nextOffset: num(), items: list(LINE_ITEM),
    error: obj({ code: str(), message: str() }, ['code', 'message']),
  }, ['path']), 'One entry per requested file, in request order.'),
  pending: num('Files not read in this call; continue with nextIndex.'),
  nextIndex: num('0-based index of the first pending file.'),
  nextAction: str(), total: OUT_TOTAL,
}, ['status', 'items'])

const OUT_GLOB = obj({
  status: OUT_STATUS, complete: OUT_COMPLETE, truncated: OUT_TRUNCATED,
  truncatedBy: str("What cut the result: 'row-limit' is resumable with nextOffset, 'scan-budget' is not."),
  items: list({ oneOf: [str(), obj({ path: str(), bytes: num(), modified: num() }, ['path'])] },
    "outputMode 'paths' yields strings; 'details' yields {path, bytes, modified}."),
  scanComplete: bool('False when the walk stopped before covering the whole tree.'),
  pageComplete: bool('False when rows remain beyond this page.'),
  matchedTotal: num('Rows matching before the page limit.'),
  nextOffset: num('0-based row offset of the next page.'),
  scannedFiles: num(), skippedFiles: num(),
  continuation: str('Opaque resumable cursor. Offset paging is the supported way to page.'),
}, ['status', 'items'])

const OUT_GREP = obj({
  status: OUT_STATUS, complete: OUT_COMPLETE, truncated: OUT_TRUNCATED,
  truncatedBy: str("What cut the result: 'row-limit' is resumable with nextOffset, 'scan-budget' is not."),
  items: list(obj({ path: str(), line: num(), text: str(), count: num() }, ['path']),
    "content: {path, line, text}; files_with_matches: {path}; count: {path, count}."),
  scanComplete: bool('False when the walk stopped before covering the whole tree.'),
  pageComplete: bool('False when rows remain beyond this page.'),
  matchedTotal: num('Matching lines, not files, in every output mode.'),
  nextOffset: num('0-based row offset of the next page.'),
  scannedFiles: num(), skippedFiles: num(), nextAction: str(),
}, ['status', 'items'])

const OUT_STAT = obj({
  status: OUT_STATUS, complete: OUT_COMPLETE,
  // Only present when the path resolved: the worker omits it for a miss, which
  // is why the renderer falls back to the argument it was asked about.
  path: str('Resolved absolute path, present when the path exists.'),
  exists: bool('False when nothing is there; the metadata fields are then absent.'),
  revision: str('64-hex SHA-256, or the literal "absent" for a missing path.'),
  bytes: num(), lineCount: num(), modifiedMs: num(), readonly: bool(),
}, ['status', 'exists'])

const OUT_WRITE = obj({
  status: OUT_STATUS, phase: OUT_PHASE, complete: OUT_COMPLETE,
  changed: num('Files actually changed; 0 for a dryRun.'),
  dryRun: bool('True when nothing was written.'),
  revision: str('Revision after the change.'), bytes: num(), lineCount: num(),
  items: list(obj({
    path: str(), revision: str('Revision after the change.'), revisionBefore: str(),
    bytes: num(), bytesBefore: num(), bytesAfter: num(), lineCount: num(), metadata: obj({}),
  }, ['path'])),
}, ['status', 'items'])

const OUT_REPLACE = obj({
  status: OUT_STATUS, phase: OUT_PHASE, complete: OUT_COMPLETE, truncated: OUT_TRUNCATED,
  dryRun: bool('True when nothing was written.'),
  changed: num('Replacements applied overall; 0 for a dryRun with no matches.'),
  matched: OUT_TOTAL, skipped: num(), omitted: num(), failed: num(),
  skippedPaths: list(str(), 'Paths left untouched (unreadable, or not a regular file).'),
  items: list(obj({
    path: str(), replacements: num('Replacements applied in this file.'),
    revision: str(), revisionAfter: str(),
    bytesBefore: num(), bytesAfter: num(), lineCount: num(), lineCountBefore: num(),
  }, ['path'])),
}, ['status', 'items'])

const OUT_DIFF = obj({
  status: OUT_STATUS, phase: OUT_PHASE, complete: OUT_COMPLETE, truncated: OUT_TRUNCATED,
  changed: num(), matched: OUT_TOTAL, skipped: num(), omitted: num(), failed: num(),
  total: OUT_TOTAL, nextOffset: OUT_NEXT_OFFSET,
  before: obj({ bytes: num(), lineCount: num(), revision: str(REVISION) }, ['revision']),
  after: obj({ bytes: num(), lineCount: num(), revision: str(REVISION) }, ['revision']),
  hunk: obj({ added: num(), removed: num(), startLine: num() }, ['added', 'removed']),
  items: list(obj({ kind: str("'add', 'remove' or 'context'."), line: num(), text: str() }, ['kind', 'line', 'text'])),
}, ['status', 'items'])

const OUT_COPY = obj({
  status: OUT_STATUS, phase: OUT_PHASE, complete: OUT_COMPLETE,
  changed: num(), revision: str(), bytes: num(), lineCount: num(),
  items: list(obj({
    path: str(), revision: str(), revisionBefore: str(),
    bytes: num(), bytesBefore: num(), bytesAfter: num(), lineCount: num(), metadata: obj({}),
  }, ['path'])),
}, ['status', 'items'])

const OUT_MOVE = obj({
  status: OUT_STATUS, phase: OUT_PHASE, complete: OUT_COMPLETE,
  changed: num(), revision: str(), bytes: num(), lineCount: num(),
  items: list(obj({
    path: str(), removed: bool('True for the source entry of a move.'), revision: str(), revisionBefore: str(),
    bytes: num(), bytesBefore: num(), bytesAfter: num(), lineCount: num(), metadata: obj({}),
  }, ['path'])),
}, ['status', 'items'])

const OUT_REMOVE = obj({
  status: OUT_STATUS, phase: OUT_PHASE, complete: OUT_COMPLETE,
  changed: num(), revisionBefore: str(),
  items: list(obj({ path: str(), removed: bool() }, ['path'])),
}, ['status', 'items'])

const OUT_BATCH = obj({
  results: list(obj({
    index: num('1-based position in the request.'),
    op: str('Operation name without the ops_ prefix.'),
    ok: bool(),
    summary: str('First line of that tool\'s own rendering (ok results only).'),
    code: str('Worker failure code (failed results only).'),
    message: str('Failure message (failed results only).'),
  }, ['index', 'op', 'ok']), 'One entry per executed operation, in request order.'),
  total: num('Operations requested.'),
  failed: num('Operations that failed.'),
  stopped: bool('True when stopOnError ended the batch before the end of the list.'),
}, ['results', 'total', 'failed', 'stopped'])

/** Declared output contract per tool name; the single injection point. */
const OUTPUT_SCHEMAS = {
  inspect_local_file: OUT_INSPECT,
  read_files: OUT_READ_FILES,
  glob: OUT_GLOB,
  grep: OUT_GREP,
  stat: OUT_STAT,
  write_file: OUT_WRITE,
  edit_file: OUT_WRITE,
  replace: OUT_REPLACE,
  diff: OUT_DIFF,
  copy: OUT_COPY,
  move: OUT_MOVE,
  remove: OUT_REMOVE,
  batch: OUT_BATCH,
}

/**
 * Every file tool, minus the shell.
 * @param {{invoke: Function, session: Function}} deps
 * @returns {Array<object>} host tool definitions.
 */
export function fileToolDefinitions(deps) {
  const { invoke, session } = deps
  // Every worker-backed tool records its spec here. ops_batch resolves the tools
  // it may chain through this map, so it reuses the exact same normalize instead
  // of growing a second argument pipeline that could drift.
  const specs = new Map()
  const def = (spec) => {
    specs.set(spec.name, spec)
    return {
      name: PREFIX + spec.name,
      description: spec.description,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: spec.properties,
        required: spec.required ?? [],
      },
      output: {
        // The declared contract a code-mode consumer reads; see OUTPUT_SCHEMAS.
        schema: OUTPUT_SCHEMAS[spec.name] ?? { type: 'object' },
        // Forward BOTH arguments: a renderer may need the call arguments to
        // describe its result honestly (e.g. grep's outputMode changes what the
        // counts mean). The default renderer must take the ARGUMENTS slot too,
        // or it receives `args` as its value and renders every real result as
        // "(no rows)" — a lie the model cannot detect.
        render: (args, value) => (spec.render ?? ((_args, current) => renderLines(current)))(args, value),
      },
      async execute(args, exec) {
        const { cwd, scope, readOnly } = await session(exec)
        // ops_batch is not a worker operation; it drives the worker-backed tools
        // in JS and owns its own scheduling, so it receives the session facts once.
        if (typeof spec.execute === 'function') return spec.execute(args, { cwd, scope, readOnly, exec })
        const normalized = spec.normalize(args, cwd)
        const result = await invoke(spec.name, normalized, { cwd, scope, readOnly, exec })
        if (result.ok === false && result.transport) throw new Error(result.message)
        if (result.value?.status === 'error') throw workerFailure(result.value)
        return result.value ?? {}
      },
    }
  }

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
      render: (args, value) => text([
        // The worker omits `path` for a miss; echo the path that was asked
        // about instead of printing "undefined" at the model.
        `path: ${value.path ?? args?.path}`,
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
        expectedRevision: createRevisionParam,
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
        expectedRevision: existingRevisionParam,
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
        expectedRevision: existingRevisionParam,
      },
      required: ['path', 'to', 'expectedRevision'],
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
        expectedRevision: existingRevisionParam,
      },
      required: ['path', 'to', 'expectedRevision'],
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
        expectedRevision: existingRevisionParam,
      },
      required: ['path', 'expectedRevision'],
      normalize: (args, cwd) => compact({ path: absoluteTarget(args.path, cwd), expectedRevision: args.expectedRevision }),
      render: (_args, value) => text(JSON.stringify(value)),
    }),
  ]

  // A batch is not a worker operation: it runs the tools above one after another
  // in this process. Each operation still spawns its own worker, gets its own
  // normalized arguments, and fails or succeeds on its own line — only the model
  // round trips are saved.
  definitions.push(def({
    name: 'batch',
    description: 'Run 1-32 ops_* file operations in one model call, in order. Only operations whose'
      + ' result fits one summary line can be chained (stat, write_file, edit_file, replace, diff, copy,'
      + ' move, remove). Read operations (ops_inspect_local_file, ops_read_files, ops_glob, ops_grep) are'
      + ' rejected because a batch reports one line per operation and returns no operation output; use'
      + ' ops_read_files to read several files in one call. Each operation still runs its own native worker'
      + ' call, and its args are exactly the single tool\'s arguments (ops_write_file, ops_edit_file,'
      + ' ops_copy, ops_move and ops_remove still need expectedRevision; ops_replace never takes one).'
      + ' Every operation is reported individually as ok or FAILED; a failure does not stop the batch'
      + ' unless stopOnError is true. Best value at 3 or more operations that cannot share one call,'
      + ' e.g. stat 4 paths or edit 3 different files.',
    properties: {
      operations: {
        type: 'array',
        description: '1-32 operations, applied in order. op is the tool name without the ops_ prefix; args is exactly that tool\'s argument object.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            op: { type: 'string', enum: BATCHABLE, description: 'Tool name without the ops_ prefix.' },
            args: { type: 'object', description: 'Arguments for that tool, identical to the single-tool call.' },
          },
          required: ['op', 'args'],
        },
      },
      stopOnError: { type: 'boolean', description: 'Stop at the first failed operation; the rest are skipped. Default false.' },
    },
    required: ['operations'],
    async execute(args, facts) {
      const { cwd, scope, readOnly, exec } = facts
      const operations = Array.isArray(args?.operations) ? args.operations : []
      const allowed = BATCHABLE.join(', ')
      if (operations.length === 0 || operations.length > 32) {
        throw new Error(`ops_batch needs 1-32 operations, got ${operations.length}. Allowed operations: ${allowed}.`)
      }
      // Validate the whole list before running anything: a typo at operation 5
      // must not leave operations 1-4 applied and the call thrown away.
      const planned = operations.map((item, index) => {
        const op = typeof item?.op === 'string' ? item.op : ''
        if (!BATCHABLE.includes(op)) {
          throw new Error(`ops_batch has no operation "${op}" at index ${index + 1}. Allowed operations: ${allowed}.`)
        }
        const spec = specs.get(op)
        if (!spec) throw new Error(`ops_batch cannot run "${op}" in this deployment. Allowed operations: ${allowed}.`)
        const itemArgs = item?.args !== null && typeof item?.args === 'object' && !Array.isArray(item.args) ? item.args : {}
        return { op, spec, args: itemArgs }
      })
      const results = []
      let failed = 0
      let stopped = false
      for (let i = 0; i < planned.length; i += 1) {
        const { op, spec, args: itemArgs } = planned[i]
        const normalized = spec.normalize(itemArgs, cwd)
        let result
        try {
          result = await invoke(spec.name, normalized, { cwd, scope, readOnly, exec })
        } catch (error) {
          // A synchronous throw means the worker could not even be started, so
          // nothing can be said about this operation's outcome. Name the
          // operation (the batch may already have applied earlier ones) and keep
          // the failure fatal instead of inventing a per-item verdict.
          throw new Error(`ops_batch failed at operation ${i + 1} (${op}): ${error?.message ?? String(error)}`)
        }
        // A transport fault says nothing about this operation's outcome, so it
        // must never be downgraded to a per-operation failure: throw instead, and
        // let the caller retry from a known state.
        if (result.ok === false && result.transport) {
          throw new Error(`ops_batch failed at operation ${i + 1} (${op}): ${result.message}`)
        }
        if (result.value?.status === 'error') {
          const failure = workerFailure(result.value)
          failed += 1
          results.push({ index: i + 1, op, ok: false, code: failure.code, message: failure.message })
          if (args?.stopOnError === true) {
            // Nothing is reported as stopped when the failure was the last
            // operation: the batch ran everything it was asked to.
            stopped = i + 1 < planned.length
            break
          }
          continue
        }
        results.push({ index: i + 1, op, ok: true, summary: summaryLine(spec, normalized, result.value ?? {}) })
      }
      return { results, total: planned.length, failed, stopped }
    },
    render: (_args, value) => {
      const results = Array.isArray(value?.results) ? value.results : []
      if (results.length === 0) return text('(no operations)')
      const lines = results.map(item => item.ok
        ? `[${item.index}] ${item.op} ok — ${item.summary ?? ''}`
        : `[${item.index}] ${item.op} FAILED — ${item.message ?? item.code ?? 'failed'}`)
      const total = value.total ?? results.length
      if (value.stopped === true) {
        const remaining = Math.max(0, total - results.length)
        lines.push(`[stopped at operation ${results[results.length - 1].index}; ${remaining} remaining operation(s) skipped]`)
      } else {
        const succeeded = results.length - (typeof value.failed === 'number' ? value.failed : 0)
        lines.push(`[${succeeded}/${total} operations succeeded]`)
      }
      return text(lines.join('\n'))
    },
  }))

  return definitions
}