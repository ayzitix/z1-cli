/**
 * Unit tests for `web-service.ts`: path resolution, the settings template, the
 * health probe, stale pid files, process identity, log rotation, the download's
 * checksum/deadline, stop-refusal, adoption of a legacy pid file, and the
 * `Z1_SEARX_URL` opt-out.
 *
 * Nothing here installs SearXNG, downloads the real tarball or binds port 8888 —
 * every network interaction is a `node:http` server on an ephemeral port, so the
 * test needs no network. The one child process it spawns runs a two-line script
 * against a silent local server: that is the `--once`-must-not-hang check.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

import {
  DEFAULT_SEARX_URL,
  LOG_MAX_BYTES,
  SEARXNG_SHA,
  SEARX_STATE_ENV,
  autostartEnabled,
  checkHealth,
  downloadSource,
  ensureWebSearch,
  expandHome,
  formatSearxState,
  generateSecret,
  identityMatches,
  initialSearxPhase,
  isExternallyManaged,
  isInstalled,
  isProcessAlive,
  processIdentity,
  readPid,
  readServerRecord,
  renderSettings,
  resolveWebDir,
  resolveWebPaths,
  rotateLog,
  searxUrl,
  stopWebSearch,
  takeLock,
  waitForHealth,
  webSearchStatus,
  writeServerRecord,
} from '../web-service.ts'
import type { ProcessIdentity } from '../web-service.ts'

const templatePath = join(import.meta.dirname, '..', 'web', 'searxng.settings.yml')
const template = readFileSync(templatePath, 'utf8')

// ---- path resolution -------------------------------------------------------

// `Z1_WEB_DIR` wins over everything else, and `~` is expanded because a value
// from a shell profile arrives unexpanded.
assert.equal(resolveWebDir({ Z1_WEB_DIR: '/tmp/x', XDG_DATA_HOME: '/tmp/xdg', HOME: '/home/u' }), '/tmp/x')
assert.equal(resolveWebDir({ Z1_WEB_DIR: '~/web', HOME: '/home/u' }), '/home/u/web')
assert.equal(expandHome('~', '/home/u'), '/home/u')
// Blank values fall through instead of claiming `/` as the data directory.
assert.equal(resolveWebDir({ Z1_WEB_DIR: '  ', XDG_DATA_HOME: '/tmp/xdg', HOME: '/home/u' }), '/tmp/xdg/z1/web')
assert.equal(resolveWebDir({ HOME: '/home/u' }), '/home/u/.local/share/z1/web')
// An `~` in XDG_DATA_HOME expands too.
assert.equal(resolveWebDir({ XDG_DATA_HOME: '~/data', HOME: '/home/u' }), '/home/u/data/z1/web')

const paths = resolveWebPaths({ Z1_WEB_DIR: '/tmp/webdir' })
assert.equal(paths.dataDir, '/tmp/webdir/searxng')
assert.equal(paths.srcDir, '/tmp/webdir/searxng/src')
assert.equal(paths.settingsFile, '/tmp/webdir/searxng/settings.yml')
assert.equal(paths.logFile, '/tmp/webdir/searxng/searxng.log')
assert.equal(paths.pidFile, '/tmp/webdir/searxng/searxng.pid')
assert.equal(paths.identityFile, '/tmp/webdir/searxng/searxng.json')
assert.equal(paths.manifestFile, '/tmp/webdir/searxng/installed.json')
assert.equal(paths.lockFile, '/tmp/webdir/searxng/install.lock')
assert.equal(paths.logFile, '/tmp/webdir/searxng/searxng.log')
assert.equal(paths.templateFile, join(import.meta.dirname, '..', 'web', 'searxng.settings.yml'))
assert.ok(paths.python.endsWith(process.platform === 'win32' ? join('Scripts', 'python.exe') : join('bin', 'python')))
assert.ok(isInstalled(paths) === false)

// ---- settings template -----------------------------------------------------

const secret = generateSecret()
assert.match(secret, /^[0-9a-f]{64}$/) // 32 bytes hex, not a guessable phrase
const rendered = renderSettings(template, secret)

assert.ok(!rendered.includes('{{SECRET}}'))
assert.ok(rendered.includes(`secret_key: "${secret}"`))
assert.ok(rendered.includes('bind_address: "127.0.0.1"'))
assert.ok(rendered.includes('port: 8888'))
// `format=json` answers 403 without this, and the web tools read only JSON.
assert.ok(rendered.includes('formats:'))
assert.ok(rendered.includes('- json'))
assert.ok(rendered.includes('safe_search: 0'))
assert.ok(rendered.includes('limiter: false'))
assert.ok(rendered.includes('request_timeout: 4.0'))
assert.ok(rendered.includes('use_default_settings: true'))
// The engine set the install was verified against.
for (const engine of ['google', 'bing', 'brave', 'mojeek', 'wikipedia', 'github']) {
  assert.ok(rendered.includes(`engine: ${engine}`), `engine ${engine} missing`)
}
// A template without the placeholder is a packaging bug, and silently shipping
// `{{SECRET}}` as the key would be worse than failing.
assert.throws(() => renderSettings('server:\n  secret_key: x\n', secret), /no \{\{SECRET\}\}/)

// ---- URL handling ----------------------------------------------------------

assert.equal(searxUrl({}), DEFAULT_SEARX_URL)
assert.equal(searxUrl({ Z1_SEARX_URL: ' http://10.0.0.2:9999/ ' }), 'http://10.0.0.2:9999')
assert.equal(isExternallyManaged({}), false)
assert.equal(isExternallyManaged({ Z1_SEARX_URL: 'http://10.0.0.2:9999' }), true)
assert.equal(autostartEnabled({}), true)
assert.equal(autostartEnabled({ Z1_WEB_AUTOSTART: 'off' }), false)
assert.equal(autostartEnabled({ Z1_WEB_AUTOSTART: 'ON' }), true)

// ---- health probe against a local server -----------------------------------

const server = createServer((req, res) => {
  if (req.url?.startsWith('/healthz')) {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('OK')
    return
  }
  res.writeHead(404)
  res.end()
})
await new Promise<void>(resolve => server.listen({ host: '127.0.0.1', port: 0 }, resolve))
const { port } = server.address() as AddressInfo
const good = `http://127.0.0.1:${String(port)}`

assert.equal(await checkHealth(good), true)
// The base path is kept: SearXNG under a reverse-proxy sub-path answers
// `/sub/healthz`. A path that does not have a health endpoint is a 404.
assert.equal(await checkHealth(`${good}/nothing`), false)
assert.equal(await waitForHealth({ url: good, timeoutMs: 2000, intervalMs: 10 }), true)

// 500 and a closed port are both "not ready", never an exception.
const broken = createServer((_req, res) => {
  res.writeHead(500)
  res.end('nope')
})
await new Promise<void>(resolve => broken.listen({ host: '127.0.0.1', port: 0 }, resolve))
const brokenPort = (broken.address() as AddressInfo).port
// Nothing listens here once `broken` closes: the "backend is down" address the
// status tests point at, so a real backend on 8888 cannot answer for it.
const down = `http://127.0.0.1:${String(brokenPort)}`
assert.equal(await checkHealth(down), false)
await new Promise<void>(resolve => broken.close(() => resolve()))

// A port with nothing on it, and a nonsense URL, are false rather than throws.
assert.equal(await checkHealth(down, 500), false)
assert.equal(await checkHealth('not a url'), false)

// Polling gives up at the deadline instead of hanging.
const started = Date.now()
assert.equal(await waitForHealth({ url: down, timeoutMs: 150, intervalMs: 20 }), false)
assert.ok(Date.now() - started < 2000)

// ---- pid files -------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'z1-web-'))
const missing = readPid(join(dir, 'nope.pid'))
assert.equal(missing, undefined)

const pidFile = join(dir, 'searxng.pid')
writeFileSync(pidFile, `${String(process.pid)}\n`)
assert.equal(readPid(pidFile), process.pid)
assert.equal(isProcessAlive(process.pid), true)

// A pid nobody owns: the shell's own child is gone, so this is stale.
writeFileSync(pidFile, '999999\n')
assert.equal(isProcessAlive(999_999), false)
writeFileSync(pidFile, 'garbage')
assert.equal(readPid(pidFile), undefined)

// ---- process identity ------------------------------------------------------
// A pid is not an identity: three things must agree before z1 signals anything.

const ours = await processIdentity(process.pid)
assert.equal(ours?.pid, process.pid, 'the running test process has a readable identity')
assert.ok((ours?.command ?? '').includes('node'), 'the command line is read from the kernel')

const record = {
  pid: process.pid,
  startedAt: ours?.startedAt ?? '424242',
  port: 8888,
  command: `python -m waitress --listen=127.0.0.1:8888 --threads=8 searx.webapp:app`,
}
const asIdentity = (over: Partial<ProcessIdentity>): ProcessIdentity => ({
  pid: record.pid,
  startedAt: record.startedAt,
  command: record.command,
  ...over,
})

assert.equal(identityMatches(record, asIdentity({})), true, 'same pid, start marker, command and port matches')
// A recycled pid: same number, different process, so a different start marker.
assert.equal(identityMatches(record, asIdentity({ startedAt: '424243' })), false)
// The portable half of the check: the command must be *this* waitress.
assert.equal(identityMatches(record, asIdentity({ command: 'node --listen=127.0.0.1:8888 server.js' })), false)
assert.equal(identityMatches(record, asIdentity({ pid: process.pid + 1 })), false)
// The port is part of the claim: another waitress on another port is other work.
assert.equal(identityMatches({ ...record, port: 9999 }, asIdentity({})), false)
// The real identity of a live process is not this SearXNG, so it must not match.
assert.equal(identityMatches(record, ours), false, 'a live pid whose command differs is not ours')
// An unreadable identity is a refusal, never a maybe (stop then leaves it alone).
assert.equal(identityMatches(record, undefined), false)
// The Windows `wmic` fallback has no start marker for either side: the check is
// weaker (command and port only) but it is still a check.
const noMarker = { ...record, startedAt: '' }
assert.equal(identityMatches(noMarker, asIdentity({ startedAt: '' })), true)
assert.equal(identityMatches(noMarker, asIdentity({ startedAt: '', command: 'node x' })), false)

// ---- status + stale state --------------------------------------------------

// A finished install is: manifest, venv interpreter and source tree.
const fake = join(dir, 'searxng')
mkdirSync(join(fake, 'src'), { recursive: true })
mkdirSync(join(fake, 'venv', 'bin'), { recursive: true })
writeFileSync(join(fake, 'venv', 'bin', 'python'), '')
writeFileSync(join(fake, 'installed.json'), JSON.stringify({ sha: SEARXNG_SHA }))
const fakeEnv = { Z1_WEB_DIR: dir, Z1_SEARX_URL: '', Z1_WEB_AUTOSTART: 'on' }
const fakePaths = resolveWebPaths(fakeEnv)
assert.equal(isInstalled(fakePaths), true)

// Dead pid + healthy install -> stopped, not "starting" forever. The probe goes
// to a dead address: a real backend on 8888 must never decide this test.
writeFileSync(fakePaths.pidFile, '999999\n')
const stopped = await webSearchStatus(fakeEnv, { url: down })
assert.equal(stopped.state, 'stopped')
assert.equal(stopped.managed, true)
assert.equal(stopped.installed, true)

// `/healthz` 200 wins over everything, including a stale pid file.
const upEnv = { ...fakeEnv, Z1_SEARX_URL: good, Z1_WEB_AUTOSTART: 'off' }
const external = await webSearchStatus(upEnv, { url: good })
assert.equal(external.state, 'external')
assert.equal(external.detail, 'using the configured SearXNG')

// `Z1_SEARX_URL` also means "never manage": no install, no start, no dirs.
const untouched = join(dir, 'untouched')
const externalEnsure = await ensureWebSearch({
  env: { Z1_WEB_DIR: untouched, Z1_SEARX_URL: good },
})
assert.equal(externalEnsure.state, 'external')
assert.equal(externalEnsure.managed, false)
assert.equal(isInstalled(resolveWebPaths({ Z1_WEB_DIR: untouched })), false)
assert.equal(readPid(join(untouched, 'searxng', 'searxng.pid')), undefined)
// Stopping an external instance is a no-op, not an error.
assert.equal((await stopWebSearch({ Z1_WEB_DIR: untouched, Z1_SEARX_URL: good })).state, 'external')

// Off switch: nothing is installed or started, and the reason says why.
const off = await ensureWebSearch({ env: { Z1_WEB_DIR: join(dir, 'off'), Z1_WEB_AUTOSTART: 'off' } })
assert.equal(off.state, 'disabled')
assert.ok(off.detail.includes('autostart off'))
assert.equal(isInstalled(resolveWebPaths({ Z1_WEB_DIR: join(dir, 'off') })), false)

// Nothing to stop: no record, no pid, and nothing answering on `down`, so stop
// is a clean no-op. (The url is injected: a real backend on 8888 answers 200 and
// would turn this into "not mine to stop", which is a different case.)
rmSync(fakePaths.pidFile, { force: true })
const idle = await stopWebSearch({ Z1_WEB_DIR: dir, Z1_SEARX_URL: '' }, { url: down })
assert.equal(idle.state, 'stopped')
assert.equal(idle.detail, 'was not running')
assert.equal(readPid(fakePaths.pidFile), undefined)

// ---- provisioning hint (Z1_SEARX_STATE) ------------------------------------

// Exactly the phases `module/lib/status.js` reads: `installing`/`starting`
// (optionally `:<epochMs>`, believed for 20 minutes), `up`, `down:<reason>`.
// There is no `healthy`/`external` value — those are the module's own output.
assert.equal(formatSearxState('up'), 'up')
assert.equal(formatSearxState('installing', { at: 1_700_000_000_000 }), 'installing:1700000000000')
assert.match(formatSearxState('starting'), /^starting:\d+$/)
// The phase a fresh run publishes before it knows anything: install first.
assert.equal(initialSearxPhase(false), 'installing')
assert.equal(initialSearxPhase(true), 'starting')
// One line, bounded, and the reason survives: it ends up in a worker's report.
const downLine = formatSearxState('down', { reason: `no\nanswer\t${'x'.repeat(400)}` })
assert.match(downLine, /^down:no answer x+/)
assert.ok(!/[\n\t]/.test(downLine))
assert.equal(downLine.length, 'down:'.length + 200)

// An external backend and the off switch are not "z1 is provisioning": the hint
// stays unset, so the module's own probe is the authority.
const externalHint: NodeJS.ProcessEnv = { Z1_WEB_DIR: untouched, Z1_SEARX_URL: good }
await ensureWebSearch({ env: externalHint })
assert.equal(externalHint[SEARX_STATE_ENV], undefined)
const offHint: NodeJS.ProcessEnv = { Z1_WEB_DIR: join(dir, 'off'), Z1_WEB_AUTOSTART: 'off' }
await ensureWebSearch({ env: offHint })
assert.equal(offHint[SEARX_STATE_ENV], undefined)

// The install hint is published *synchronously*: a worker spawned right after
// the call must read it, so it cannot wait behind the first `await`. The web dir
// is a regular file, so the install fails immediately after touching it.
const blockedDir = join(dir, 'blocked')
writeFileSync(blockedDir, 'a file where the web dir would be\n')
const installHint: NodeJS.ProcessEnv = { Z1_WEB_DIR: blockedDir, Z1_WEB_AUTOSTART: 'on' }
const installing = ensureWebSearch({ env: installHint, url: down, timeoutMs: 0 })
assert.match(String(installHint[SEARX_STATE_ENV]), /^installing:\d+$/)
const installStatus = await installing
assert.equal(installStatus.state, 'failed')
// ...and every exit path replaces it with a terminal phase, never `starting:`.
assert.match(String(installHint[SEARX_STATE_ENV]), /^(up|down:)/)
assert.ok(!String(installHint[SEARX_STATE_ENV]).includes('\n'))

// An install that exists but cannot start (here: the venv interpreter is not
// executable) is `starting:<ms>` then `down:…`, and the pid file is only
// written for a process that really spawned — a spawn error must not crash.
const startHint: NodeJS.ProcessEnv = { ...fakeEnv }
const starting = ensureWebSearch({ env: startHint, url: down, timeoutMs: 0 })
assert.match(String(startHint[SEARX_STATE_ENV]), /^starting:\d+$/)
const startStatus = await starting
assert.equal(startStatus.state, 'failed')
assert.match(String(startHint[SEARX_STATE_ENV]), /^down:searxng did not start/)
assert.equal(readPid(fakePaths.pidFile), undefined)

// `starting:`/`installing:` hints are dropped by a stop: nothing is coming up.
const stopHint: NodeJS.ProcessEnv = { Z1_WEB_DIR: dir, Z1_SEARX_URL: '', [SEARX_STATE_ENV]: 'starting:1' }
assert.equal((await stopWebSearch(stopHint, { url: down })).state, 'stopped')
assert.equal(stopHint[SEARX_STATE_ENV], undefined)

// ---- stop refuses what it cannot verify ------------------------------------

// A record that names a live pid — this test process — but describes a waitress
// command: the start marker agrees, the command does not. Nothing is signalled
// (the assertion below would never run if it were), and only the record goes.
const stopDir = join(dir, 'stop')
const stopPaths = resolveWebPaths({ Z1_WEB_DIR: stopDir })
mkdirSync(stopPaths.dataDir, { recursive: true })
writeServerRecord(stopPaths, {
  pid: process.pid,
  startedAt: ours?.startedAt ?? '1',
  port: 4321,
  command: 'python -m waitress --listen=127.0.0.1:4321 searx.webapp:app',
})
assert.equal(readServerRecord(stopPaths)?.pid, process.pid, 'the identity file parses back')
assert.equal(readPid(stopPaths.pidFile), process.pid, 'the plain pid file is written beside it')
const refused = await stopWebSearch({ Z1_WEB_DIR: stopDir, Z1_SEARX_URL: '' }, { url: down })
assert.equal(refused.state, 'stopped')
assert.match(refused.detail, /refusing to signal pid/)
assert.equal(isProcessAlive(process.pid), true, 'an unrelated live pid was not signalled')
assert.equal(readServerRecord(stopPaths), undefined, 'our stale record is removed')
assert.equal(readPid(stopPaths.pidFile), undefined)

// A pid with no identity beside it (an older build, a deleted file): the number
// is not a claim about anything, so it is reported and never signalled.
const orphanDir = join(dir, 'orphan')
const orphanPaths = resolveWebPaths({ Z1_WEB_DIR: orphanDir })
mkdirSync(orphanPaths.dataDir, { recursive: true })
writeFileSync(orphanPaths.pidFile, `${String(process.pid)}\n`)
const orphan = await stopWebSearch({ Z1_WEB_DIR: orphanDir, Z1_SEARX_URL: '' }, { url: down })
assert.equal(orphan.state, 'stopped')
assert.match(orphan.detail, new RegExp(`pid ${String(process.pid)} has no recorded identity`))
assert.equal(isProcessAlive(process.pid), true, 'a bare pid is not signalled either')
assert.equal(existsSync(orphanPaths.pidFile), false, 'the unverifiable record is cleaned up')

// Healthy, but nothing of ours on record: someone else's listener. z1 says so
// and leaves it running — it is not z1's process to stop.
const listenerDir = join(dir, 'listener')
const listener = await stopWebSearch({ Z1_WEB_DIR: listenerDir, Z1_SEARX_URL: '' }, { url: good })
assert.equal(listener.state, 'ready')
assert.match(listener.detail, /was not started by this z1; not stopping it/)
assert.equal(await checkHealth(good), true, 'the unmanaged listener is still answering')

// ---- legacy pid adoption ---------------------------------------------------

// A backend installed by a build that predates `searxng.json`: the plain pid
// file is all there is. It is adopted when — and only when — the command line
// is this waitress on this port, using `identityMatches` unchanged.
const legacyPid = 999_998
const legacyCommand = `python -m waitress --listen=127.0.0.1:${String(port)} --threads=8 --channel-timeout=300 searx.webapp:app`
const legacyIdentity: ProcessIdentity = { pid: legacyPid, startedAt: '777777', command: legacyCommand }
const readerFor =
  (identity: ProcessIdentity | undefined) =>
  async (pid: number): Promise<ProcessIdentity | undefined> =>
    identity !== undefined && identity.pid === pid ? identity : undefined

const legacyDir = join(dir, 'legacy')
const legacyPaths = resolveWebPaths({ Z1_WEB_DIR: legacyDir })
mkdirSync(legacyPaths.dataDir, { recursive: true })
writeFileSync(legacyPaths.pidFile, `${String(legacyPid)}\n`)
const legacyEnv = { Z1_WEB_DIR: legacyDir, Z1_SEARX_URL: '' }
assert.equal(readServerRecord(legacyPaths), undefined, 'no identity file to begin with')

// The status answer adopts it, so a legacy backend reads as ours (healthy).
const adoptedStatus = await webSearchStatus(legacyEnv, { url: good, identity: readerFor(legacyIdentity) })
assert.equal(adoptedStatus.state, 'ready')
assert.equal(adoptedStatus.pid, legacyPid, 'the adopted pid is reported')
assert.equal(adoptedStatus.detail, `ready at ${good}`)
const adoptedRecord = readServerRecord(legacyPaths)
assert.equal(adoptedRecord?.pid, legacyPid, 'adoption writes the record a start would have written')
assert.equal(adoptedRecord?.startedAt, '777777')
assert.equal(adoptedRecord?.port, port)
assert.equal(adoptedRecord?.command, legacyCommand)

// A startup adopts too, and says nothing about the backend it inherited: the
// old "was not started by this z1" line on every launch was the bug.
const adoptLines: string[] = []
const legacyStart = await ensureWebSearch({
  env: legacyEnv,
  url: good,
  identity: readerFor(legacyIdentity),
  onLine: line => adoptLines.push(line),
})
assert.equal(legacyStart.state, 'ready')
assert.equal(legacyStart.pid, legacyPid)
assert.deepEqual(adoptLines, [], 'adoption prints nothing at startup')

// Wrong command line: a live pid that is not our waitress is not adopted. The
// listener is still used, the status still says so, and no banner line appears.
const strangerDir = join(dir, 'legacy-stranger')
const strangerPaths = resolveWebPaths({ Z1_WEB_DIR: strangerDir })
mkdirSync(strangerPaths.dataDir, { recursive: true })
writeFileSync(strangerPaths.pidFile, `${String(legacyPid)}\n`)
const strangerIdentity: ProcessIdentity = {
  pid: legacyPid,
  startedAt: '777777',
  command: `node --listen=127.0.0.1:${String(port)} server.js`,
}
const strangerEnv = { Z1_WEB_DIR: strangerDir, Z1_SEARX_URL: '' }
const strangerLines: string[] = []
const stranger = await ensureWebSearch({
  env: strangerEnv,
  url: good,
  identity: readerFor(strangerIdentity),
  onLine: line => strangerLines.push(line),
})
assert.equal(stranger.state, 'ready', 'an unmanaged listener is still usable')
assert.equal(stranger.pid, undefined, 'but it is not claimed')
assert.match(stranger.detail, /was not started by this z1/)
assert.deepEqual(strangerLines, [], 'an unmanaged listener prints no startup line')
assert.equal(readServerRecord(strangerPaths), undefined, 'a mismatching pid is not adopted')
assert.equal(readPid(strangerPaths.pidFile), legacyPid, 'and its pid file is left alone at startup')

// The same command line *is* the waitress but on another port: still not ours.
const otherPort = await webSearchStatus(strangerEnv, {
  url: good,
  identity: readerFor({ ...legacyIdentity, pid: legacyPid, command: legacyCommand.replace(String(port), '4444') }),
})
assert.match(otherPort.detail, /was not started by this z1/)

// No pid file at all: unmanaged, silently.
const noPidDir = join(dir, 'legacy-nopid')
const noPidPaths = resolveWebPaths({ Z1_WEB_DIR: noPidDir })
mkdirSync(noPidPaths.dataDir, { recursive: true })
const noPidLines: string[] = []
const noPid = await ensureWebSearch({
  env: { Z1_WEB_DIR: noPidDir, Z1_SEARX_URL: '' },
  url: good,
  onLine: line => noPidLines.push(line),
})
assert.equal(noPid.state, 'ready')
assert.equal(noPid.pid, undefined)
assert.match(noPid.detail, /not started by this z1/)
assert.deepEqual(noPidLines, [], 'no pid file, no startup line')
assert.equal(existsSync(noPidPaths.identityFile), false, 'nothing is invented for a listener with no pid')

// `stop` adopts before refusing, then stops what it adopted. The pid is
// deliberately one that does not exist: `kill` gets ESRCH, which proves the
// signal path ran without touching a live process (least of all the real one).
const stopLegacyDir = join(dir, 'legacy-stop')
const stopLegacyPaths = resolveWebPaths({ Z1_WEB_DIR: stopLegacyDir })
mkdirSync(stopLegacyPaths.dataDir, { recursive: true })
const deadPid = 999_997
writeFileSync(stopLegacyPaths.pidFile, `${String(deadPid)}\n`)
const adoptedStop = await stopWebSearch(
  { Z1_WEB_DIR: stopLegacyDir, Z1_SEARX_URL: '' },
  { url: good, graceMs: 100, identity: readerFor({ ...legacyIdentity, pid: deadPid }) },
)
assert.equal(adoptedStop.state, 'stopped')
assert.equal(adoptedStop.detail, `stopped pid ${String(deadPid)}`, 'adoption turns a refusal into a stop')
assert.equal(readServerRecord(stopLegacyPaths), undefined, 'the record is gone after the stop')
assert.equal(existsSync(stopLegacyPaths.pidFile), false)

// Adoption failing, the refusal wording is unchanged: nothing is signalled, and
// only z1's own stale record is removed.
const refuseDir = join(dir, 'legacy-refuse')
const refusePaths = resolveWebPaths({ Z1_WEB_DIR: refuseDir })
mkdirSync(refusePaths.dataDir, { recursive: true })
writeFileSync(refusePaths.pidFile, `${String(deadPid)}\n`)
const refusedLegacy = await stopWebSearch(
  { Z1_WEB_DIR: refuseDir, Z1_SEARX_URL: '' },
  { url: good, identity: readerFor({ ...strangerIdentity, pid: deadPid }) },
)
assert.equal(refusedLegacy.state, 'ready')
assert.match(refusedLegacy.detail, /was not started by this z1; not stopping it/)
assert.equal(existsSync(refusePaths.pidFile), false, 'an unverifiable pid file is cleaned up')

// ---- install lock ----------------------------------------------------------

// A first run has no web dir at all: the lock must create it, not report
// "another z1 is installing" and wait out the whole readiness budget.
const freshDir = join(dir, 'fresh')
const freshPaths = resolveWebPaths({ Z1_WEB_DIR: freshDir })
assert.equal(existsSync(freshPaths.dataDir), false)

const released = takeLock(freshPaths)
assert.equal(typeof released, 'function', 'a missing data dir must not look like a held lock')
assert.equal(existsSync(freshPaths.dataDir), true)
assert.equal(statSync(freshPaths.dataDir).mode & 0o777, 0o700)
assert.equal(readPid(freshPaths.lockFile), process.pid, 'the owner pid is recorded')
assert.equal(statSync(freshPaths.lockFile).mode & 0o777, 0o600)

// Held by a live process: no second lock.
assert.equal(takeLock(freshPaths), undefined)
released?.()
assert.equal(existsSync(freshPaths.lockFile), false)
assert.equal(readPid(freshPaths.lockFile), undefined)

// A lock left by a crash (dead pid) is reclaimed, stale logic unchanged.
writeFileSync(freshPaths.lockFile, '999999\n')
const reclaimed = takeLock(freshPaths)
assert.equal(typeof reclaimed, 'function', 'a dead owner is stale, not held')
assert.equal(readPid(freshPaths.lockFile), process.pid)
reclaimed?.()

// A real failure is an error with a reason, never "another z1 is installing":
// here the web dir's parent is a regular file.
assert.throws(() => takeLock(resolveWebPaths({ Z1_WEB_DIR: blockedDir })), /install lock failed/)

// A **live** owner holds the lock however old the file looks: a first install or
// a 60 s readiness wait legitimately owns it for minutes, so mtime decides no-
// thing while the owner answers `kill(pid, 0)`.
const liveDir = join(dir, 'lock-live')
const livePaths = resolveWebPaths({ Z1_WEB_DIR: liveDir })
mkdirSync(livePaths.dataDir, { recursive: true })
writeFileSync(livePaths.lockFile, `${String(process.pid)}\n`)
const hourAgo = new Date(Date.now() - 60 * 60_000)
utimesSync(livePaths.lockFile, hourAgo, hourAgo)
assert.equal(
  takeLock(livePaths),
  undefined,
  'a live owner with an hour-old mtime still holds the lock (no second claimant)',
)
// The same file with a dead owner is stale at once, old mtime or not.
writeFileSync(livePaths.lockFile, '999999\n')
utimesSync(livePaths.lockFile, hourAgo, hourAgo)
const afterDeath = takeLock(livePaths)
assert.equal(typeof afterDeath, 'function', 'a dead owner with an old mtime is reclaimed')
assert.equal(readPid(livePaths.lockFile), process.pid, 'the reclaimer owns it now')
afterDeath?.()
// Neither pid nor age to go on (a half-written file): held until the 10-minute
// grace expires, because only that file can say a live install is in progress.
writeFileSync(livePaths.lockFile, 'garbage')
assert.equal(takeLock(livePaths), undefined, 'an unreadable owner younger than the grace is still held')
utimesSync(livePaths.lockFile, hourAgo, hourAgo)
const afterGrace = takeLock(livePaths)
assert.equal(typeof afterGrace, 'function', 'an unreadable owner past the grace is stale')
afterGrace?.()

// ---- log rotation ----------------------------------------------------------

const logDir = join(dir, 'logs')
mkdirSync(logDir, { recursive: true })
const logFile = join(logDir, 'searxng.log')
assert.equal(rotateLog(logFile), false, 'a log that does not exist is not rotated')
writeFileSync(logFile, 'x'.repeat(64))
assert.equal(rotateLog(logFile), false, 'a small log is untouched')
assert.equal(statSync(logFile).size, 64)
assert.equal(existsSync(`${logFile}.1`), false, 'no rotation, no .1')
// Exactly the cap is still fine; one byte over rotates, and the old .1 goes.
writeFileSync(logFile, Buffer.alloc(LOG_MAX_BYTES))
assert.equal(rotateLog(logFile), false, 'at the cap the log is left alone')
assert.equal(statSync(logFile).size, LOG_MAX_BYTES)
writeFileSync(`${logFile}.1`, 'older generation')
writeFileSync(logFile, Buffer.alloc(LOG_MAX_BYTES + 1))
assert.equal(rotateLog(logFile), true, 'past the cap the log is rotated')
assert.equal(existsSync(logFile), false, 'the current log became .1')
assert.equal(statSync(`${logFile}.1`).size, LOG_MAX_BYTES + 1, 'one generation, the newest one')
assert.ok(!readFileSync(`${logFile}.1`, 'utf8').includes('older generation'))

// ---- download: checksum, redirects, deadline -------------------------------

const body = Buffer.alloc(1_100_000, 7) // above the 1 MB truncation guard
const bodySha = createHash('sha256').update(body).digest('hex')
const source = createServer((req, res) => {
  if (req.url === '/slow') return // accepts, never answers: the deadline case
  if (req.url === '/redirect') {
    res.writeHead(302, { location: '/source.tar.gz' })
    res.end()
    return
  }
  if (req.url === '/source.tar.gz') {
    res.writeHead(200, { 'content-type': 'application/gzip' })
    res.end(body)
    return
  }
  res.writeHead(404)
  res.end()
})
await new Promise<void>(resolve => source.listen({ host: '127.0.0.1', port: 0 }, resolve))
const sourceBase = `http://127.0.0.1:${String((source.address() as AddressInfo).port)}`

// A redirect is followed by hand (`fetch` cannot unref its socket), and the
// digest of the bytes that arrived is the return value.
const goodTarball = join(dir, 'good.tar.gz')
assert.equal(
  await downloadSource(`${sourceBase}/redirect`, goodTarball, { sha256: bodySha }),
  bodySha,
)
assert.equal(statSync(goodTarball).size, body.byteLength)
assert.equal(statSync(goodTarball).mode & 0o777, 0o600, 'the tarball is private')
// Wrong bytes (a proxy error page, a tampered mirror): the digest, not the URL,
// is what is believed, and nothing is written for `tar` to unpack.
const badTarball = join(dir, 'bad.tar.gz')
await assert.rejects(
  downloadSource(`${sourceBase}/source.tar.gz`, badTarball, { sha256: '0'.repeat(64) }),
  /checksum mismatch/,
)
assert.equal(existsSync(badTarball), false, 'a mismatch writes no file')

// A server that accepts and says nothing gets a deadline, not a hang.
const slowStart = Date.now()
await assert.rejects(downloadSource(`${sourceBase}/slow`, join(dir, 'slow.tgz'), { timeoutMs: 150 }), /timed out/)
assert.ok(Date.now() - slowStart < 5000, 'the download honours its deadline')

// ---- no hang: a background provisioning must never pin a finished process ---

// A server that accepts the connection and never sends a byte. Every probe here
// has a deadline, so this returns instead of waiting for the kernel.
const silent = createServer(() => {})
await new Promise<void>(resolve => silent.listen({ host: '127.0.0.1', port: 0 }, resolve))
const silentUrl = `http://127.0.0.1:${String((silent.address() as AddressInfo).port)}`

const hangStart = Date.now()
assert.equal(await waitForHealth({ url: silentUrl, timeoutMs: 300, intervalMs: 50 }), false)
const hangElapsed = Date.now() - hangStart
assert.ok(hangElapsed < 5000, `waitForHealth gave up in ${String(hangElapsed)} ms, not never`)

// `ensureWebSearch` is the fire-and-forget one: it must come back with a status
// (here: the web dir is a file, so the lock/install fails) instead of waiting
// out a silent backend.
const ensureStart = Date.now()
const silentStatus = await ensureWebSearch({
  env: { Z1_WEB_DIR: blockedDir, Z1_WEB_AUTOSTART: 'on' },
  url: silentUrl,
  timeoutMs: 150,
})
const ensureElapsed = Date.now() - ensureStart
assert.equal(silentStatus.state, 'failed')
assert.ok(ensureElapsed < 5000, `ensureWebSearch returned in ${String(ensureElapsed)} ms`)

// The real property is the process, not the promise: a `--once` that printed its
// answer exits while this provisioning is still in flight. A child runs the same
// two calls and must exit on its own — a ref'd timer or socket keeps it alive
// until the spawn timeout below, which fails the test.
const childScript = join(dir, 'no-hang.mts')
writeFileSync(
  childScript,
  [
    `import { ensureWebSearch, waitForHealth } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'web-service.ts')).href)}`,
    `const [url, blocked] = process.argv.slice(2)`,
    `if (await waitForHealth({ url, timeoutMs: 150, intervalMs: 20 })) { console.error('unexpected health'); process.exit(2) }`,
    `console.log('waited')`,
    `const status = await ensureWebSearch({ env: { Z1_WEB_DIR: blocked, Z1_WEB_AUTOSTART: 'on' }, url, timeoutMs: 150 })`,
    `console.log(status.state)`,
    '',
  ].join('\n'),
)
const childStart = Date.now()
const child = spawnSync(process.execPath, [childScript, silentUrl, blockedDir], {
  encoding: 'utf8',
  timeout: 15_000,
})
const childElapsed = Date.now() - childStart
// `null` means the spawn timeout killed it: that is the hang this test exists to
// catch. 0 is "finished everything"; 13 is "exited while an unref'd background
// promise was still pending", which is exactly a `--once` leaving its
// provisioner behind.
assert.notEqual(child.status, null, `the child never exited on its own: ${String(child.error?.message)}`)
assert.ok(child.status === 0 || child.status === 13, `the child exited ${String(child.status)}: ${String(child.stderr)}`)
assert.equal(child.stdout.split('\n')[0], 'waited', 'the bounded poll finished before the process left')
assert.ok(childElapsed < 12_000, `the child exited in ${String(childElapsed)} ms`)
await new Promise<void>(resolve => silent.close(() => resolve()))
await new Promise<void>(resolve => source.close(() => resolve()))

await new Promise<void>(resolve => server.close(() => resolve()))
rmSync(dir, { recursive: true, force: true })

console.log(
  'PASS: web-service (paths, template, health, pid, identity, external, off switch, state hint, stop refusal, legacy pid adoption, install lock, rotation, download, no hang)',
)
