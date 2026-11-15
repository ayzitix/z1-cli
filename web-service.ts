/**
 * A private SearXNG instance, provisioned natively (no Docker, no root) so the
 * web tools have a backend the moment z1 starts.
 *
 * z1 installs SearXNG into its own data directory once, then keeps the process
 * running between sessions: the first start pays ~20 s of downloads, every
 * later start is a `/healthz` request. Nothing here is allowed to delay or
 * break the CLI, so `ensureWebSearch()` is fired and forgotten — it reports at
 * most one line (first install, or the reason it failed) and never throws.
 *
 * Why native: the Docker route needs a daemon, a pull, a root-equivalent
 * socket and a port mapping; a venv plus one waitress process needs only `uv`
 * and a working `python3`, both of which are ordinary dev-machine furniture.
 * The source is pinned to a commit SHA because upstream has no tags, and the
 * settings template lives beside this file (`web/searxng.settings.yml`) so the
 * CLI is self-contained — the z1-web module's copy is generated from it, not
 * the other way round.
 *
 * Layout, all under `Z1_WEB_DIR` (else `$XDG_DATA_HOME/z1/web`, else
 * `~/.local/share/z1/web`):
 *
 *     searxng/
 *       src/            extracted source at SEARXNG_SHA
 *       venv/           python with SearXNG's requirements + waitress
 *       settings.yml    rendered from the template, 0600, random secret_key
 *       searxng.log     waitress/SearXNG stdout+stderr, 0600, rotated at 5 MB
 *       searxng.json    identity of the process we started (see below)
 *       searxng.pid     the same pid, plain, for humans and older builds
 *       installed.json  what was installed, when, and from where
 *
 * Process identity: a pid on its own is not an identity. Pids are recycled, and
 * the pid file can be deleted (or belong to a previous boot), so signalling
 * whatever number is in it can kill an unrelated program. `searxng.json`
 * therefore records `{ pid, startedAt, port, command }` at spawn time, where
 * `startedAt` is the kernel's start marker for that pid (`/proc/<pid>/stat`
 * field 22 on Linux, `ps -o lstart=` on macOS, the WMI creation date on
 * Windows). Before z1 signals anything it re-reads the identity and compares:
 * same pid, same start marker, and a command line that is this waitress
 * (`searx.webapp:app`) on this port. A mismatch means the pid now belongs to
 * something else, and z1 refuses to signal it — it removes its own stale record
 * instead. Only a *verified* process is ever sent SIGTERM, and only a verified
 * process that ignored SIGTERM is sent SIGKILL.
 *
 * Adoption: a build older than the identity file left only `searxng.pid` behind,
 * and its waitress is still answering. Rather than treating that listener as a
 * stranger forever (one noisy line on every launch, and a `stop` that refuses),
 * z1 reads the pid, verifies it *with the same rule* (`identityMatches`: this
 * waitress, `searx.webapp:app`, on our port) and writes the record it would have
 * written at spawn time. Adoption can therefore never accept a process a normal
 * start would reject, and a pid it cannot verify stays unmanaged — silently: the
 * unmanaged detail belongs in a status answer, not in a startup banner.
 *
 * `Z1_SEARX_URL` means "someone else runs the backend": when it is set this
 * module only reports health and never installs, starts or stops anything.
 * `Z1_WEB_AUTOSTART=off` disables provisioning for a session.
 *
 * While it works, this module exports `Z1_SEARX_STATE` into its own environment,
 * which every process it spawns inherits: the z1-web module's `web.status` reads
 * it to tell "coming up" from "down", since both look like a refused connection.
 * The first value is published synchronously (before the first `await`) and every
 * exit path replaces it with `up` or `down:<reason>`.
 *
 * Security: refuses to run as root, binds `127.0.0.1` only, writes settings and
 * log 0600, and spawns with argv arrays — there is no shell string anywhere.
 *
 * Timeouts: every network step here has a deadline and an unref'd socket/timer.
 * z1 fires `ensureWebSearch()` in the background, so a backend that accepts a
 * connection and then says nothing must never keep a finished one-shot alive:
 * `--once` prints its answer and exits while this module is still polling.
 */

import { spawn, execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * The only revision this module installs. Upstream publishes no tags, so a
 * branch name would silently change what users get between two z1 runs.
 */
export const SEARXNG_SHA = '2d500cb6b8e98b5f57fb446786e91f8de03be89f'

/** Source tarball for `SEARXNG_SHA` (~6.5 MB). */
export const SEARXNG_SOURCE_URL = `https://github.com/searxng/searxng/archive/${SEARXNG_SHA}.tar.gz`

/**
 * SHA-256 of that exact tarball, computed from the URL above.
 *
 * The commit SHA pins *which* archive GitHub is asked for, not which bytes
 * arrive: a compromised mirror, a proxy error page or a truncated stream all
 * pass a URL check. The digest turns any of those into a hard failure before
 * `tar` ever runs.
 */
export const SEARXNG_TARBALL_SHA256 = 'd214b4d411ebecbc913ab9a1548d43ce818dde49e6676a88bd547f46665fb487'

/** A download gets ten minutes: enough on a slow line, bounded for a hung one. */
export const DOWNLOAD_TIMEOUT_MS = 10 * 60_000

/** `searxng.log` is rotated (to `searxng.log.1`) once it passes this. */
export const LOG_MAX_BYTES = 5 * 1024 * 1024

/** Loopback URL used when the user did not point z1 at an existing instance. */
export const DEFAULT_SEARX_URL = 'http://127.0.0.1:8888'

/** Port written into the rendered settings; SearXNG's own default. */
export const SEARX_PORT = 8888

/** Readiness endpoint. SearXNG answers 200 as soon as it can serve searches. */
export const HEALTH_PATH = '/healthz'

/** How long a freshly spawned backend gets to answer `/healthz`. */
export const READY_TIMEOUT_MS = 60_000

/** Minimum Python SearXNG supports (`python_requires` in its `setup.py`): 3.10. */
const MIN_PYTHON = 310

const sleep = (ms: number, unref = false): Promise<void> =>
  new Promise(resolveFn => {
    const timer = setTimeout(resolveFn, ms)
    // A finished `--once` must not wait out a background readiness poll.
    if (unref) timer.unref?.()
  })

/** Every path the install touches, so tests can resolve them without I/O. */
export interface WebPaths {
  /** `<web dir>/searxng`. */
  dataDir: string
  /** Extracted SearXNG source; also the server's working directory. */
  srcDir: string
  venvDir: string
  /** `venv/bin/python` (POSIX) or `venv/Scripts/python.exe` (Windows). */
  python: string
  settingsFile: string
  logFile: string
  /** Plain pid, for humans and for builds that predate `identityFile`. */
  pidFile: string
  /** `{ pid, startedAt, port, command }` of the process we started. */
  identityFile: string
  manifestFile: string
  /** Held while installing, so two z1 processes do not share one venv. */
  lockFile: string
  /** The template shipped inside the CLI. */
  templateFile: string
}

/** `~/x` and `~` only; a real environment never expands `~user`. */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2))
  return path
}

