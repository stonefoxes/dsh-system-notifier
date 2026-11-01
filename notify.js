/**
 * dsh-system-notifier — desktop notification backend.
 *
 * One spawn-based sender per platform, all fire-and-forget and failure-tolerant:
 * a notifier that cannot reach a notification daemon logs once and disables
 * itself, never breaking the host. Text is sanitized before it reaches any
 * platform tool: control characters are stripped and lengths capped, because
 * titles and bodies come from session titles and provider error messages.
 */

import { spawn } from 'node:child_process'

/** Longest notification text passed to any platform tool, in code points. */
const MAX_TEXT_LENGTH = 200

/**
 * Make one notification text single-line and bounded.
 * @param text - raw title, subtitle, or body fragment.
 * @returns the sanitized text (never undefined; empty string for absent input).
 */
export function sanitize(text) {
  if (typeof text !== 'string') return ''
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length <= MAX_TEXT_LENGTH ? flat : `${flat.slice(0, MAX_TEXT_LENGTH - 1)}…`
}

/**
 * Escape one AppleScript string literal body (backslash and double quote).
 * @param text - sanitized text.
 * @returns the escaped literal content.
 */
export function appleScriptEscape(text) {
  return text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

/** Escape one XML text node for the Windows toast template. */
export function xmlEscape(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/**
 * One notification request, platform-neutral.
 * @property kind - `permission` | `question` | `complete` | `error`.
 * @property title - sanitized primary line (session label).
 * @property subtitle - sanitized secondary line (event label, e.g. `Permission needed`).
 * @property body - sanitized detail line.
 */

/** Linux: persistence of critical notifications (`notify-send -t 0`) is daemon-dependent. */
const LINUX_CRITICAL_EXPIRY_MS = 0
const LINUX_NORMAL_EXPIRY_MS = 5_000
/** Kill a hung platform tool well before it can pile up. */
const SPAWN_TIMEOUT_MS = 10_000

/** Well-known AUMID of PowerShell; toasts need an AppUserModelID registered by some installed app. */
const WINDOWS_TOAST_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

/**
 * Whether the kind deserves attention-grabbing presentation (critical urgency,
 * sound): everything except a clean completion.
 * @param kind - notification kind.
 * @returns true for permission/question/error.
 */
export function isCriticalKind(kind) {
  return kind !== 'complete'
}

/**
 * Spawn one short-lived platform tool and resolve when it exits or fails.
 * @param log - host logger for one-time failure reporting.
 * @param state - backend state whose `disabled` flag turns the backend off after a hard failure.
 * @param command - executable name.
 * @param args - argument vector (no shell involved).
 * @returns promise resolving to true when the tool exited zero, false otherwise.
 */
function runTool(log, state, command, args) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(command, args, { stdio: 'ignore' })
    } catch {
      // spawn() throws only for a malformed invocation; treat like a startup failure.
      state.disable(command, new Error('spawn threw'))
      resolve(false)
      return
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), SPAWN_TIMEOUT_MS)
    timer.unref?.()
    child.on('error', error => {
      clearTimeout(timer)
      state.disable(command, error)
      resolve(false)
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) log.warn(`dsh-system-notifier: ${command} exited with code ${code}`)
      resolve(code === 0)
    })
  })
}

/**
 * Build the macOS `osascript` notification arguments. The sound plays only for
 * critical kinds even when sound is enabled.
 * @param note - sanitized notification request.
 * @param sound - whether the user enabled notification sound.
 * @returns the argument vector for `osascript`.
 */
export function macOsArgs(note, sound) {
  let script = `display notification "${appleScriptEscape(note.body)}" with title "${appleScriptEscape(note.title)}"`
  if (note.subtitle !== '') script += ` subtitle "${appleScriptEscape(note.subtitle)}"`
  if (sound && isCriticalKind(note.kind)) script += ' sound name "Glass"'
  return ['-e', script]
}

/**
 * Build the Linux `notify-send` arguments.
 * @param note - sanitized notification request.
 * @param appLabel - application name for the notification's origin.
 * @returns the argument vector for `notify-send`.
 */
export function linuxArgs(note, appLabel) {
  const summary = note.subtitle === '' ? note.title : `${appLabel}: ${note.title}`
  const body = note.subtitle === '' ? note.body : `${note.subtitle}\n${note.body}`
  return [
    '--app-name', appLabel,
    '--urgency', isCriticalKind(note.kind) ? 'critical' : 'normal',
    '--expire-time', String(isCriticalKind(note.kind) ? LINUX_CRITICAL_EXPIRY_MS : LINUX_NORMAL_EXPIRY_MS),
    summary,
    body,
  ]
}

/**
 * Build the Windows toast arguments (PowerShell with an UTF-16LE encoded command).
 * @param note - sanitized notification request.
 * @returns the argument vector for `powershell.exe`.
 */
export function windowsArgs(note) {
  const body = note.subtitle === '' ? note.body : `${note.subtitle} — ${note.body}`
  const xml = `<toast><visual><binding template="ToastText02">`
    + `<text id="1">${xmlEscape(note.title)}</text>`
    + `<text id="2">${xmlEscape(body)}</text>`
    + `</binding></visual></toast>`
  const script = ''
    + '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; '
    + '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null; '
    + `$xml = New-Object Windows.Data.Xml.Dom.XmlDocument; `
    + `$xml.LoadXml('${xml.replaceAll("'", "''")}'); `
    + '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml; '
    + `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${WINDOWS_TOAST_AUMID}').Show($toast)`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]
}

/**
 * Create the platform notification sender.
 * @param log - host logger.
 * @param options - `sound` and `appLabel` from the resolved config.
 * @returns a function sending one sanitized notification request (never throws).
 */
export function createNotifier(log, { sound, appLabel }) {
  const platform = process.platform
  const plan = platform === 'darwin'
    ? { command: 'osascript', args: note => macOsArgs(note, sound) }
    : platform === 'win32'
      ? { command: 'powershell.exe', args: windowsArgs }
      : { command: 'notify-send', args: note => linuxArgs(note, appLabel) }
  const state = {
    disabled: false,
    disable(command, error) {
      if (this.disabled) return
      this.disabled = true
      log.warn(`dsh-system-notifier: disabling ${command} notifications: ${String(error?.message ?? error)}`)
    },
  }
  return function notify(note) {
    if (state.disabled) return
    void runTool(log, state, plan.command, plan.args(note))
  }
}
