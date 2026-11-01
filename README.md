# dsh-system-notifier

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin
that spawns **desktop notifications** from the Host process when the model:

1. **asks for permission** (a tool call needs your approval) or **asks you a
   question** (the `ask_user_question` tool);
2. **completes the task** (the agent finished its work and went idle);
3. **hits a blocking error** — a failure that ends the turn, e.g. a rate limit
   or quota-exhausted error whose retry chain gave out, an auth failure, or an
   unexpected crash.

Built for walking away from long tasks: you keep the terminal/GUI out of sight
and get pinged exactly when the harness needs you or the model stopped.

Zero runtime dependencies, plain ES module, no build step. The plugin row is
inserted by a Cordis bundle patch and everything is configurable from the
profile.

## How it listens

| Situation | Harness event | Notification |
| --- | --- | --- |
| Permission request | `approval/request` (waterfall) | `Permission needed` — after `permission.delayMs` of being unanswered |
| Model question | `user-questions/request` (waterfall) | `Model asks a question` — after `question.delayMs` of being unanswered |
| Task completed | `agent/status` → `idle` after a clean `agent/turn-stopping` | `Task completed` — only if the whole run lasted ≥ `complete.minRunMs` |
| Blocking error | `agent/error` | `Blocked by error` — with the failure code (`RATE_LIMIT`, `QUOTA`, `AUTH`, …); identical repeats collapse within `error.dedupMs` |

Behavioral details worth knowing:

- **The permission/question listeners only observe.** They prepend to the
  answerer waterfall, schedule a notification, and delegate with `next()`. If
  the request is answered within the delay (you are at the keyboard, or an
  auto-answerer claims it), the notification cancels itself. Set the delay to
  `0` to notify unconditionally and immediately.
- **Completion is a clean close, not merely "idle".** A notification fires only
  when the last turn closed cleanly (`agent/turn-stopping`), nothing errored on
  the way (`agent/error` sets a suppress flag), and the run lasted at least
  `complete.minRunMs`. User cancellations, rejected (blocked) steps, and
  error-shortened runs do **not** produce "Task completed".
- **A blocking error is the terminal one.** The harness retries transient
  failures (including ordinary 429s) internally; `agent/error` fires only when
  the failure ends the turn. A rate-limit storm therefore yields one
  notification, not one per attempt. User-initiated cancellation never fires it.
- Every notification names the session (its title when known, else a short id),
  so parallel sessions, teammates, and subagents are distinguishable. Use
  `sessionFilter` to narrow scope (e.g. only your main sessions when an agent
  team spawns noisy children).

## Platform support

| Platform | Mechanism | Notes |
| --- | --- | --- |
| Linux (incl. WSL with a notification bridge) | `notify-send` (libnotify) | Urgent kinds use `--urgency critical`; install `libnotify-tools`/`dunst` if absent. Needs `DBUS_SESSION_BUS_ADDRESS` in the Host environment. |
| macOS | `osascript display notification` | Sound for urgent kinds when `sound: true`. |
| Windows | PowerShell toast via `powershell.exe -EncodedCommand` | Best-effort; toast delivery depends on Focus Assist / notification settings. |

If the platform tool is missing or cannot start, the backend logs one warning
and disables itself; the harness keeps running unaffected.

## Installation

### From a local checkout

```sh
dsh plugin --profile <profile> add /absolute/path/to/dsh-system-notifier
```

### From the git repo (after pushing it)

```sh
dsh plugin --profile <profile> add github:<owner>/dsh-system-notifier
# or pin a ref:
dsh plugin --profile <profile> add github:<owner>/dsh-system-notifier#v0.1.0
```

Both forms install the package into the profile and register it in the
profile's bundle list (`dsh.profile.bundles`) automatically, because the
package declares `dsh.bundle.patch`. Restart the profile (or relaunch the
Desktop app) if the running instance does not hot-apply the new layer.

### Inside a running Harness session (agent-driven)

Ask the agent to install the bundle, quoting this directory:

> Install the bundle at `/absolute/path/to/dsh-system-notifier` with
> `plugin_manager` `install_bundle`.

To remove: `dsh plugin --profile <profile> remove dsh-system-notifier`.

## Configuration

All fields are optional; defaults shown. Override them on the plugin row —
either in the profile's `cordis.patch.yml` layer or via the GUI's plugin
manager. Misconfiguration fails loudly at load.

```yaml
# profile cordis.patch.yml
- override:
    - id: system-notifier
      config:
        permission: { enabled: true, delayMs: 2500 }
        question:   { enabled: true, delayMs: 2500 }
        complete:   { enabled: true, minRunMs: 3000 }
        error:      { enabled: true, dedupMs: 30000 }
        sound: true                     # macOS only
        appLabel: DeepSeek Harness      # origin name shown by the OS
        sessionFilter: []               # e.g. ['refactor*', '*a1b2c3d4*']
```

| Field | Default | Meaning |
| --- | --- | --- |
| `permission.enabled` | `true` | Notify on pending permission requests. |
| `permission.delayMs` | `2500` | Pending threshold before notifying; `0` = immediately. Answered requests never notify. |
| `question.enabled` | `true` | Notify on pending model questions (`ask_user_question`). |
| `question.delayMs` | `2500` | Same delayed-pending semantics as permission. |
| `complete.enabled` | `true` | Notify when a run completes cleanly. |
| `complete.minRunMs` | `3000` | Suppress notifications for shorter runs (active chatting stays quiet). |
| `error.enabled` | `true` | Notify on blocking errors. |
| `error.dedupMs` | `30000` | Collapse an identical `code+message` repeated within this window; `0` = never collapse. |
| `sound` | `true` | Play the macOS notification sound for urgent kinds. |
| `appLabel` | `DeepSeek Harness` | Application name in the notification origin. |
| `sessionFilter` | `[]` | `*`-wildcard patterns matched against session title or raw session id. Empty = all agents (including teammates/subagents). |

## Troubleshooting

- **Nothing appears (Linux):** check `command -v notify-send`, then run
  `notify-send test ok` from the same environment the Host runs in. Headless
  hosts (systemd units, containers) usually lack `DBUS_SESSION_BUS_ADDRESS`.
  The Host log contains one `disabling notify-send notifications` warning when
  the backend gave up.
- **Nothing appears (macOS):** check Focus / notification permissions for
  *Script Editor* (osascript's host) in System Settings → Notifications.
- **Nothing appears (Windows):** toasts can be suppressed by Focus Assist;
  verify with any other app's notification first.
- **Too noisy with agent teams:** set `sessionFilter` to your main sessions'
  titles/ids, or raise `complete.minRunMs`.

## Development

```sh
git clone https://github.com/<owner>/dsh-system-notifier
cd dsh-system-notifier
node --test tests/    # pure-logic tests: config validation, escaping, args
```

The plugin is a single Cordis function plugin (`index.js`) plus two helper
modules (`config.js`, `notify.js`); there is no build step. Reload the profile
(or reinstall the bundle) after edits when installed via a `link:` path.

## License

MIT — see [LICENSE](LICENSE).
