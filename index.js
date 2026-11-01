/**
 * dsh-system-notifier — host half.
 *
 * Spawns a desktop notification when the model:
 *   1. asks for permission (`approval/request`) or asks the user a question
 *      (`user-questions/request`) — after a configurable pending delay, so an
 *      auto-answerer that claims the request instantly stays silent;
 *   2. completes its task — the agent reached idle through a clean turn close
 *      (`agent/turn-stopping`) and no `agent/error` on the way;
 *   3. hits a blocking error (`agent/error`) — the funnel through which every
 *      terminal failure (an exhausted rate-limit/quota retry chain included)
 *      passes. User cancellations never reach it, and clean completions are
 *      suppressed after an error so one failure yields one notification.
 *
 * Nothing is claimed or rewritten: permission and question listeners delegate
 * with `next()`, and the delayed notification cancels itself when the answer
 * arrives within the delay (the user is at the keyboard).
 *
 * All registrations live on the plugin context, so HMR/disposal unwinds them;
 * pending timers are cleared through one effect, and the notification backend
 * disables itself after a hard spawn failure (e.g. no notify-send) instead of
 * spamming the host log.
 */

import { resolveConfig, sessionMatches } from './config.js'
import { createNotifier, sanitize } from './notify.js'

export const name = 'system-notifier'

/** Fixed presentation labels for each notification kind. */
const KIND_LABELS = Object.freeze({
  permission: 'Permission needed',
  question: 'Model asks a question',
  complete: 'Task completed',
  error: 'Blocked by error',
})

/** Cap on cached session titles; notifications only need the latest ones. */
const TITLE_CACHE_LIMIT = 256

/**
 * Extract presentation facts from an `agent/error` payload. `LlmError` carries
 * a stable `code` (`RATE_LIMIT`, `QUOTA`, `AUTH`, …); anything else degrades to
 * its message.
 * @param error - the verbatim `agent/error` payload.
 * @returns the message and the machine code when present.
 */
function errorFacts(error) {
  const message = typeof error?.message === 'string' && error.message !== '' ? error.message : String(error)
  const code = typeof error?.code === 'string' ? error.code
    : typeof error?.failure?.code === 'string' ? error.failure.code
      : undefined
  return { message, code }
}

/**
 * Install the notifier's listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param rawConfig - the loader row's `config` value; validated fail-loud here.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const notify = createNotifier(ctx.logger, { sound: config.sound, appLabel: config.appLabel })

  /** Pending delayed notifications; cleared on disposal so a reload drops them. */
  const timers = new Set()
  ctx.effect(() => () => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }, 'system-notifier.timers')

  /** Latest session title by session id, fed from the durable `session/title` append feed. */
  const titles = new Map()
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'session/title') return
    titles.set(session.id, event.data.title)
    if (titles.size > TITLE_CACHE_LIMIT) titles.delete(titles.keys().next().value)
  })

  /**
   * Human label for one session: its title when known, otherwise a short id.
   * @param session - the agent's live session.
   * @returns sanitized label text.
   */
  function sessionLabel(session) {
    const title = titles.get(session.id)
    return sanitize(title ?? `session ${session.id.slice(0, 8)}`)
  }

  /**
   * Whether notifications for this session pass `config.sessionFilter`.
   * @param session - the agent's live session.
   */
  function sessionInScope(session) {
    return sessionMatches(config.sessionFilter, titles.get(session.id), session.id)
  }

  /**
   * Emit one notification now.
   * @param kind - notification kind.
   * @param title - primary line (session label).
   * @param body - detail line.
   */
  function emit(kind, title, body) {
    notify({ kind, title, subtitle: KIND_LABELS[kind], body: sanitize(body) })
  }

  /**
   * Notify `kind` only if the pending wait outlives `delayMs`; returns the
   * cancel function the waterfall caller invokes when the answer settles.
   * @param build - builds title/body at fire time (titles may refresh meanwhile).
   * @param delayMs - pending threshold; 0 notifies immediately.
   */
  function notifyIfPending(kind, delayMs, build) {
    if (delayMs <= 0) {
      const { title, body } = build()
      emit(kind, title, body)
      return () => {}
    }
    const timer = setTimeout(() => {
      timers.delete(timer)
      const { title, body } = build()
      emit(kind, title, body)
    }, delayMs)
    timer.unref?.()
    timers.add(timer)
    return () => {
      clearTimeout(timer)
      timers.delete(timer)
    }
  }

  // (1) Permission: prepend so the request is seen as soon as it exists, then
  // delegate. The cancel-on-settle keeps instant auto-answerers silent.
  ctx.on('approval/request', (req, next) => {
    const session = req.agent?.session
    if (!config.permission.enabled || (session !== undefined && !sessionInScope(session))) return next()
    const cancel = notifyIfPending('permission', config.permission.delayMs, () => ({
      title: session === undefined ? 'DSH session' : sessionLabel(session),
      body: req.reason ?? `The model wants to run ${req.toolName}.`,
    }))
    return next().finally(cancel)
  }, { prepend: true })

  // (1b) Questions to the user (ask_user_question): same delayed-pending shape.
  ctx.on('user-questions/request', (request, next) => {
    const session = request.agent?.session
    if (!config.question.enabled || (session !== undefined && !sessionInScope(session))) return next()
    const first = request.questions[0]
    const cancel = notifyIfPending('question', config.question.delayMs, () => ({
      title: session === undefined ? 'DSH session' : sessionLabel(session),
      body: first === undefined ? 'The model needs your answer to continue.' : first.question,
    }))
    return next().finally(cancel)
  }, { prepend: true })

  /** Per-run completion facts: when the run started, whether a turn closed cleanly, whether it errored. */
  const runs = new WeakMap()

  /** Last emitted error fingerprint for `error.dedupMs` collapsing. */
  let lastError = { key: undefined, at: 0 }

  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') {
      runs.set(agent, { startedAt: Date.now(), clean: false, errored: false })
      return
    }
    const run = runs.get(agent)
    runs.delete(agent)
    if (run === undefined || run.errored || !run.clean) return
    if (!config.complete.enabled || !sessionInScope(agent.session)) return
    if (Date.now() - run.startedAt < config.complete.minRunMs) return
    emit('complete', sessionLabel(agent.session), `Finished in ${Math.max(1, Math.round((Date.now() - run.startedAt) / 1000))}s.`)
  })

  // A clean close is the only completion signal: `agent/turn-stopping` fires
  // solely when the model owes nothing more and the boundary is committing.
  ctx.on('agent/turn-stopping', ({ agent }) => {
    const run = runs.get(agent)
    if (run !== undefined) run.clean = true
  })

  ctx.on('agent/error', ({ agent, error }) => {
    const run = runs.get(agent)
    if (run !== undefined) run.errored = true
    if (!config.error.enabled || !sessionInScope(agent.session)) return
    const { message, code } = errorFacts(error)
    const key = `${code ?? 'UNKNOWN'}:${message}`
    const now = Date.now()
    if (config.error.dedupMs > 0 && lastError.key === key && now - lastError.at < config.error.dedupMs) return
    lastError = { key, at: now }
    emit('error', sessionLabel(agent.session), code === undefined ? message : `[${code}] ${message}`)
  })
}
