# hermes-trajectory

A read-only Hermes Desktop plugin that shows one chat as a chronological ledger of user messages, assistant replies, and tool calls.

## What it shows

- **History** — user and assistant text from `session.history`, including the tool calls recorded there.
- **Live detail** — while the plugin is running, `tool.start` / `tool.complete` supply tool arguments, result text, and duration.
- **Honest gaps** — a tool row from history has no result or duration in Hermes's display history. It says so instead of showing an empty or fabricated output.

## Data and privacy

| Source | Use |
|---|---|
| `session.history` | messages and historical tool-call metadata |
| `tool.start` / `tool.complete` | live tool arguments, results, durations |
| `message.start` / `message.complete` | turn activity and a history refresh trigger |

It does **not** write files, make network requests, read a database, or store credentials. Entries stay in memory, capped at 500 per session.

## Known limits

- Historical tool output cannot be recovered by this plugin. Only calls observed while it runs carry a result.
- Tool results are capped in memory (2,000 characters) and are lost when the plugin reloads.
- The plugin shows content after it is available in `session.history`; it does not treat an empty `message.start` payload as the user's prompt.
- There is no cross-device or complete durable-event replay.

## Tests

The plugin has no build step. The mock test loads `plugin.js` in a Node VM with a fake Hermes SDK:

```sh
node test/plugin.test.cjs
```

## Install (local, before catalog publication)

Copy `plugin.js` to:

```
<HERMES_HOME>/desktop-plugins/hermes-trajectory/plugin.js
```

The directory name must match the plugin id. Then enable **Trajectory** under Capabilities → Plugins. There is no build step.

## License

MIT. See [LICENSE](LICENSE).
