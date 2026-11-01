import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS, resolveConfig, sessionMatches, wildcardToRegExp } from '../config.js'
import {
  appleScriptEscape, isCriticalKind, linuxArgs, macOsArgs, sanitize, windowsArgs, xmlEscape,
} from '../notify.js'

test('resolveConfig: defaults when the row has no config', () => {
  assert.deepEqual(resolveConfig(undefined), {
    ...DEFAULTS,
    permission: { ...DEFAULTS.permission },
    question: { ...DEFAULTS.question },
    complete: { ...DEFAULTS.complete },
    error: { ...DEFAULTS.error },
    sessionFilter: [],
  })
})

test('resolveConfig: accepts overrides of every field', () => {
  const resolved = resolveConfig({
    permission: { enabled: false, delayMs: 0 },
    question: { delayMs: 10_000 },
    complete: { minRunMs: 60_000 },
    error: { dedupMs: 0 },
    sound: false,
    appLabel: 'DSH',
    sessionFilter: ['refactor*'],
  })
  assert.equal(resolved.permission.enabled, false)
  assert.equal(resolved.permission.delayMs, 0)
  assert.equal(resolved.question.delayMs, 10_000)
  assert.equal(resolved.complete.minRunMs, 60_000)
  assert.equal(resolved.error.dedupMs, 0)
  assert.equal(resolved.sound, false)
  assert.equal(resolved.appLabel, 'DSH')
  assert.deepEqual(resolved.sessionFilter, ['refactor*'])
})

test('resolveConfig: fails loud on misconfiguration', () => {
  assert.throws(() => resolveConfig({ nope: true }), /unknown config key "nope"/)
  assert.throws(() => resolveConfig({ permission: { nope: 1 } }), /unknown config key "permission\.nope"/)
  assert.throws(() => resolveConfig({ permission: { delayMs: -1 } }), /delayMs must be an integer >= 0/)
  assert.throws(() => resolveConfig({ sound: 'yes' }), /sound must be a boolean/)
  assert.throws(() => resolveConfig({ appLabel: '   ' }), /appLabel must be a non-empty string/)
  assert.throws(() => resolveConfig({ appLabel: 'x'.repeat(65) }), /appLabel must be a non-empty string/)
  assert.throws(() => resolveConfig({ sessionFilter: [''] }), /sessionFilter must be an array/)
  assert.throws(() => resolveConfig(null), /config must be an object/)
})

test('wildcardToRegExp: only * is a wildcard, everything else is literal', () => {
  const pattern = wildcardToRegExp('a.b*c')
  assert.ok(pattern.test('a.b任意c'))
  assert.ok(!pattern.test('aXb任意c'))
  assert.ok(!pattern.test('xa.b任意c'))
})

test('sessionMatches: empty filter passes everything; patterns match title or id', () => {
  assert.equal(sessionMatches([], undefined, 'sess-1'), true)
  assert.equal(sessionMatches(['refactor*'], 'Refactor: auth flow', 'sess-1'), true)
  assert.equal(sessionMatches(['a1b2c3*'], undefined, 'a1b2c3d4e5f6'), true)
  assert.equal(sessionMatches(['refactor*'], 'Write docs', 'sess-1'), false)
  assert.equal(sessionMatches(['*team*'], 'agent-team scratchpad', 'sess-1'), true)
})

test('sanitize: single line, collapsed whitespace, capped length, non-strings become empty', () => {
  assert.equal(sanitize(undefined), '')
  assert.equal(sanitize(42), '')
  assert.equal(sanitize('a\nb\tc'), 'a b c')
  assert.equal(sanitize('  a\u0000b  '), 'a b')
  const capped = sanitize('x'.repeat(500))
  assert.equal(capped.length, 200)
  assert.ok(capped.endsWith('…'))
})

test('appleScriptEscape and xmlEscape escape their literal syntax', () => {
  assert.equal(appleScriptEscape('say "hi"\\'), 'say \\"hi\\"\\\\')
  assert.equal(xmlEscape('<b>&"\''), '&lt;b&gt;&amp;&quot;&apos;')
})

test('isCriticalKind: only clean completion is non-critical', () => {
  assert.equal(isCriticalKind('permission'), true)
  assert.equal(isCriticalKind('question'), true)
  assert.equal(isCriticalKind('error'), true)
  assert.equal(isCriticalKind('complete'), false)
})

test('linuxArgs: urgency and expiry follow the kind; label composition', () => {
  assert.deepEqual(
    linuxArgs({ kind: 'error', title: 'T', subtitle: 'S', body: 'B' }, 'DSH'),
    ['--app-name', 'DSH', '--urgency', 'critical', '--expire-time', '0', 'DSH: T', 'S\nB'],
  )
  assert.deepEqual(
    linuxArgs({ kind: 'complete', title: 'T', subtitle: '', body: 'B' }, 'DSH'),
    ['--app-name', 'DSH', '--urgency', 'normal', '--expire-time', '5000', 'T', 'B'],
  )
})

test('macOsArgs: subtitle and sound are optional parts of the script', () => {
  assert.deepEqual(
    macOsArgs({ kind: 'permission', title: 'T', subtitle: 'S', body: 'B' }, true),
    ['-e', 'display notification "B" with title "T" subtitle "S" sound name "Glass"'],
  )
  assert.deepEqual(
    macOsArgs({ kind: 'complete', title: 'T', subtitle: '', body: 'B' }, true),
    ['-e', 'display notification "B" with title "T"'],
  )
})

test('windowsArgs: EncodedCommand decodes to a toast script with escaped XML', () => {
  const args = windowsArgs({ kind: 'error', title: 'T<1>', subtitle: 'S', body: 'B"&' })
  assert.equal(args[0], '-NoProfile')
  assert.equal(args[1], '-NonInteractive')
  assert.equal(args[2], '-EncodedCommand')
  const script = Buffer.from(args[3], 'base64').toString('utf16le')
  assert.ok(script.includes('<text id="1">T&lt;1&gt;</text>'), script)
  assert.ok(script.includes('<text id="2">S — B&quot;&amp;</text>'), script)
  assert.ok(script.includes('CreateToastNotifier'), script)
})
