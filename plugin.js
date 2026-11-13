/**
 * hermes-trajectory — 一场会话的轨迹：用户消息、助手回复、工具调用。
 *
 * 数据来源（全部为 Hermes Desktop 公开 SDK）：
 * - session.history：历史展示记录（用户/助手正文，工具调用参数）
 * - gateway 事件：实时消息与工具调用/结果
 *
 * 只读：不写盘、不联网、不直接访问数据库。
 */
import { atom, host, useValue } from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'hermes-trajectory'
const MAX_ENTRIES = 100

// Hermes inserts a few synthetic `role: "user"` turns to steer the model.
// They are not human input, but the history projection has no source field for
// them; these stable openings are the recognizers Hermes itself documents.
const SYSTEM_NOTICE_PREFIXES = [
  "You've reached the maximum number of tool-calling iterations allowed.",
  'Continue from the compressed conversation context above.',
  '[System note: Your previous turn was interrupted mid-run',
  '[IMPORTANT: Background process '
]

function isSystemNotice(text) {
  const value = String(text ?? '').trimStart()
  return SYSTEM_NOTICE_PREFIXES.some(prefix => value.startsWith(prefix))
}

const $state = atom({ sessionId: null, profile: null, entries: [], notice: '', loading: false, activity: 'idle' })
// Captured before the pane mounts, or while another pane is active. Memory only.
const $liveTools = atom({})
const MAX_BUFFERED_TOOLS = 200
let historyRequestGeneration = 0

