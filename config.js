/**
 * dsh-system-notifier — configuration defaults, validation, and matching.
 *
 * The plugin declares no schemastery Config on purpose: it is a zero-dependency
 * bundle, so the row's `config` object is validated here at plugin load.
 * Misconfiguration fails loud (throws) — never a silent fall-back.
 */

/** Every tunable with its default; all fields are overridable from the loader row. */
export const DEFAULTS = Object.freeze({
  /** Permission requests (`approval/request`): notify after the request has stayed unanswered this long, so instant auto-answerers stay silent. 0 = immediately. */
  permission: { enabled: true, delayMs: 2_500 },
  /** Model questions to the user (`user-questions/request`), same delayed-pending semantics as permission. */
  question: { enabled: true, delayMs: 2_500 },
  /** Clean run completion (`agent/status` → idle after a clean turn close): notify when the whole run lasted at least this long. 0 = always. */
  complete: { enabled: true, minRunMs: 3_000 },
  /** Blocking errors (`agent/error`): collapse an identical code+message repeated within this window. 0 = never collapse. */
  error: { enabled: true, dedupMs: 30_000 },
  /** Play the system sound on macOS for permission/question/error notifications. */
  sound: true,
  /** Application name shown as the notification's origin. */
  appLabel: 'DeepSeek Harness',
  /** Wildcard patterns (`*`) matched against the session title and the raw session id. Empty = all sessions (including teammates and subagents). */
  sessionFilter: [],
})

const SECTION_SHAPES = Object.freeze({
  permission: ['enabled', 'delayMs'],
  question: ['enabled', 'delayMs'],
  complete: ['enabled', 'minRunMs'],
  error: ['enabled', 'dedupMs'],
})

/**
 * Require a boolean field.
 * @param value - the value as supplied on the loader row.
 * @param where - field location for the error message.
 * @returns the same value.
 */
function requireBoolean(value, where) {
  if (typeof value !== 'boolean') throw new Error(`dsh-system-notifier: ${where} must be a boolean`)
  return value
}

/**
 * Require a non-negative safe integer of milliseconds.
 * @param value - the value as supplied on the loader row.
 * @param where - field location for the error message.
 * @returns the same value.
 */
function requireMs(value, where) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`dsh-system-notifier: ${where} must be an integer >= 0 (milliseconds)`)
  }
  return value
}

/**
 * Resolve the row config against {@link DEFAULTS}, validating every supplied field.
 * Unknown keys are rejected so typos cannot silently disable a notification kind.
 * @param raw - the loader row's `config` value (may be undefined).
 * @returns a fully populated, validated config object.
 */
export function resolveConfig(raw) {
  const source = raw === undefined ? {} : raw
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('dsh-system-notifier: config must be an object')
  }
  const known = new Set([...Object.keys(DEFAULTS)])
  for (const key of Object.keys(source)) {
    if (!known.has(key)) throw new Error(`dsh-system-notifier: unknown config key ${JSON.stringify(key)}`)
  }

  const resolved = {}
  for (const [section, fields] of Object.entries(SECTION_SHAPES)) {
    const supplied = source[section] === undefined ? {} : source[section]
    if (supplied === null || typeof supplied !== 'object' || Array.isArray(supplied)) {
      throw new Error(`dsh-system-notifier: config.${section} must be an object`)
    }
    for (const key of Object.keys(supplied)) {
      if (!fields.includes(key)) throw new Error(`dsh-system-notifier: unknown config key ${JSON.stringify(`${section}.${key}`)}`)
    }
    resolved[section] = { ...DEFAULTS[section], ...supplied }
    requireBoolean(resolved[section].enabled, `config.${section}.enabled`)
    for (const msField of fields.filter(field => field !== 'enabled')) {
      requireMs(resolved[section][msField], `config.${section}.${msField}`)
    }
  }

  resolved.sound = requireBoolean(source.sound ?? DEFAULTS.sound, 'config.sound')

  const appLabel = source.appLabel ?? DEFAULTS.appLabel
  if (typeof appLabel !== 'string' || appLabel.trim() === '' || appLabel.length > 64) {
    throw new Error('dsh-system-notifier: config.appLabel must be a non-empty string of at most 64 characters')
  }
  resolved.appLabel = appLabel

  const sessionFilter = source.sessionFilter ?? DEFAULTS.sessionFilter
  if (!Array.isArray(sessionFilter) || sessionFilter.some(pattern => typeof pattern !== 'string' || pattern.trim() === '')) {
    throw new Error('dsh-system-notifier: config.sessionFilter must be an array of non-empty wildcard patterns')
  }
  resolved.sessionFilter = sessionFilter.map(pattern => pattern.trim())
  return resolved
}

/**
 * Compile one `*`-wildcard pattern to an anchored case-insensitive RegExp
 * (every other regex metacharacter is matched literally; session titles are
 * prose, so `refactor*` matches `Refactor: auth`).
 * @param pattern - a wildcard pattern such as `refactor*` or `*team*`.
 * @returns an anchored regular expression.
 */
export function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`, 'i')
}

/**
 * Whether one session passes `config.sessionFilter`: empty matches everything;
 * otherwise at least one pattern must match the session title or the raw session id.
 * @param patterns - the resolved `sessionFilter` patterns.
 * @param title - the latest known session title, when any.
 * @param sessionId - the raw session id string.
 * @returns true when notifications for this session are in scope.
 */
export function sessionMatches(patterns, title, sessionId) {
  if (patterns.length === 0) return true
  const compiled = patterns.map(wildcardToRegExp)
  return compiled.some(pattern => pattern.test(sessionId) || (title !== undefined && pattern.test(title)))
}