/**
 * The web data root, in the documented precedence order. `~` is expanded in
 * both environment variables because a value like `~/scratch` in a shell
 * profile arrives here unexpanded (z1 reads the environment, not a shell).
 */
export function resolveWebDir(env: NodeJS.ProcessEnv = process.env): string {
  // `~` must expand against the home this environment describes, not the one
  // the current process happens to run under: `Z1_WEB_DIR=~/web` under
  // `HOME=/srv/z1` means `/srv/z1/web`, and tests/containers rely on that.
  const home = env['HOME']?.trim() || homedir()
  const explicit = (env['Z1_WEB_DIR'] ?? '').trim()
  if (explicit !== '') return expandHome(explicit, home)

  const xdg = (env['XDG_DATA_HOME'] ?? '').trim()
  if (xdg !== '') return join(expandHome(xdg, home), 'z1', 'web')

  return join(home, '.local', 'share', 'z1', 'web')
}

/** Absolute layout for one web directory. `templateFile` may be overridden in tests. */
export function resolveWebPaths(
  env: NodeJS.ProcessEnv = process.env,
  options: { templateFile?: string } = {},
): WebPaths {
  const dataDir = join(resolveWebDir(env), 'searxng')
  const venvDir = join(dataDir, 'venv')
  const windows = process.platform === 'win32'
  return {
    dataDir,
    srcDir: join(dataDir, 'src'),
    venvDir,
    python: windows ? join(venvDir, 'Scripts', 'python.exe') : join(venvDir, 'bin', 'python'),
    settingsFile: join(dataDir, 'settings.yml'),
    logFile: join(dataDir, 'searxng.log'),
    pidFile: join(dataDir, 'searxng.pid'),
    identityFile: join(dataDir, 'searxng.json'),
    manifestFile: join(dataDir, 'installed.json'),
    lockFile: join(dataDir, 'install.lock'),
    templateFile:
      options.templateFile ??
      // Read once from the CLI's own tree; the module's asset is a copy of it.
      join(import.meta.dirname, 'web', 'searxng.settings.yml'),
  }
}

/** `Z1_SEARX_URL` (trailing slash trimmed), else the local default. */
export function searxUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env['Z1_SEARX_URL'] ?? '').trim()
  return raw === '' ? DEFAULT_SEARX_URL : raw.replace(/\/+$/, '')
}

/** True when the user owns the backend and z1 must not touch it. */
export function isExternallyManaged(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env['Z1_SEARX_URL'] ?? '').trim() !== ''
}

/** False only for the documented off switch. */
export function autostartEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env['Z1_WEB_AUTOSTART'] ?? '').trim().toLowerCase() !== 'off'
}

/** A fresh 32-byte hex secret: what `server.secret_key` needs to be usable. */
export function generateSecret(): string {
  return randomBytes(32).toString('hex')
}

/**
 * The template with the secret substituted.
 *
 * A straight replacement, not a YAML serializer: the template is the contract
 * (comments, engine set and all), and the only variable in it is a hex string
 * that needs no quoting.
 */
export function renderSettings(template: string, secret: string): string {
  if (!template.includes('{{SECRET}}')) {
    throw new Error('searxng settings template has no {{SECRET}} placeholder')
  }
  return template.split('{{SECRET}}').join(secret)
}

/**
 * One `GET /healthz`; `false` on refusal, timeout, non-200 or a malformed URL.
 *
 * The socket and the deadline timer are unref'd so a probe still in flight can
 * never hold a finished process open; callers that must stay alive for the
 * answer (tests, the readiness poll) pass `unref: false`.
 */
export function checkHealth(url: string, timeoutMs = 2000, options: { unref?: boolean } = {}): Promise<boolean> {
  const unref = options.unref ?? true
  return new Promise<boolean>(resolve => {
    let target: URL
    try {
      target = new URL(`${url}${HEALTH_PATH}`)
    } catch {
      resolve(false)
      return
    }
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(ok)
    }
    let req: ReturnType<typeof httpRequest>
    try {
      req = send(
        target,
        { method: 'GET', timeout: timeoutMs, headers: { accept: 'text/plain' } },
        response => {
          // Drain so the socket is released, then report the status code.
          response.resume()
          done(response.statusCode === 200)
        },
      )
    } catch {
      done(false)
      return
    }
    if (unref) req.on('socket', socket => socket.unref())
    // An explicit deadline as well as the socket timeout: a server that accepts
    // and then never sends a byte must still end the probe.
    timer = setTimeout(() => {
      req.destroy()
      done(false)
    }, timeoutMs)
    if (unref) timer.unref?.()
    req.on('timeout', () => {
      req.destroy()
      done(false)
    })
    req.on('error', () => done(false))
    req.end()
  })
}

/**
 * Poll until healthy or the deadline passes. The interval is injectable so the
 * tests can run a real local server without a 60 s wall clock.
 */
export async function waitForHealth(options: {
  url: string
  timeoutMs?: number
  intervalMs?: number
  check?: (url: string) => Promise<boolean>
  /** Unref every timer and probe: the background provisioner sets this. */
  unref?: boolean
}): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? READY_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? 500
  const unref = options.unref ?? false
  const check = options.check ?? (target => checkHealth(target, 2000, { unref }))
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check(options.url)) return true
    if (Date.now() >= deadline) return false
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), unref)
  }
}

