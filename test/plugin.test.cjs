const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

const pluginPath = path.join(__dirname, '..', 'plugin.js')
const source = fs.readFileSync(pluginPath, 'utf8')

function atom(value) {
  return { value, get() { return this.value }, set(next) { this.value = next } }
}

function load(requests) {
  const calls = []
  const disposers = []
  const created = []
  const listeners = new Map()
  const sandbox = {
    atom,
    host: {
      state: {
        focusedSessionId: atom('runtime-1'),
        focusedSessionProfile: atom('tech'),
        focusedStoredSessionId: atom('stored-1')
      },
      request: async (method, params) => {
        calls.push({ method, params })
        const handler = requests[method]
        if (handler === undefined) throw new Error(`unexpected ${method}`)
        return await handler(params)
      }
    },
    useValue: value => (typeof value?.get === 'function' ? value.get() : value),
    useState: initial => [initial, () => {}],
    useEffect: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
    console,
    Date,
    Map,
    Set,
    Number,
    String,
    Math,
    JSON,
    Array,
    Object,
    Promise,
    Error
  }
  const executable = source
    .replace(/^import .*$/gm, '')
    .replace('export default {', 'globalThis.plugin = {')
  vm.createContext(sandbox)
  vm.runInContext(executable, sandbox, { filename: pluginPath })
  const ctx = {
    register: item => { created.push(item); return () => {} },
    onEvent: (type, listener) => {
      const list = listeners.get(type) ?? []
      list.push(listener)
      listeners.set(type, list)
      const dispose = () => {}
      disposers.push(dispose)
      return dispose
    },
    onDispose: () => () => {}
  }
  sandbox.plugin.register(ctx)
  return { sandbox, calls, created, listeners }
}

const history = {
  count: 4,
  messages: [
    { role: 'user', row_id: 41, timestamp: 1793525291.5, text: 'hello' },
    { role: 'assistant', row_id: 42, timestamp: 1793525298.4, text: 'hi there' },
    { role: 'tool', tool_call_id: 'call_00_A', name: 'terminal', timestamp: 1793525300.1, args: { command: 'pwd' } },
    { role: 'assistant', row_id: 43, timestamp: 1793525305.9, text: 'done' }
  ]
}

