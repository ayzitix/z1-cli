/**
 * Unit tests for `web-service.ts`: path resolution, the settings template, the
 * health probe, stale pid files and the `Z1_SEARX_URL` opt-out.
 *
 * Nothing here installs SearXNG, downloads anything or binds port 8888 — every
 * network interaction is a `node:http` server on an ephemeral port, so the test
 * runs offline in well under a second.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  DEFAULT_SEARX_URL,
  SEARXNG_SHA,
  SEARX_STATE_ENV,
  autostartEnabled,
  checkHealth,
  ensureWebSearch,
  expandHome,
  formatSearxState,
  generateSecret,
  initialSearxPhase,
  isExternallyManaged,
  isInstalled,
  isProcessAlive,
  readPid,
  renderSettings,
  resolveWebDir,
  resolveWebPaths,
  searxUrl,
  stopWebSearch,
  takeLock,
  waitForHealth,
  webSearchStatus,
} from '../web-service.ts'

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
assert.equal(paths.manifestFile, '/tmp/webdir/searxng/installed.json')
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

// Nothing on the pid file means stop is a clean no-op too.
const idle = await stopWebSearch({ Z1_WEB_DIR: dir, Z1_SEARX_URL: '' })
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
assert.equal((await stopWebSearch(stopHint)).state, 'stopped')
assert.equal(stopHint[SEARX_STATE_ENV], undefined)

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

await new Promise<void>(resolve => server.close(() => resolve()))
rmSync(dir, { recursive: true, force: true })

console.log('PASS: web-service (paths, template, health, pid, external, off switch, state hint, install lock)')