/** The pid in the file, or `undefined` for a missing, empty or corrupt file. */
export function readPid(pidFile: string): number | undefined {
  try {
    const raw = readFileSync(pidFile, 'utf8').trim()
    const pid = Number.parseInt(raw, 10)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

/** `kill(pid, 0)`: true for a live process we may signal, false when gone. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists but belongs to someone else: still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** What the kernel says about one pid right now. */
export interface ProcessIdentity {
  pid: number
  /**
   * Opaque start marker, unique per process for the life of the boot:
   * `/proc/<pid>/stat` field 22 (Linux), `ps -o lstart=` (macOS), the WMI
   * creation date (Windows). `''` when the platform could not report one.
   */
  startedAt: string
  /** Full command line, best-effort; `''` when it could not be read. */
  command: string
}

/**
 * Read the identity of `pid`, or `undefined` when it cannot be read at all.
 *
 * No shell: `execFile` with an argv array on macOS/Windows, plain file reads on
 * Linux. Every failure path returns `undefined` rather than a guess, because
 * the caller uses this to decide whether it may signal the pid.
 */
export async function processIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  if (process.platform === 'linux') {
    try {
      // Field 2 is `(comm)` and may itself contain spaces or `)`, so the fields
      // after it are counted from the *last* `)`.
      const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
      const close = stat.lastIndexOf(')')
      if (close < 0) return undefined
      const fields = stat.slice(close + 1).trim().split(/\s+/)
      // `fields[0]` is field 3 (state), so field 22 is `fields[19]`.
      const startedAt = fields[19]
      if (startedAt === undefined) return undefined
      let command = ''
      try {
        command = readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
      } catch {
        // A zombie has an empty cmdline; the start marker is still valid.
      }
      return { pid, startedAt, command }
    } catch {
      return undefined
    }
  }
  if (process.platform === 'darwin') {
    const line = await execText('ps', ['-p', String(pid), '-o', 'lstart=,command='])
    if (line === undefined) return undefined
    const parts = line.trim().split(/\s+/)
    // `lstart` is exactly five tokens (`Sun Nov 15 21:00:00 2026`).
    if (parts.length < 5) return undefined
    return { pid, startedAt: parts.slice(0, 5).join(' '), command: parts.slice(5).join(' ') }
  }
  if (process.platform === 'win32') {
    // PowerShell first: it reports the creation date as well as the command
    // line, so pid reuse is detectable. `wmic` is the fallback and only gives
    // the command, which makes the check weaker — and documented as such.
    const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${String(pid)}'; if ($p) { Write-Output $p.CreationDate.ToUniversalTime().ToString('o'); Write-Output $p.CommandLine }`
    const out = await execText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
    if (out !== undefined) {
      const [startedAt, ...rest] = out.split(/\r?\n/)
      if (startedAt !== undefined && startedAt.trim() !== '') {
        return { pid, startedAt: startedAt.trim(), command: rest.join(' ').trim() }
      }
    }
    const wmic = await execText('wmic', ['process', 'where', `processid=${String(pid)}`, 'get', 'commandline'])
    if (wmic === undefined) return undefined
    // `wmic` prints a header line and pads with blank lines.
    const command = wmic
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line !== '' && !/^CommandLine$/i.test(line))
      .join(' ')
    if (command === '') return undefined
    return { pid, startedAt: '', command }
  }
  return undefined
}

/** One short-lived `execFile` whose output is line-joined; `undefined` on any failure. */
function execText(file: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(file, [...args], { timeout: 4000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error !== null) {
        resolve(undefined)
        return
      }
      resolve(String(stdout).trim())
    })
  })
}

/**
 * What z1 wrote at spawn time: enough to recognise its own process later.
 * `startedAt`/`command` are `''` when the platform could not report them, which
 * makes the check weaker, never wrong: an unreadable identity is a refusal.
 */
export interface ServerRecord {
  pid: number
  startedAt: string
  port: number
  command: string
}

/** The recorded identity, or `undefined` for a missing or corrupt file. */
export function readServerRecord(paths: WebPaths): ServerRecord | undefined {
  try {
    const raw = JSON.parse(readFileSync(paths.identityFile, 'utf8')) as Partial<ServerRecord>
    if (typeof raw.pid !== 'number' || !Number.isInteger(raw.pid) || raw.pid <= 0) return undefined
    if (typeof raw.startedAt !== 'string' || typeof raw.command !== 'string') return undefined
    if (typeof raw.port !== 'number' || !Number.isInteger(raw.port)) return undefined
    return { pid: raw.pid, startedAt: raw.startedAt, port: raw.port, command: raw.command }
  } catch {
    return undefined
  }
}