function clip(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Cap without flattening: tool results keep their line structure for the detail view. */
function truncate(value, max) {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 历史行 → 统一条目。工具行没有 row_id 与结果，如实标注。 */
function fromHistoryRow(row, index) {
  const role = typeof row?.role === 'string' ? row.role : 'unknown'
  const isTool = role === 'tool'
  const historicalResult = isTool && row?.content !== undefined && row.content !== null
  const text = isTool ? '' : typeof row?.text === 'string' ? row.text : typeof row?.display_content === 'string' ? row.display_content : ''
  const notice = !isTool && isSystemNotice(text)
  const reasoning = [row?.reasoning, row?.reasoning_content, row?.display_reasoning]
    .find(value => typeof value === 'string' && value.trim())
  return {
    key: isTool
      ? `tool:${typeof row.tool_call_id === 'string' ? row.tool_call_id : `history-${index}`}`
      : `row:${Number.isInteger(row?.row_id) ? row.row_id : `history-${index}`}`,
    kind: isTool ? 'tool' : notice ? 'context' : role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'context',
    notice,
    text,
    reasoning: typeof reasoning === 'string' ? truncate(reasoning, 20000) : '',
    commentary: typeof row?.display_commentary === 'string' ? truncate(row.display_commentary, 20000) : '',
    name: isTool && typeof row?.name === 'string' ? row.name : '',
    args: isTool ? clip(typeof row?.args === 'object' ? JSON.stringify(row.args) : row?.args, 300) : '',
    result: historicalResult ? truncate(typeof row.content === 'string' ? row.content : JSON.stringify(row.content), 2000) : '',
    resultAvailable: Boolean(historicalResult),
    failure: false,
    durationS: null,
    at: typeof row?.timestamp === 'number' ? row.timestamp * 1000 : null,
    origin: 'history'
  }
}

function statusText(entry) {
  if (entry.kind === 'tool') {
    if (entry.status === 'running') return 'Running…'
    if (entry.resultAvailable) return entry.result ? clip(entry.result, 300) : '(empty output)'
    return 'Historical output not available'
  }
  if (entry.text) return clip(entry.text, 300)
  if (entry.commentary) return `Commentary: ${clip(entry.commentary, 280)}`
  if (entry.reasoning) return `Thinking: ${clip(entry.reasoning, 280)}`
  return entry.kind === 'assistant' ? 'Assistant step without text' : ''
}

function mergeEntries(existing, incoming) {
  const byKey = new Map(existing.map(entry => [entry.key, entry]))
  for (const entry of incoming) {
    const previous = byKey.get(entry.key)
    if (previous !== undefined && previous.origin === 'live' && entry.origin === 'history') {
      // History is authoritative for text and ordering, but it never carries a
      // tool result or duration. Keep what this run observed.
      byKey.set(entry.key, {
        ...entry,
        args: previous.args || entry.args,
        result: previous.resultAvailable ? previous.result : entry.result,
        resultAvailable: previous.resultAvailable || entry.resultAvailable,
        failure: previous.failure === true || entry.failure === true,
        durationS: previous.durationS ?? entry.durationS,
        status: previous.status ?? entry.status,
        origin: 'live'
      })
      continue
    }
    byKey.set(entry.key, entry)
  }
  return [...byKey.values()]
    .sort((left, right) => (left.at ?? 0) - (right.at ?? 0))
    .slice(-MAX_ENTRIES)
}

function liveKey(sessionId, toolId) {
  return `${sessionId}\u0000${toolId}`
}

function rememberLiveTool(sessionId, profile, entry) {
  if (!sessionId || !entry?.key) return
  const store = { ...$liveTools.get() }
  store[liveKey(sessionId, entry.key)] = { sessionId, profile, entry }
  const entries = Object.entries(store)
  if (entries.length > MAX_BUFFERED_TOOLS) {
    entries
      .sort((left, right) => (left[1].entry.at ?? 0) - (right[1].entry.at ?? 0))
      .slice(0, entries.length - MAX_BUFFERED_TOOLS)
      .forEach(([key]) => { delete store[key] })
  }
  $liveTools.set(store)
}

function liveToolsFor(sessionId, profile) {
  return Object.values($liveTools.get())
    .filter(item => item.sessionId === sessionId && (profile === undefined || item.profile == null || item.profile === profile))
    .map(item => item.entry)
    .sort((left, right) => (left.at ?? 0) - (right.at ?? 0))
}

async function loadTrajectory(sessionId, profile, options = {}) {
  const request = options.request ?? host.request
  const replace = options.replace === true
  if (!sessionId) return false
  const generation = ++historyRequestGeneration
  const previous = $state.get()
  const sameSession = previous.sessionId === sessionId && previous.profile === profile
  $state.set({
    sessionId,
    profile,
    entries: replace || !sameSession ? [] : previous.entries,
    notice: '',
    loading: true,
    activity: previous.activity ?? 'idle'
  })
  try {
    const result = await request('session.history', { session_id: sessionId, profile })
    const rows = Array.isArray(result?.messages) ? result.messages : []
    const current = $state.get()
    if (generation !== historyRequestGeneration || current.sessionId !== sessionId || current.profile !== profile) return false
    const sliceStart = Math.max(0, rows.length - MAX_ENTRIES)
    const historyEntries = rows.slice(sliceStart).map((row, offset) => fromHistoryRow(row, sliceStart + offset))
    const buffered = liveToolsFor(sessionId, profile)
    // A successful history read is the authoritative set. Merge only buffered
    // live tool detail into it; never carry forward rows the history removed.
    $state.set({
      sessionId,
      profile,
      entries: mergeEntries(historyEntries, buffered),
      notice: rows.length === 0 ? 'No records in this session yet.' : '',
      loading: false,
      activity: current.activity ?? 'idle'
    })
    return true
  } catch {
    const current = $state.get()
    if (generation !== historyRequestGeneration || current.sessionId !== sessionId || current.profile !== profile) return false
    $state.set({
      sessionId,
      profile,
      entries: mergeEntries(current.entries, liveToolsFor(sessionId, profile)),
      notice: current.entries.length === 0
        ? 'Could not read session history.'
        : 'History refresh failed; showing what this run observed.',
      loading: false,
      activity: current.activity ?? 'idle'
    })
    return false
  }
}

function matchesSession(sessionId, profile) {
  const state = $state.get()
  if (!sessionId || state.sessionId !== sessionId) return false
  if (profile !== undefined && state.profile !== undefined && profile !== state.profile) return false
  return true
}

function applyMessageStart(event) {
  const sessionId = event?.session_id
  if (!matchesSession(sessionId, event?.profile)) return
  $state.set({ ...$state.get(), activity: 'generating' })
}

function applyMessageComplete(event) {
  const sessionId = event?.session_id
  if (!matchesSession(sessionId, event?.profile)) return
  $state.set({ ...$state.get(), activity: 'idle' })
}

function applyToolStart(event) {
  const payload = event?.payload
  const sessionId = event?.session_id
  if (!payload?.tool_id || !sessionId) return
  const profile = event?.profile ?? $state.get().profile
  const sameSession = matchesSession(sessionId, profile)
  const key = `tool:${payload.tool_id}`
  const current = $state.get()
  const known = (sameSession ? current.entries.find(entry => entry.key === key) : undefined)
    ?? liveToolsFor(sessionId, profile).find(entry => entry.key === key)
  if (known) return
  const entry = {
    key,
    kind: 'tool',
    text: '',
    name: typeof payload.name === 'string' ? payload.name : '',
    args: clip(typeof payload.args === 'object' ? JSON.stringify(payload.args) : payload.args_text, 300),
    result: '',
    resultAvailable: false,
    durationS: null,
    at: Date.now(),
    origin: 'live',
    status: 'running'
  }
  rememberLiveTool(sessionId, profile, entry)
  if (!sameSession) return
  $state.set({ ...current, entries: mergeEntries(current.entries, [entry]) })
}

function applyToolComplete(event) {
  const payload = event?.payload
  const sessionId = event?.session_id
  if (!payload?.tool_id || !sessionId) return
  const profile = event?.profile ?? $state.get().profile
  const sameSession = matchesSession(sessionId, profile)
  const key = `tool:${payload.tool_id}`
  const current = $state.get()
  const previous = (sameSession ? current.entries.find(entry => entry.key === key) : undefined)
    ?? liveToolsFor(sessionId, profile).find(entry => entry.key === key)
  const result = typeof payload.result === 'string'
    ? truncate(payload.result, 2000)
    : payload.result === undefined || payload.result === null ? '' : truncate(JSON.stringify(payload.result), 2000)
  const entry = {
    key,
    kind: 'tool',
    text: '',
    name: typeof payload.name === 'string' ? payload.name : previous?.name ?? '',
    args: previous?.args ?? clip(typeof payload.args === 'object' ? JSON.stringify(payload.args) : '', 300),
    result,
    resultAvailable: Object.prototype.hasOwnProperty.call(payload, 'result'),
    failure: toolFailure(payload.result),
    durationS: typeof payload.duration_s === 'number' && Number.isFinite(payload.duration_s)
      ? payload.duration_s
      : null,
    at: previous?.at ?? Date.now(),
    origin: 'live',
    status: 'done'
  }
  rememberLiveTool(sessionId, profile, entry)
  if (!sameSession) return
  $state.set({ ...current, entries: mergeEntries(current.entries, [entry]) })
}

function snapshotEntries() {
  return $state.get().entries
}

function snapshotSessionId() {
  return $state.get().sessionId
}

function snapshotActivity() {
  return $state.get().activity
}

function statusTextOf(entry) {
  return statusText(entry)
}

/** Only structured evidence counts as a failed tool; result text is arbitrary. */
function toolFailure(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false
  if (result.success === false) return true
  return typeof result.error === 'string' && result.error.trim().length > 0
}

function isNearBottom(scrollTop, scrollHeight, clientHeight, threshold = 48) {
  return scrollHeight - (scrollTop + clientHeight) <= threshold
}

/** A closed row shows its summary; an open row already shows the full detail. */
function shouldShowPreview(open, preview) {
  return !open && Boolean(preview)
}

/** Seconds since the nearest earlier timed event; null when either side is untimed. */
function gapBefore(entries, index) {
  const current = entries[index]
  if (typeof current?.at !== 'number') return null
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (typeof entries[cursor]?.at === 'number') {
      return Math.max(0, (current.at - entries[cursor].at) / 1000)
    }
  }
  return null
}

function sourceBadge(entry) {
  if (entry.kind !== 'tool') return ''
  if (entry.origin === 'live') return 'live'
  return entry.resultAvailable ? 'output' : 'args only'
}

function sourceTitle(entry) {
  if (entry.kind !== 'tool') return ''
  if (entry.origin === 'live') return 'Result captured while the plugin was running'
  return entry.resultAvailable ? 'Output came from the session history' : 'Arguments came from the session history; output was not stored'
}

function entryLabel(entry) {
  if (entry.notice) return 'system'
  return entry.kind
}

const PREVIEW_LIMIT = 140

/** The one line (or two) a closed row shows for its content. */
function previewOf(entry) {
  if (entry.kind === 'tool') return entry.args || statusText(entry) || ''
  if (entry.text) return entry.text
  if (entry.commentary) return `Commentary: ${entry.commentary}`
  if (entry.reasoning) return `Thinking: ${entry.reasoning}`
  return ''
}

/** Everything the open row reveals, in reading order. */
function detailSectionsOf(entry) {
  if (entry.kind === 'tool') {
    const sections = []
    if (entry.args) sections.push({ label: 'Input', text: entry.args, mono: true })
    sections.push({
      label: 'Output',
      text: entry.resultAvailable ? entry.result || '(empty output)' : 'Tool output is not available for this record.',
      mono: true
    })
    return sections
  }
  const sections = []
  if (entry.text) {
    const label = entry.notice ? 'Context' : entry.kind === 'assistant' ? 'Response' : null
    sections.push({ label, text: entry.text, mono: false })
  }
  if (entry.commentary) sections.push({ label: 'Commentary', text: entry.commentary, mono: false })
  if (entry.reasoning) sections.push({ label: 'Thinking', text: entry.reasoning, mono: false })
  return sections
}

/** Whether a row can open, and the label that affordance announces. */
function disclosureOf(entry) {
  const sections = detailSectionsOf(entry)
  if (sections.length === 0) return { expandable: false, label: '' }
  const preview = previewOf(entry)
  const extra = entry.kind !== 'tool' && Boolean(entry.reasoning || entry.commentary)
  const long = preview.length > PREVIEW_LIMIT
  return entry.kind === 'tool' || extra || long
    ? { expandable: true, label: 'Expand' }
    : { expandable: false, label: '' }
}

function clampStyle(lines) {
  return {
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: String(lines),
    overflow: 'hidden'
  }
}

function roleToneOf(entry) {
  if (entry.notice) return 'var(--ui-text-tertiary)'
  if (entry.kind === 'user') return 'var(--ui-accent)'
  if (entry.kind === 'assistant') return 'var(--ui-blue)'
  if (entry.kind === 'tool') return 'var(--ui-orange)'
  return 'var(--ui-text-tertiary)'
}

function EntryRow({ entry, gapS }) {
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const isTool = entry.kind === 'tool'
  const disclosure = disclosureOf(entry)
  const preview = previewOf(entry)
  const sections = detailSectionsOf(entry)
  const source = sourceBadge(entry)
  const time = typeof entry.at === 'number' ? new Date(entry.at).toLocaleTimeString() : ''
  const duration = isTool && entry.durationS !== null ? `${entry.durationS.toFixed(2)}s` : ''
  const accent = roleToneOf(entry)
  const reduceMotion = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const gridStyle = { display: 'grid', gridTemplateColumns: '52px minmax(0,1fr)' }

  useEffect(() => {
    if (open) {
      setMounted(true)
      if (typeof requestAnimationFrame !== 'function') {
        setExpanded(true)
        return
      }
      const frame = requestAnimationFrame(() => setExpanded(true))
      return () => cancelAnimationFrame(frame)
    }
    setExpanded(false)
    if (!disclosure.expandable || !mounted) return
    const timer = setTimeout(() => setMounted(false), 180)
    return () => clearTimeout(timer)
  }, [open, disclosure.expandable])

  const content = [
    jsxs('div', { className: 'flex items-center gap-2', children: [
      jsx('span', {
        className: 'inline-flex w-16 shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.6875rem] text-(--ui-text-primary)',
        style: { backgroundColor: `color-mix(in srgb, ${accent} 14%, transparent)` },
        children: [
          jsx('span', { 'aria-hidden': 'true', style: { width: '5px', height: '5px', borderRadius: '999px', flexShrink: 0, backgroundColor: accent } }),
          jsx('span', { className: 'truncate', children: entryLabel(entry) })
        ]
      }),
      jsx('span', { className: 'min-w-0 flex-1 truncate font-mono text-[0.75rem] text-(--ui-text-primary)', children: isTool ? entry.name || 'tool' : 'message' }),
      entry.failure
        ? jsx('span', { className: 'shrink-0 rounded-full px-1.5 py-0.5 text-[0.625rem]', style: { backgroundColor: 'color-mix(in srgb, var(--ui-red) 14%, transparent)', color: 'var(--ui-red)' }, children: 'failed' })
        : null,
      source
        ? jsx('span', {
            title: sourceTitle(entry),
            className: 'shrink-0 rounded-full px-1.5 py-0.5 text-[0.625rem] text-(--ui-text-tertiary)',
            style: { backgroundColor: 'color-mix(in srgb, var(--ui-text-tertiary) 12%, transparent)' },
            children: source
          })
        : null,
      duration
        ? jsx('span', { title: 'Tool duration', className: 'shrink-0 text-[0.625rem] tabular-nums text-(--ui-text-tertiary)', children: duration })
        : null,
      gapS !== null
        ? jsx('span', { title: 'Time since the previous event', className: 'shrink-0 text-[0.625rem] tabular-nums text-(--ui-text-quaternary)', children: `+${gapS.toFixed(1)}s` })
        : null,
      disclosure.expandable
        ? jsx('span', { className: 'shrink-0 text-[0.625rem] text-(--ui-text-quaternary)', children: open ? '▾' : '▸' })
        : null
    ] }),
    shouldShowPreview(open, preview)
      ? jsx('div', { className: 'mt-1 flex items-baseline pl-[4.5rem]', children: jsx('div', {
          className: isTool
            ? 'min-w-0 truncate font-mono text-[0.6875rem] text-(--ui-text-tertiary)'
            : 'min-w-0 text-[0.75rem] text-(--ui-text-secondary)',
          style: isTool ? undefined : clampStyle(2),
          title: preview,
          children: preview
        }) })
      : null
  ]

  const body = jsxs('div', { style: gridStyle, className: 'w-full text-left', children: [
    jsx('span', { className: 'py-1.5 pr-2 text-right font-mono text-[0.625rem] tabular-nums text-(--ui-text-tertiary)', children: time }),
    jsx('span', { className: 'min-w-0 py-1.5 pl-1', children: content })
  ] })

  const startsTurn = entry.kind === 'user' && !entry.notice
  return jsxs('div', {
    className: 'mx-1 mb-1.5 rounded-xl border bg-(--ui-surface-background) px-2 py-1',
    style: {
      marginTop: startsTurn ? '10px' : undefined,
      borderColor: entry.failure
        ? 'color-mix(in srgb, var(--ui-red) 45%, var(--ui-stroke-secondary))'
        : 'var(--ui-stroke-secondary)'
    },
    children: [
      disclosure.expandable
        ? jsx('button', {
            type: 'button',
            'aria-expanded': open,
            'aria-label': `${open ? 'Collapse' : 'Expand'} ${entryLabel(entry)}: ${preview.slice(0, 80)}`,
            className: 'block w-full rounded-lg hover:bg-(--ui-bg-tertiary) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--ui-accent)',
            onClick: () => setOpen(value => !value),
            children: body
          })
        : jsx('div', { className: 'block w-full', children: body }),
      disclosure.expandable && sections.length > 0 && (open || mounted)
        ? jsx('div', {
            style: {
              display: 'grid',
              gridTemplateRows: expanded ? '1fr' : '0fr',
              transition: reduceMotion ? 'none' : 'grid-template-rows 180ms ease'
            },
            children: jsx('div', { style: { overflow: 'hidden', minHeight: 0 }, children: jsxs('div', {
              className: 'mb-1 rounded-[10px] px-2 py-1.5 ml-[4.5rem]',
              style: {
                backgroundColor: 'color-mix(in srgb, var(--ui-text-tertiary) 8%, transparent)',
                border: '1px solid color-mix(in srgb, var(--ui-text-tertiary) 10%, transparent)'
              },
              children: sections.map((section, index) => jsxs('div', { className: 'flex flex-col gap-0.5', children: [
              section.label
                ? jsx('div', { className: 'text-[0.625rem] text-(--ui-text-tertiary)', children: section.label })
                : null,
              jsx('div', {
                className: section.mono
                  ? 'whitespace-pre-wrap break-words font-mono text-[0.6875rem] text-(--ui-text-secondary)'
                  : 'whitespace-pre-wrap break-words text-[0.75rem] text-(--ui-text-secondary)',
                children: section.text
              })
            ] }, index)) }) })
          })
        : null
    ]
  })
}

function TrajectoryPanel() {
  const state = useValue($state)
  const sessionId = useValue(host.state.focusedSessionId)
  const profile = useValue(host.state.focusedSessionProfile)
  const scrollRef = useRef(null)
  const stickToBottom = useRef(true)

  useEffect(() => {
    stickToBottom.current = true
    void loadTrajectory(sessionId, profile)
  }, [sessionId, profile])

  const entries = state.sessionId === sessionId ? state.entries : []
  useEffect(() => {
    const element = scrollRef.current
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight
  }, [entries, sessionId, state.loading])

  if (!sessionId) {
    return jsxs('div', { className: 'flex h-full flex-col items-center justify-center gap-2 bg-(--ui-surface-background) px-4 text-center', children: [
      jsx('div', { className: 'text-[0.8125rem] text-(--ui-text-secondary)', children: 'No active session' }),
      jsx('div', { className: 'text-[0.75rem] text-(--ui-text-tertiary)', children: 'Open a chat to see its trajectory.' })
    ] })
  }

  const toolCount = entries.filter(entry => entry.kind === 'tool').length
  return jsxs('div', {
    ref: scrollRef,
    className: 'flex h-full flex-col overflow-auto bg-(--ui-surface-background) text-(--ui-text-primary)',
    onScroll: event => {
      const element = event.currentTarget
      stickToBottom.current = isNearBottom(element.scrollTop, element.scrollHeight, element.clientHeight)
    },
    children: [
    jsxs('div', { className: 'sticky top-0 z-10 shrink-0 bg-(--ui-surface-background)', children: [
      jsxs('div', { className: 'flex items-center gap-2 border-b border-(--ui-stroke-secondary) px-2 py-1.5', children: [
        jsx('div', { className: 'text-sm font-semibold', children: 'Trajectory' }),
        jsxs('div', { className: 'flex items-baseline gap-2 text-[0.6875rem] tabular-nums text-(--ui-text-tertiary)', children: [
          jsx('span', { children: `${entries.length} events` }),
          jsx('span', { className: 'border-l border-(--ui-stroke-secondary) pl-2', children: `${toolCount} tools` })
        ] }),
        jsx('button', {
          type: 'button',
          disabled: state.loading,
          className: 'ml-auto min-h-7 rounded-md border border-(--ui-stroke-secondary) px-2 text-[0.75rem] text-(--ui-text-secondary) enabled:hover:bg-(--ui-bg-tertiary) disabled:opacity-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--ui-accent)',
          onClick: () => { void loadTrajectory(sessionId, profile, { replace: false }) },
          children: state.loading ? 'Refreshing…' : 'Refresh'
        })
      ] })
    ] }),
    state.loading && entries.length === 0
      ? jsx('div', { className: 'px-2 py-2 text-[0.75rem] text-(--ui-text-tertiary)', children: 'Reading session history…' })
      : entries.length === 0
        ? state.notice
          ? jsx('div', { className: 'px-2 py-2 text-[0.75rem] text-(--ui-text-tertiary)', children: state.notice })
          : jsxs('div', { className: 'flex flex-col gap-1 px-2 py-2', children: [
              jsx('div', { className: 'text-[0.75rem] text-(--ui-text-secondary)', children: 'No records yet.' }),
              jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: 'Send a message to start the ledger.' })
            ] })
        : jsx('div', { className: 'px-1 pt-1', children: entries.map((entry, index) => jsx(EntryRow, { entry, gapS: gapBefore(entries, index) }, entry.key)) }),
    state.activity === 'generating'
      ? jsx('div', { className: 'px-2 py-1 text-[0.6875rem] text-(--ui-accent)', children: 'Assistant is responding…' })
      : null,
    state.notice && entries.length > 0
      ? jsx('div', { className: 'px-2 py-1 text-[0.6875rem] text-(--ui-text-quaternary)', children: state.notice })
      : null,
    entries.length > 0
      ? jsx('div', { className: 'border-t border-(--ui-stroke-secondary) px-2 py-2 text-[0.6875rem] text-(--ui-text-tertiary)', children: 'Tool output is memory-only; history keeps arguments, not outputs.' })
      : null
  ] })
}

