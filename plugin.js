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
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'hermes-trajectory'
const MAX_ENTRIES = 500

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
    if (current.sessionId !== sessionId || current.profile !== profile) return false
    const historyEntries = rows.map(fromHistoryRow)
    const buffered = liveToolsFor(sessionId, profile)
    $state.set({
      sessionId,
      profile,
      entries: replace
        ? mergeEntries(historyEntries.slice(-MAX_ENTRIES), buffered)
        : mergeEntries(current.entries, [...historyEntries, ...buffered]),
      notice: rows.length === 0 ? 'No records in this session yet.' : '',
      loading: false,
      activity: current.activity ?? 'idle'
    })
    return true
  } catch {
    const current = $state.get()
    if (current.sessionId !== sessionId || current.profile !== profile) return false
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

function sourceBadge(entry) {
  if (entry.kind !== 'tool') return ''
  if (entry.origin === 'live') return 'Captured live'
  return entry.resultAvailable ? 'History · output' : 'History · args only'
}

function entryLabel(entry) {
  if (entry.notice) return 'SYSTEM'
  return entry.kind
}

function EntryRow({ entry }) {
  const [open, setOpen] = useState(false)
  const isTool = entry.kind === 'tool'
  const hasDetail = isTool
    ? Boolean(entry.args) || entry.resultAvailable
    : Boolean(entry.text || entry.commentary || entry.reasoning)
  const time = typeof entry.at === 'number' ? new Date(entry.at).toLocaleTimeString() : ''
  return jsxs('div', {
    className: 'rounded-md border border-(--ui-stroke-secondary) px-2 py-1.5',
    children: [
      jsxs('button', {
        type: 'button',
        className: 'flex w-full items-baseline gap-2 text-left',
        onClick: () => setOpen(value => !value),
        children: [
          jsx('span', { className: 'text-[0.625rem] uppercase tracking-wide text-(--ui-text-quaternary)', children: entryLabel(entry) }),
          jsx('span', { className: 'truncate font-mono text-[0.75rem] text-(--ui-text-primary)', children: isTool ? entry.name || 'tool' : 'message' }),
          sourceBadge(entry)
            ? jsx('span', { className: 'shrink-0 rounded border border-(--ui-stroke-tertiary) px-1 text-[0.5625rem] text-(--ui-text-quaternary)', children: sourceBadge(entry) })
            : null,
          time ? jsx('span', { className: 'ml-auto shrink-0 text-[0.625rem] text-(--ui-text-quaternary)', children: time }) : null,
          isTool && entry.durationS !== null
            ? jsx('span', { className: 'shrink-0 text-[0.625rem] text-(--ui-text-quaternary)', children: `${entry.durationS.toFixed(2)}s` })
            : null
        ]
      }),
      !open && isTool && entry.args
        ? jsx('div', { className: 'mt-0.5 truncate font-mono text-[0.625rem] text-(--ui-text-quaternary)', title: entry.args, children: entry.args })
        : null,
      !open || !hasDetail
        ? jsx('div', { className: 'mt-0.5 break-words text-[0.6875rem] text-(--ui-text-tertiary)', children: statusText(entry) || '—' })
        : null,
      open
        ? jsxs('div', { className: 'mt-1 flex flex-col gap-1 border-t border-(--ui-stroke-secondary) pt-1', children: [
          !isTool && entry.text
            ? jsx('div', { className: 'whitespace-pre-wrap break-words text-[0.6875rem] text-(--ui-text-secondary)', children: entry.text })
            : null,
          !isTool && entry.commentary
            ? jsx('div', { className: 'whitespace-pre-wrap break-words text-[0.6875rem] text-(--ui-text-tertiary)', children: `Commentary: ${entry.commentary}` })
            : null,
          !isTool && entry.reasoning
            ? jsx('div', { className: 'whitespace-pre-wrap break-words text-[0.6875rem] text-(--ui-text-tertiary)', children: `Thinking: ${entry.reasoning}` })
            : null,
          isTool && entry.args
            ? jsx('div', { className: 'font-mono text-[0.625rem] break-all text-(--ui-text-quaternary)', children: entry.args })
            : null,
          isTool
            ? jsx('div', { className: 'whitespace-pre-wrap break-words font-mono text-[0.625rem] text-(--ui-text-secondary)', children: entry.resultAvailable
              ? entry.result || '(empty output)'
              : 'Tool output is not available for this record.' })
            : null
        ] })
        : null
    ]
  })
}

function TrajectoryPanel() {
  const state = useValue($state)
  const sessionId = useValue(host.state.focusedSessionId)
  const profile = useValue(host.state.focusedSessionProfile)

  useEffect(() => {
    void loadTrajectory(sessionId, profile)
  }, [sessionId, profile])

  if (!sessionId) {
    return jsxs('div', { className: 'flex h-full flex-col items-center justify-center gap-2 px-4 text-center', children: [
      jsx('div', { className: 'text-[0.8125rem] text-(--ui-text-secondary)', children: 'No active session' }),
      jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-quaternary)', children: 'Open a chat to see its trajectory.' })
    ] })
  }

  const entries = state.sessionId === sessionId ? state.entries : []
  return jsxs('div', { className: 'flex h-full flex-col gap-2 overflow-auto p-2 text-(--ui-text-primary)', children: [
    jsxs('div', { className: 'flex items-baseline gap-2', children: [
      jsx('div', { className: 'text-sm font-semibold', children: 'Trajectory' }),
      jsx('button', {
        type: 'button',
        className: 'ml-auto text-[0.625rem] text-(--ui-text-quaternary) hover:text-(--ui-text-secondary)',
        onClick: () => { void loadTrajectory(sessionId, profile, { replace: false }) },
        children: state.loading ? 'Refreshing…' : 'Refresh'
      })
    ] }),
    jsx('p', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: 'Tool results are kept in memory and disappear when the plugin reloads or Hermes restarts. History keeps call arguments, not most outputs.' }),
    state.loading && entries.length === 0
      ? jsx('div', { className: 'text-[0.75rem] text-(--ui-text-tertiary)', children: 'Reading session history…' })
      : entries.length === 0
        ? jsx('div', { className: 'text-[0.75rem] text-(--ui-text-tertiary)', children: state.notice || 'No records yet.' })
        : jsx('div', { className: 'flex flex-col gap-1', children: entries.map(entry => jsx(EntryRow, { entry }, entry.key)) }),
    state.activity === 'generating'
      ? jsx('div', { className: 'text-[0.625rem] text-(--ui-accent)', children: 'Assistant is responding…' })
      : null,
    state.notice && entries.length > 0
      ? jsx('div', { className: 'text-[0.625rem] text-(--ui-text-quaternary)', children: state.notice })
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
  }
}