/** Record the process z1 just spawned; the plain pid file stays for humans. */
export function writeServerRecord(paths: WebPaths, record: ServerRecord): void {
  writeFileSync(paths.identityFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  writeFileSync(paths.pidFile, String(record.pid), { mode: 0o600 })
}

/** Remove both files: a pid with no identity is not a claim about anything. */
export function clearServerRecord(paths: WebPaths): void {
  // Best-effort: a record we cannot delete (a directory in the way, a read-only
  // data dir) must not turn into a crash on the failure path.
  for (const file of [paths.identityFile, paths.pidFile]) {
    try {
      rmSync(file, { force: true })
    } catch {
      // Nothing else to do with a file we do not own.
    }
  }
}

/**
 * True when `current` is the process the record describes: same pid, same start
 * marker, and a command line that is this waitress on this port.
 *
 * The start marker alone would be enough on Linux/macOS, but it is `''` on a
 * Windows fallback, so the command line is the portable half of the check.
 */
export function identityMatches(record: ServerRecord, current: ProcessIdentity | undefined): boolean {
  if (current === undefined) return false
  if (current.pid !== record.pid) return false
  if (record.startedAt !== '' && current.startedAt !== '' && record.startedAt !== current.startedAt) return false
  if (!current.command.includes('searx.webapp:app')) return false
  return (
    current.command.includes(`--listen=127.0.0.1:${String(record.port)}`) ||
    current.command.includes(`:${String(record.port)} `) ||
    current.command.includes(`:${String(record.port)}`)
  )
}

/** How a caller reads a pid's identity; injectable so tests never spawn a backend. */
export type IdentityReader = (pid: number) => Promise<ProcessIdentity | undefined>

/**
 * Adopt the process a legacy `searxng.pid` names, when it really is our
 * waitress on `port`. Returns the record now on disk, or `undefined`.
 *
 * Only the pid file is consulted: an existing `searxng.json` is authoritative
 * (a start wrote it, so there is nothing to adopt), and a stale one is the
 * caller's business, not this function's. The candidate record is built from
 * what the kernel reports and then put through `identityMatches` unchanged, so
 * the acceptance rule is exactly the one `stop` uses before signalling.
 */
export async function adoptLegacyRecord(
  paths: WebPaths,
  port: number,
  options: { identity?: IdentityReader } = {},
): Promise<ServerRecord | undefined> {
  if (readServerRecord(paths) !== undefined) return undefined
  const pid = readPid(paths.pidFile)
  if (pid === undefined) return undefined
  const read = options.identity ?? processIdentity
  const current = await read(pid)
  if (current !== undefined && current.pid !== pid) return undefined
  const candidate: ServerRecord = {
    pid,
    startedAt: current?.startedAt ?? '',
    port,
    command: current?.command ?? '',
  }
  if (!identityMatches(candidate, current)) return undefined
  writeServerRecord(paths, candidate)
  return candidate
}

/** The record z1 should act on: the one on disk, else an adoptable legacy pid. */
async function effectiveRecord(
  paths: WebPaths,
  port: number,
  read: IdentityReader,
): Promise<ServerRecord | undefined> {
  const record = readServerRecord(paths)
  if (record !== undefined) return record
  return await adoptLegacyRecord(paths, port, { identity: read })
}

/** True when an install finished and the venv still exists. */
export function isInstalled(paths: WebPaths): boolean {
  return existsSync(paths.manifestFile) && existsSync(paths.python) && existsSync(paths.srcDir)
}

/** What the backend is doing right now, for `/web` and for `webSearchStatus()`. */
export type WebState = 'external' | 'ready' | 'starting' | 'stopped' | 'not-installed' | 'disabled' | 'failed'

export interface WebStatus {
  state: WebState
  /** True when z1 owns the process (no `Z1_SEARX_URL`). */
  managed: boolean
  url: string
  dataDir: string
  /** Pid from the pid file, when there is one and it is alive. */
  pid?: number
  /** One plain line: shown by `/web` and appended to a failure report. */
  detail: string
  /** A finished install exists on disk. */
  installed: boolean
}

/** The manifest, so `/web status` can say what version is installed. */
export interface InstallManifest {
  sha: string
  sourceUrl: string
  python: string
  installedAt: string
  /** Waitress is installed alongside the requirements and named here. */
  server: string
}

export function readManifest(paths: WebPaths): InstallManifest | undefined {
  try {
    return JSON.parse(readFileSync(paths.manifestFile, 'utf8')) as InstallManifest
  } catch {
    return undefined
  }
}

/**
 * The variable the z1-web module reads to tell "coming up" from "down": a
 * refused connection looks identical in both cases, so only the provisioner
 * knows. `module/lib/status.js` accepts `<phase>` or `<phase>:<epochMs>`, treats
 * `installing`/`starting` as "coming up" for 20 minutes, and otherwise says
 * `down` — so `up` needs no timestamp and a stale hint can never fake readiness.
 */
export const SEARX_STATE_ENV = 'Z1_SEARX_STATE'

/** The phases this module publishes, spelled exactly as `status.js` reads them. */
export type SearxPhase = 'installing' | 'starting' | 'up' | 'down'

/**
 * One `Z1_SEARX_STATE` value. `installing`/`starting` carry a timestamp so the
 * module can age the hint out after a crash; `down` carries the reason, kept to
 * one line and ≤200 chars because it lands in a worker's status report.
 */
export function formatSearxState(
  phase: SearxPhase,
  options: { at?: number; reason?: string } = {},
): string {
  if (phase === 'up') return 'up'
  if (phase === 'down') {
    const flat = (options.reason ?? 'not running').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
    return `down:${flat.slice(0, 200)}`
  }
  return `${phase}:${String(options.at ?? Date.now())}`
}

/**
 * Publish a phase for the child processes z1 spawns (module workers inherit
 * this environment). Anything z1 starts ends in `up` or `down:`, so a
 * `starting:` cannot outlive `ensureWebSearch`.
 */
function publishSearxState(env: NodeJS.ProcessEnv, phase: SearxPhase, reason?: string): void {
  env[SEARX_STATE_ENV] = formatSearxState(phase, { at: Date.now(), reason })
}

/** Current state, without changing anything. */
export async function webSearchStatus(
  env: NodeJS.ProcessEnv = process.env,
  // Tests point this at a closed ephemeral port so a real backend on 8888 (or
  // another process's) can never turn a unit test green or red.
  options: { url?: string; identity?: IdentityReader } = {},
): Promise<WebStatus> {
  const paths = resolveWebPaths(env)
  const url = options.url ?? searxUrl(env)
  const read = options.identity ?? processIdentity
  const port = managedPort(url)
  const managed = !isExternallyManaged(env)
  const installed = managed && isInstalled(paths)
  const base = { managed, url, dataDir: paths.dataDir, installed }

  if (!managed) {
    const healthy = await checkHealth(url)
    return {
      ...base,
      state: 'external',
      detail: healthy ? 'using the configured SearXNG' : `no answer from ${url}`,
    }
  }

  if (await checkHealth(url)) {
    // A listener z1 started before the identity file existed is adopted here:
    // the pid file plus a verified command line is the same claim a start makes.
    const record = await effectiveRecord(paths, port, read)
    const ours = record !== undefined && identityMatches(record, await read(record.pid))
    return {
      ...base,
      state: 'ready',
      ...(ours ? { pid: record.pid } : {}),
      detail: ours ? `ready at ${url}` : `SearXNG is answering on ${url} but was not started by this z1`,
    }
  }

  const record = await effectiveRecord(paths, port, read)
  if (record !== undefined && identityMatches(record, await read(record.pid))) {
    return { ...base, state: 'starting', pid: record.pid, detail: `starting (pid ${String(record.pid)})` }
  }
  if (installed) {
    return { ...base, state: 'stopped', detail: 'installed, not running' }
  }
  if (!autostartEnabled(env)) {
    return { ...base, state: 'disabled', detail: 'autostart off (Z1_WEB_AUTOSTART=off)' }
  }
  return { ...base, state: 'not-installed', detail: 'not installed yet' }
}

/** A failure that is expected (no network, port busy) rather than a bug. */
class WebServiceError extends Error {}

/** Run a command with argv only, capturing a little output for the reason line. */
async function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(new WebServiceError(`${command} could not start: ${(error as Error).message}`))
      return
    }
    let output = ''
    const collect = (chunk: Buffer): void => {
      // Keep a bounded window: enough for the actual error, not the whole log.
      output = `${output}${chunk.toString()}`.slice(-4000)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', error => {
      const code = (error as NodeJS.ErrnoException).code
      reject(new WebServiceError(code === 'ENOENT' ? `${command} is not installed` : `${command} failed: ${error.message}`))
    })
    child.on('close', code => resolve({ code: code ?? 1, output }))
  })
}

/** Last non-empty line of captured output, for a one-line reason. */
const lastLine = (output: string): string => {
  const lines = output.split('\n').map(line => line.trim()).filter(line => line !== '')
  return lines.at(-1)?.slice(0, 200) ?? ''
}