export default {
  id: ID,
  name: 'Trajectory',
  defaultEnabled: true,
  register(ctx) {
    ctx.onEvent('message.start', applyMessageStart)
    ctx.onEvent('tool.start', applyToolStart)
    ctx.onEvent('tool.complete', applyToolComplete)
    ctx.onEvent('message.complete', event => {
      const sessionId = event?.session_id
      const profile = event?.profile
      if (!sessionId || !matchesSession(sessionId, profile)) return
      applyMessageComplete(event)
      void loadTrajectory(sessionId, profile ?? $state.get().profile, { replace: false })
    })
    ctx.register({
      id: 'panel',
      area: 'panes',
      title: 'Trajectory',
      data: { placement: 'right', width: '380px' },
      render: () => jsx(TrajectoryPanel, {})
    })

    // One-time placement repair: a pane that was once closed keeps a dismissal
    // record across restarts, so this plugin would load yet never appear. Clear
    // it once and remember, so a later deliberate close still survives.
    try {
      if (ctx.storage?.get?.('placementRepaired.v1') !== true) {
        if (typeof host.undismissPane === 'function') host.undismissPane(`${ID}:panel`)
        ctx.storage?.set?.('placementRepaired.v1', true)
      }
    } catch {
      // Older desktops without storage/undismissPane: leave the layout alone.
    }
  }
}