;(async () => {
  const historyRows = [...history.messages]
  const { sandbox, calls, created, listeners } = load({
    'session.history': async () => ({ count: historyRows.length, messages: historyRows })
  })

  assert.equal(sandbox.plugin.id, 'hermes-trajectory')
  assert.equal(created.length, 1)

  await sandbox.loadTrajectory('runtime-1', 'tech')
  assert.equal(calls[0].method, 'session.history')
  assert.equal(calls[0].params.session_id, 'runtime-1')

  const state = sandbox.snapshotEntries()
  assert.equal(state.length, 4)
  assert.equal(state[0].kind, 'user')
  assert.equal(state[0].key, 'row:41')
  assert.equal(state[2].kind, 'tool')
  assert.equal(state[2].key, 'tool:call_00_A')
  assert.equal(state[2].result, '')
  assert.match(sandbox.statusTextOf(state[2]), /Historical output not available/)
  assert.equal(sandbox.sourceBadge(state[2]), 'History · args only')
  assert.ok(state[2].args.includes('pwd'), 'historical arguments stay visible while collapsed')
  const reasoningOnly = sandbox.fromHistoryRow({ role: 'assistant', row_id: 77, text: '', reasoning: 'working through the problem' }, 0)
  assert.match(sandbox.statusTextOf(reasoningOnly), /working through the problem/, 'reasoning-only assistant rows need a visible explanation')
  const historicalOutput = sandbox.fromHistoryRow({ role: 'tool', tool_call_id: 'write-1', name: 'write_file', content: 'saved' }, 0)
  assert.equal(sandbox.statusTextOf(historicalOutput), 'saved', 'use historical tool content when Hermes actually supplies it')
  const notice = sandbox.fromHistoryRow({
    role: 'user',
    row_id: 80,
    text: "You've reached the maximum number of tool-calling iterations allowed. Please provide a final response."
  }, 0)
  assert.equal(notice.kind, 'context')
  assert.equal(notice.notice, true)
  assert.equal(sandbox.entryLabel(notice), 'SYSTEM')
  const human = sandbox.fromHistoryRow({ role: 'user', row_id: 81, text: 'normal question' }, 0)
  assert.equal(human.kind, 'user')
  assert.equal(human.notice, false)

  const baseline = sandbox.snapshotEntries().length
  sandbox.applyMessageStart({ session_id: 'runtime-1', profile: 'other-profile' })
  assert.notEqual(sandbox.snapshotActivity(), 'generating', 'another profile must not drive this pane')
  sandbox.applyToolStart({
    session_id: 'runtime-1',
    profile: 'other-profile',
    payload: { tool_id: 'call_other_profile', name: 'terminal', args: { command: 'secret' } }
  })
  sandbox.applyToolComplete({
    session_id: 'runtime-1',
    profile: 'other-profile',
    payload: { tool_id: 'call_other_profile', name: 'terminal', duration_s: 0.1, result: 'hidden' }
  })
  assert.equal(sandbox.snapshotEntries().length, baseline, 'a same-id event from another profile must not enter this pane')

  const failed = await sandbox.loadTrajectory('runtime-1', 'tech', { request: async () => { throw new Error('down') } })
  assert.equal(failed, false)

  await sandbox.loadTrajectory('runtime-1', 'tech')
  const before = sandbox.snapshotEntries()
  assert.equal(before.length, 4)
  sandbox.applyToolStart({
    session_id: 'runtime-1',
    payload: { tool_id: 'call_00_A', name: 'terminal', args: { command: 'ls' } }
  })
  sandbox.applyToolComplete({
    session_id: 'runtime-1',
    payload: { tool_id: 'call_00_A', name: 'terminal', duration_s: 3.9649, result: 'file-a\nfile-b' }
  })
  const merged = sandbox.snapshotEntries()
  assert.equal(merged.length, 4, 'tool start/complete merges into the history row')
  const tool = merged.find(entry => entry.key === 'tool:call_00_A')
  assert.equal(tool.result, 'file-a\nfile-b')
  assert.equal(tool.durationS, 3.9649)
  assert.equal(sandbox.sourceBadge(tool), 'Captured live')

  sandbox.applyToolComplete({
    session_id: 'runtime-1',
    payload: { tool_id: 'call_00_A', name: 'terminal', duration_s: 3.9, result: 'file-a\nfile-b' }
  })
  assert.equal(sandbox.snapshotEntries().length, 4, 'duplicate complete does not add a row')

  sandbox.applyToolComplete({
    session_id: 'runtime-1',
    payload: { tool_id: 'call_00_B', name: 'terminal', duration_s: 0.2, result: 'ok' }
  })
  const withOrphan = sandbox.snapshotEntries()
  assert.equal(withOrphan.length, 5, 'complete without start is still recorded')

  historyRows.push({ role: 'assistant', row_id: 44, timestamp: 1793525400.9, text: 'after tool' })
  const refresh = listeners.get('message.complete')[0]
  refresh({ session_id: 'runtime-1', profile: 'tech' })
  await new Promise(resolve => setTimeout(resolve, 0))
  const refreshed = sandbox.snapshotEntries()
  assert.equal(refreshed.some(entry => entry.key === 'row:44'), true)
  const refreshedTool = refreshed.find(entry => entry.key === 'tool:call_00_A')
  assert.equal(refreshedTool.result, 'file-a\nfile-b', 'history refresh keeps the live tool result')
  assert.equal(sandbox.sourceBadge(refreshedTool), 'Captured live', 'a row that kept a live result stays labelled live after refresh')

  let resolveOld
  const race = load({
    'session.history': params => params.session_id === 'runtime-1'
      ? new Promise(resolve => { resolveOld = resolve })
      : Promise.resolve({ messages: [{ role: 'user', row_id: 50, timestamp: 1793525500, text: 'new session' }] })
  })
  const first = race.sandbox.loadTrajectory('runtime-1', 'tech')
  await new Promise(resolve => setTimeout(resolve, 0))
  const second = race.sandbox.loadTrajectory('runtime-2', 'tech')
  resolveOld({ messages: [{ role: 'user', row_id: 99, timestamp: 1793525400, text: 'stale' }] })
  await Promise.all([first, second])
  assert.equal(race.sandbox.snapshotSessionId(), 'runtime-2')
  assert.equal(race.sandbox.snapshotEntries().some(entry => entry.key === 'row:99'), false, 'stale response must not overwrite the new session')
  assert.equal(race.sandbox.snapshotEntries()[0].key, 'row:50')

  const none = await sandbox.loadTrajectory(null, 'tech')
  assert.equal(none, false)

  // Events can arrive before the pane mounts. They must survive in memory and
  // merge once history is loaded, without leaking across sessions.
  const beforeMount = load({ 'session.history': async () => ({ messages: [] }) })
  beforeMount.sandbox.applyToolStart({
    session_id: 'runtime-1',
    profile: 'tech',
    payload: { tool_id: 'call_before_mount', name: 'terminal', args: { command: 'echo warm' } }
  })
  beforeMount.sandbox.applyToolComplete({
    session_id: 'runtime-1',
    profile: 'tech',
    payload: { tool_id: 'call_before_mount', name: 'terminal', duration_s: 1.25, result: 'warm' }
  })
  beforeMount.sandbox.applyToolStart({
    session_id: 'runtime-2',
    profile: 'tech',
    payload: { tool_id: 'call_other_session', name: 'terminal', args: { command: 'secret' } }
  })
  await beforeMount.sandbox.loadTrajectory('runtime-1', 'tech')
  const warmed = beforeMount.sandbox.snapshotEntries()
  assert.equal(warmed.length, 1)
  assert.equal(warmed[0].key, 'tool:call_before_mount')
  assert.equal(warmed[0].result, 'warm')
  assert.equal(warmed[0].durationS, 1.25)
  assert.equal(beforeMount.sandbox.sourceBadge(warmed[0]), 'Captured live')

  // A tool event can omit profile. Switching away and back must still find the
  // buffered result instead of silently filtering it out.
  const noProfile = load({ 'session.history': async () => ({ messages: [] }) })
  noProfile.sandbox.applyToolStart({
    session_id: 'runtime-1',
    payload: { tool_id: 'call_no_profile', name: 'terminal', args: { command: 'pwd' } }
  })
  noProfile.sandbox.applyToolComplete({
    session_id: 'runtime-1',
    payload: { tool_id: 'call_no_profile', name: 'terminal', duration_s: 0.5, result: '/tmp' }
  })
  await noProfile.sandbox.loadTrajectory('runtime-1', 'tech')
  await noProfile.sandbox.loadTrajectory('runtime-2', 'tech')
  await noProfile.sandbox.loadTrajectory('runtime-1', 'tech')
  const returned = noProfile.sandbox.snapshotEntries()
  assert.equal(returned.length, 1)
  assert.equal(returned[0].result, '/tmp', 'profile-less live result must survive a session switch within one plugin run')
  assert.equal(noProfile.sandbox.sourceBadge(returned[0]), 'Captured live')

  const tree = sandbox.TrajectoryPanel()
  assert.ok(tree)

  const beforeStart = sandbox.snapshotEntries().length
  listeners.get('message.start')[0]({ session_id: 'runtime-1' })
  assert.equal(sandbox.snapshotActivity(), 'generating')
  assert.equal(sandbox.snapshotEntries().length, beforeStart, 'message.start must not invent a user row')

  console.log('PASS trajectory: history mapping, tool merge, duplicate complete, orphan complete, refresh callback, session race')
})().catch(error => { console.error(error); process.exitCode = 1 })