/** `python3` as `major*100+minor` (e.g. 311), or `undefined` when unusable. */
async function probePython(command: string): Promise<{ path: string; version: number } | undefined> {
  const probe = await run(command, ['-c', 'import sys; print("%d %d" % sys.version_info[:2])']).catch(() => undefined)
  if (probe === undefined || probe.code !== 0) return undefined
  const match = /^(\d+)\s+(\d+)/.exec(probe.output.trim())
  if (match === null) return undefined
  return { path: command, version: Number(match[1]) * 100 + Number(match[2]) }
}

/** One HTTP GET with a deadline; the socket is unref'd so it cannot pin a process. */
function requestOnce(
  target: URL,
  timeoutMs: number,
): Promise<{ status: number; location: string | undefined; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    const chunks: Buffer[] = []
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      reject(error)
    }
    let req: ReturnType<typeof httpRequest>
    try {
      req = send(target, { method: 'GET', headers: { 'user-agent': 'z1', accept: 'application/gzip' } })
    } catch (error) {
      fail(new WebServiceError(`download failed: ${(error as Error).message}`))
      return
    }
    // Unref'd: a one-shot that already printed its answer may exit mid-download.
    req.on('socket', socket => socket.unref())
    timer = setTimeout(() => {
      req.destroy()
      fail(new WebServiceError(`download timed out after ${String(Math.round(timeoutMs / 1000))} s`))
    }, timeoutMs)
    timer.unref?.()
    req.on('response', response => {
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('error', error => fail(new WebServiceError(`download failed: ${error.message}`)))
      response.on('end', () => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        const location = response.headers.location
        resolve({
          status: response.statusCode ?? 0,
          location: location === undefined ? undefined : location,
          body: Buffer.concat(chunks),
        })
      })
    })
    req.on('error', error => fail(new WebServiceError(`no network (${error.message})`)))
    req.end()
  })
}

/**
 * Download the pinned tarball to `dest`, verifying its SHA-256.
 *
 * Redirects are followed by hand rather than by `fetch`, because `fetch` has no
 * way to unref its socket: a pending download would keep a finished `--once`
 * process alive (the exact hang this module must not have). `sha256` and
 * `timeoutMs` are injectable so the tests can force a mismatch and a timeout
 * without the network.
 */
export async function downloadSource(
  url: string,
  dest: string,
  options: { sha256?: string; timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS
  const expected = options.sha256 ?? SEARXNG_TARBALL_SHA256
  let target: URL
  try {
    target = new URL(url)
  } catch {
    throw new WebServiceError(`download failed: not a URL (${url})`)
  }
  let body: Buffer | undefined
  for (let hop = 0; hop <= 5; hop += 1) {
    const result = await requestOnce(target, timeoutMs)
    if (result.status >= 300 && result.status < 400 && result.location !== undefined) {
      try {
        target = new URL(result.location, target)
      } catch {
        throw new WebServiceError(`download failed: bad redirect to ${result.location}`)
      }
      continue
    }
    if (result.status !== 200) throw new WebServiceError(`download failed (HTTP ${String(result.status)})`)
    body = result.body
    break
  }
  if (body === undefined) throw new WebServiceError('download failed (too many redirects)')
  const actual = createHash('sha256').update(body).digest('hex')
  // Checked before the size heuristic: the wrong bytes are the more useful
  // reason, and a truncated stream is a mismatch too.
  if (actual !== expected) {
    throw new WebServiceError(
      `download failed: checksum mismatch for the pinned source (expected ${expected}, got ${actual})`,
    )
  }
  // 6.5 MB is expected; anything wildly smaller is a proxy page, not a tarball.
  if (body.byteLength < 1_000_000) throw new WebServiceError('download failed (truncated tarball)')
  writeFileSync(dest, body, { mode: 0o600 })
  return actual
}

/**
 * Install once: source, venv, dependencies, settings, manifest.
 *
 * Every step is idempotent-safe because the whole install happens under
 * `install.lock` and a failure removes the source tree: a half-installed venv
 * must never look installed to the next start.
 */
async function install(paths: WebPaths, env: NodeJS.ProcessEnv, report: (line: string) => void): Promise<void> {
  // `takeLock` already created it; repeated here so the install owns every
  // directory it writes to, whatever called it.
  mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 })
  const tarball = join(paths.dataDir, '.searxng.tar.gz')
  const staging = join(paths.dataDir, '.extract')

  report('web · installing SearXNG (first run, ~120 MB)…')
  await downloadSource(SEARXNG_SOURCE_URL, tarball)

  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true, mode: 0o700 })
  const untar = await run('tar', ['-xzf', tarball, '-C', staging]).catch(error => {
    throw error instanceof WebServiceError ? error : new WebServiceError(`extract failed: ${(error as Error).message}`)
  })
  if (untar.code !== 0) throw new WebServiceError(`extract failed: ${lastLine(untar.output)}`)
  // The archive holds one `searxng-<sha>/` directory. `tar` already refuses
  // absolute member names and `..` on extraction, but the staging root is the
  // boundary this code relies on, so verify it instead of trusting `tar`: one
  // entry, the expected name, a real directory (not a symlink out of the tree).
  const entries = readdirSync(staging)
  const inner = entries.find(name => /^searxng-[0-9a-f]{7,40}$/.test(name))
  if (entries.length !== 1 || inner === undefined || !lstatSync(join(staging, inner)).isDirectory()) {
    throw new WebServiceError(`extract failed: unexpected archive layout (${entries.slice(0, 3).join(', ')})`)
  }
  rmSync(paths.srcDir, { recursive: true, force: true })
  renameSync(join(staging, inner), paths.srcDir)
  rmSync(staging, { recursive: true, force: true })
  rmSync(tarball, { force: true })

  // `uv venv` is the only venv creator used: it also fetches a managed Python
  // when the system one is too old, which `python3 -m venv` cannot do.
  const system = await probePython(env['Z1_PYTHON'] ?? 'python3')
  const useSystem = system !== undefined && system.version >= MIN_PYTHON
  const venvArgs = useSystem
    ? ['venv', '--python', system.path, paths.venvDir]
    : ['venv', '--python', '3.12', paths.venvDir]
  const venv = await run('uv', venvArgs, { env }).catch(error => {
    throw error instanceof WebServiceError ? error : new WebServiceError(`venv failed: ${(error as Error).message}`)
  })
  if (venv.code !== 0) {
    throw new WebServiceError(
      useSystem
        ? `venv failed: ${lastLine(venv.output)}`
        : `python too old (${system === undefined ? 'python3 not found' : String(system.version)}) and uv could not fetch 3.12: ${lastLine(venv.output)}`,
    )
  }

  // `-r requirements.txt` rather than installing the package: the app runs
  // from the source tree, so its static files and templates are the ones the
  // pinned commit shipped, not a wheel's copy.
  const requirements = join(paths.srcDir, 'requirements.txt')
  if (!existsSync(requirements)) throw new WebServiceError('install failed: requirements.txt missing from the tarball')
  const pip = await run(
    'uv',
    ['pip', 'install', '--python', paths.python, '-r', requirements, 'waitress'],
    { env },
  )
  if (pip.code !== 0) throw new WebServiceError(`install failed: ${lastLine(pip.output)}`)

  const secret = generateSecret()
  writeFileSync(
    paths.settingsFile,
    renderSettings(readFileSync(paths.templateFile, 'utf8'), secret),
    { mode: 0o600 },
  )
  chmodSync(paths.settingsFile, 0o600)

  const manifest: InstallManifest = {
    sha: SEARXNG_SHA,
    sourceUrl: SEARXNG_SOURCE_URL,
    python: paths.python,
    installedAt: new Date().toISOString(),
    server: 'waitress',
  }
  writeFileSync(paths.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
}

/** Resolve after `pid` exits or `timeoutMs` passes; true when it exited. */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await sleep(100)
  }
  return !isProcessAlive(pid)
}

/**
 * Serialize installs between z1 processes; the loser waits for the winner.
 *
 * The lock file lives in `dataDir`, which does not exist on a first run — and
 * `install()`, the thing that creates it, only runs *under* this lock. So the
 * directory is created here, before the first `open`: this is the one place
 * that handles a missing parent. (An ENOENT therefore means the parent was
 * removed underneath us, which is a real error, not "someone else holds it".)
 *
 * Only `EEXIST` means "held": a permission problem is a failure to report, not
 * a lock to wait out. A lock left by a crashed run is stale when its owner pid
 * is gone. A **live** owner always means held, however old the file looks: the
 * holder may legitimately own it for minutes (a first install, a 60 s readiness
 * wait), and mtime is only consulted when the pid could not be read at all.
 */
export function takeLock(paths: WebPaths): (() => void) | undefined {
  try {
    mkdirSync(dirname(paths.lockFile), { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new WebServiceError(`install lock failed: ${(error as Error).message}`)
  }

  const claim = (): (() => void) | undefined => {
    let fd: number
    try {
      fd = openSync(paths.lockFile, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined
      throw new WebServiceError(`install lock failed: ${(error as Error).message}`)
    }
    writeFileSync(fd, String(process.pid))
    closeSync(fd)
    return () => rmSync(paths.lockFile, { force: true })
  }

  const mine = claim()
  if (mine !== undefined) return mine

  const owner = readPid(paths.lockFile)
  // A live owner is held, no matter how old the file is. A dead pid is stale at
  // once. An unreadable owner (a half-written file, a corrupt one) is only
  // stale once it is older than any install could take.
  const stale = owner === undefined ? Date.now() - mtime(paths.lockFile) > 10 * 60_000 : !isProcessAlive(owner)
  if (!stale) return undefined
  rmSync(paths.lockFile, { force: true })
  // A racing process may have re-created it first: losing that race is normal.
  return claim()
}

const mtime = (file: string): number => {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Keep `searxng.log` bounded: waitress runs for weeks and never rotates.
 *
 * Above `maxBytes` the current log becomes `searxng.log.1` (overwriting the old
 * one — one generation is enough to explain a failed start) and a new log
 * starts empty. POSIX `rename` replaces the target; Windows refuses, so the
 * previous `.1` is removed first. If the move fails (a read-only directory) the
 * file is truncated instead; if even that fails, the caller appends as before.
 * Returns true when the log was rotated or truncated.
 */
export function rotateLog(logFile: string, maxBytes: number = LOG_MAX_BYTES): boolean {
  let size: number
  try {
    size = statSync(logFile).size
  } catch {
    return false
  }
  if (size <= maxBytes) return false
  try {
    rmSync(`${logFile}.1`, { force: true })
    renameSync(logFile, `${logFile}.1`)
    return true
  } catch {
    try {
      writeFileSync(logFile, '', { mode: 0o600 })
      return true
    } catch {
      return false
    }
  }
}

/** True when something else already listens on `127.0.0.1:port`. */
function portInUse(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer()
    server.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code === 'EADDRINUSE')
    })
    server.once('listening', () => server.close(() => resolve(false)))
    server.listen({ host: '127.0.0.1', port, exclusive: true })
  })
}

/**
 * Spawn waitress detached: it outlives z1 so the next start is instant, and
 * its stdio goes straight to the log file (never a pipe someone must read).
 *
 * Resolving only on the child's `spawn` event matters: a missing or
 * non-executable interpreter is reported asynchronously, and an unhandled
 * `error` event would take the whole CLI down instead of producing a status.
 *
 * The pid is recorded together with the kernel's start marker and the command
 * line we are about to run, because neither the pid file nor the pid itself is
 * an identity: see the module header.
 */
async function startServer(paths: WebPaths, env: NodeJS.ProcessEnv, port: number): Promise<ServerRecord> {
  // A log that grew past the cap is rotated before the new process appends to
  // it: waitress holds the descriptor for its whole life, so this is the only
  // moment the file can be replaced.
  rotateLog(paths.logFile)
  const logFd = openSync(paths.logFile, 'a', 0o600)
  chmodSync(paths.logFile, 0o600)
  const args = [
    '-m',
    'waitress',
    `--listen=127.0.0.1:${String(port)}`,
    '--threads=8',
    '--channel-timeout=300',
    'searx.webapp:app',
  ]
  let child
  try {
    child = spawn(paths.python, args, {
      cwd: paths.srcDir,
      // The rendered settings are outside the source tree on purpose: an
      // upgrade re-extracts `src/` and must not overwrite the secret.
      env: { ...env, SEARXNG_SETTINGS_PATH: paths.settingsFile },
      detached: true,
      stdio: ['ignore', logFd, logFd],
    })
  } finally {
    // The child holds its own descriptor now.
    closeSync(logFd)
  }
  await new Promise<void>((resolve, reject) => {
    child.once('error', (error: Error) => {
      reject(new WebServiceError(`searxng did not start: ${error.message}`))
    })
    child.once('spawn', () => resolve())
  })
  if (child.pid === undefined) throw new WebServiceError('searxng did not start')
  child.unref()
  // Read the identity now, while this is certainly the process we spawned. A
  // brief retry covers the instant between `spawn` and a readable cmdline.
  let identity = await processIdentity(child.pid)
  for (let attempt = 0; attempt < 5 && (identity === undefined || identity.command === ''); attempt += 1) {
    await sleep(50)
    identity = await processIdentity(child.pid)
  }
  const record: ServerRecord = {
    pid: child.pid,
    startedAt: identity?.startedAt ?? '',
    port,
    command: identity?.command ?? args.join(' '),
  }
  writeServerRecord(paths, record)
  return record
}

/** The port the local backend should bind: the one in the default URL. */
function managedPort(url: string): number {
  try {
    const parsed = new URL(url)
    return parsed.port === '' ? 80 : Number(parsed.port)
  } catch {
    return SEARX_PORT
  }
}

/** Options for `ensureWebSearch`. */
export interface EnsureOptions {
  env?: NodeJS.ProcessEnv
  /**
   * Called with at most two plain lines: install progress, and the failure
   * reason. Never carries ANSI — the caller decides how to dim or prefix it.
   */
  onLine?: (line: string) => void
  /** Readiness budget; shortened by tests. */
  timeoutMs?: number
  /**
   * Override the managed backend URL. Tests point this at a dead ephemeral port
   * for the same reason `webSearchStatus` takes one: a real backend on 8888 must
   * never decide a unit test.
   */
  url?: string
  /** Identity source for adoption/verification; defaults to the kernel. */
  identity?: IdentityReader
}

/** The phase a fresh run publishes before it awaits anything. */
export function initialSearxPhase(installed: boolean): SearxPhase {
  return installed ? 'starting' : 'installing'
}

let inFlight: Promise<WebStatus> | undefined

/**
 * Make the backend ready, in the background. Idempotent and safe to call from
 * every entry point: a healthy instance is one HTTP request and no output.
 *
 * Order of checks matters — an external URL means the settings and the pid file
 * are irrelevant, a live pid means wait rather than start a second server, and
 * only an absent install pays the download.
 */
export async function ensureWebSearch(options: EnsureOptions = {}): Promise<WebStatus> {
  const env = options.env ?? process.env
  const report = options.onLine ?? ((): void => {})
  const url = options.url ?? searxUrl(env)
  const paths = resolveWebPaths(env)
  const read = options.identity ?? processIdentity
  const port = managedPort(url)

  if (isExternallyManaged(env)) {
    // `Z1_SEARX_URL` means the user owns the backend: z1 never installs,
    // starts or stops it, so the provisioning hint stays unset and the module's
    // own `/healthz` probe is the authority.
    return { state: 'external', managed: false, url, dataDir: paths.dataDir, detail: 'configured by Z1_SEARX_URL', installed: false }
  }
  if (!autostartEnabled(env)) {
    // No probe here on purpose: the off switch is a per-session decision, and a
    // status built from a live backend would be a different (managed) answer.
    return {
      state: 'disabled',
      managed: true,
      url,
      dataDir: paths.dataDir,
      detail: 'autostart off (Z1_WEB_AUTOSTART=off)',
      installed: isInstalled(paths),
    }
  }
  // One attempt per process; a second caller joins the first.
  if (inFlight !== undefined) return inFlight

  // Published synchronously, before the first await: z1 fires this in the
  // background and a module worker it spawns a moment later reads the
  // environment, so "coming up" must already be there instead of "down".
  publishSearxState(env, initialSearxPhase(isInstalled(paths)))

  inFlight = (async (): Promise<WebStatus> => {
    const failed = async (detail: string): Promise<WebStatus> => {
      // Every exit from here publishes a terminal phase, so a crash-free run
      // never leaves a `starting:` for the module's 20-minute window.
      publishSearxState(env, 'down', detail)
      report(`web · ${detail}`)
      return { state: 'failed', managed: true, url, dataDir: paths.dataDir, detail, installed: isInstalled(paths) }
    }
    /** Poll `/healthz`, refreshing the `starting` timestamp each attempt. */
    const waitReady = async (phase: SearxPhase): Promise<boolean> =>
      waitForHealth({
        url,
        timeoutMs: options.timeoutMs,
        // Unref'd: this poll runs in the background while a one-shot answers,
        // and a finished one-shot must not wait out the readiness budget.
        unref: true,
        check: async target => {
          publishSearxState(env, phase)
          return checkHealth(target)
        },
      })

    try {
      if (process.getuid?.() === 0) return await failed('not starting SearXNG as root')

      const healthy = await checkHealth(url)
      if (healthy) {
        // Healthy, but is it ours? A listener on the port with no matching
        // identity was started by something else (an older z1, a manual run, a
        // deleted identity file). An older z1's plain pid file is adopted when
        // its command line verifies; anything else is merely used, not claimed.
        const record = await effectiveRecord(paths, port, read)
        const ours = record !== undefined && identityMatches(record, await read(record.pid))
        publishSearxState(env, 'up')
        // No line for an unmanaged listener on purpose: a legacy backend is a
        // normal state, and printing it on every launch is noise. The returned
        // status carries the detail (`z1 web status`), and `stop` still says so
        // when asked to stop what it cannot verify.
        return {
          state: 'ready',
          managed: true,
          url,
          dataDir: paths.dataDir,
          ...(ours ? { pid: record.pid } : {}),
          detail: ours ? `ready at ${url}` : `SearXNG is answering on ${url} but was not started by this z1`,
          installed: isInstalled(paths),
        }
      }

      // Not answering: a *verified* live process is a start in progress (or a
      // wedged one), so wait for it instead of racing a second bind. A live pid
      // whose command line is not this SearXNG is a recycled pid: drop the
      // record and start, rather than burning the whole readiness budget on a
      // process that will never answer for us. A legacy pid file is adopted
      // first, so an older z1's slow start is waited for, not duplicated.
      const record = await effectiveRecord(paths, port, read)
      if (record !== undefined && isProcessAlive(record.pid) && identityMatches(record, await read(record.pid))) {
        if (await waitReady('starting')) {
          publishSearxState(env, 'up')
          return { state: 'ready', managed: true, url, dataDir: paths.dataDir, pid: record.pid, detail: `ready at ${url}`, installed: isInstalled(paths) }
        }
        return await failed(`pid ${String(record.pid)} is running but not answering ${HEALTH_PATH}`)
      }
      // Dead, recycled, or a bare pid file from a build that had no identity:
      // clean up so `starting` cannot be reported forever.
      clearServerRecord(paths)

      // The install lock covers the *start* as well: from here until health (or
      // failure) only one z1 in the machine may spawn a waitress, and the loser
      // waits for the winner's port instead of racing a second bind into
      // EADDRINUSE. A live lock owner is always held, however long the install
      // takes.
      const installedBefore = isInstalled(paths)
      const release = takeLock(paths)
      if (release === undefined) {
        // Another z1 is installing or starting: give it the same budget.
        if (await waitReady(installedBefore ? 'starting' : 'installing')) {
          publishSearxState(env, 'up')
          return { state: 'ready', managed: true, url, dataDir: paths.dataDir, detail: `ready at ${url}`, installed: isInstalled(paths) }
        }
        return await failed(installedBefore ? 'another z1 is starting SearXNG' : 'another z1 is installing SearXNG')
      }
      let started = false
      try {
        // Only an absent install pays the download; either way the sync hint
        // above already said "coming up".
        if (!installedBefore) {
          await install(paths, env, report)
          started = true
        }

        if (await portInUse(port)) {
          return await failed(`port ${String(port)} is in use by another program`)
        }
        publishSearxState(env, 'starting')
        let record: ServerRecord
        try {
          record = await startServer(paths, env, port)
        } catch (error) {
          return await failed((error as Error).message)
        }
        // Nothing this process spawned is left behind unrecorded, even when the
        // wait below times out: `stop` can then verify and signal it.
        if (!(await waitReady('starting'))) {
          return await failed(`backend did not answer ${HEALTH_PATH} in ${String(Math.round((options.timeoutMs ?? READY_TIMEOUT_MS) / 1000))} s (log: ${paths.logFile})`)
        }
        publishSearxState(env, 'up')
        if (started) report('web · ready')
        return { state: 'ready', managed: true, url, dataDir: paths.dataDir, pid: record.pid, detail: `ready at ${url}`, installed: true }
      } finally {
        release()
      }
    } catch (error) {
      // Expected failures carry their own line; anything else is a bug in this
      // module but must still not take the CLI down with it.
      const detail = error instanceof WebServiceError ? error.message : `unexpected error: ${(error as Error).message}`
      return await failed(detail)
    }
  })()

  try {
    return await inFlight
  } finally {
    inFlight = undefined
  }
}

/** Options for `stopWebSearch`; the URL is injectable for the same reason as `webSearchStatus`. */
export interface StopOptions {
  /** Health target; defaults to `searxUrl(env)`. Tests point it at a closed port. */
  url?: string
  /** How long SIGTERM gets before SIGKILL; shortened in tests. */
  graceMs?: number
  /** Identity source for adoption/verification; defaults to the kernel. */
  identity?: IdentityReader
}

/**
 * Stop the backend z1 started. Leaves an external instance alone, and leaves
 * the install in place: the next start only pays the spawn, not the download.
 *
 * Nothing is signalled unless the recorded identity still matches the pid: a
 * recycled pid belongs to an unrelated program, and killing it is worse than
 * leaving a listener running. A pid file left by a build that had no identity
 * file is adopted first, under the same check, so the backend a legacy z1
 * started is stoppable instead of permanently a stranger. When z1 cannot verify
 * the process it says so and removes only its own record — a listener it never
 * started is not its to stop.
 */
export async function stopWebSearch(env: NodeJS.ProcessEnv = process.env, options: StopOptions = {}): Promise<WebStatus> {
  const paths = resolveWebPaths(env)
  const url = options.url ?? searxUrl(env)
  const graceMs = options.graceMs ?? 5000
  const read = options.identity ?? processIdentity
  // z1 is no longer provisioning anything: drop the hint rather than claim a
  // phase the module would believe for 20 minutes.
  delete env[SEARX_STATE_ENV]
  if (isExternallyManaged(env)) {
    return { state: 'external', managed: false, url, dataDir: paths.dataDir, detail: 'not managed by z1', installed: false }
  }

  const record = readServerRecord(paths) ?? (await adoptLegacyRecord(paths, managedPort(url), { identity: read }))
  if (record === undefined) {
    // Either nothing ran, or the record was deleted while the listener kept
    // going. When adoption above could not verify the plain pid file, the
    // second case is not ours to kill: only a verified record says what we
    // started, and a bare pid is not an identity.
    const legacy = readPid(paths.pidFile)
    clearServerRecord(paths)
    if (await checkHealth(url)) {
      return {
        state: 'ready',
        managed: true,
        url,
        dataDir: paths.dataDir,
        detail: `SearXNG is answering on ${url} but was not started by this z1; not stopping it`,
        installed: isInstalled(paths),
      }
    }
    return {
      state: 'stopped',
      managed: true,
      url,
      dataDir: paths.dataDir,
      detail: legacy === undefined ? 'was not running' : `pid ${String(legacy)} has no recorded identity; nothing was signalled`,
      installed: isInstalled(paths),
    }
  }

  const current = await read(record.pid)
  if (!identityMatches(record, current)) {
    clearServerRecord(paths)
    if (await checkHealth(url)) {
      return {
        state: 'ready',
        managed: true,
        url,
        dataDir: paths.dataDir,
        detail: `SearXNG is answering on ${url} but was not started by this z1; not stopping it`,
        installed: isInstalled(paths),
      }
    }
    return {
      state: 'stopped',
      managed: true,
      url,
      dataDir: paths.dataDir,
      detail: `refusing to signal pid ${String(record.pid)}: it is not this SearXNG`,
      installed: isInstalled(paths),
    }
  }

  const pid = record.pid
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // Gone between the check and the signal; the record is still stale.
  }
  // SIGKILL only for the same verified process: the pid could have been reused
  // during the grace period, and an unrelated program must not be killed for
  // something we merely used to own.
  if (!(await waitForExit(pid, graceMs))) {
    if (identityMatches(record, await read(pid))) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Same race, nothing left to do.
      }
      await waitForExit(pid, 2000)
    }
  }
  clearServerRecord(paths)
  return {
    state: 'stopped',
    managed: true,
    url,
    dataDir: paths.dataDir,
    detail: `stopped pid ${String(pid)}`,
    installed: isInstalled(paths),
  }
}

/** Last lines of the log, for a failure report the user can act on. */
export function readLogTail(paths: WebPaths, lines = 8): string {
  try {
    const text = readFileSync(paths.logFile, 'utf8').trimEnd()
    return text.split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}
