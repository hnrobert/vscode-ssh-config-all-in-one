import type { Disposable, Event, OutputChannel, QuickPickItem, Uri } from 'vscode'
import type { SSHExplorerProvider } from './explorer'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { commands, EventEmitter, window, workspace } from 'vscode'
import { parseSSHConfig } from '../utils/sshConfig'

/** `local` = ssh -L (listen locally, forward into the remote network). */
export type ForwardDirection = 'local' | 'remote'

export type ForwardStatus = 'stopped' | 'starting' | 'running' | 'error'

export interface PortForwardRule {
  hostName: string
  direction: ForwardDirection
  /** Port the tunnel listens on (-L: this machine; -R: the remote machine). */
  listenPort: number
  /** Destination host of the forwarded traffic, resolved on the other machine. */
  destHost: string
  /** Destination port of the forwarded traffic. */
  destPort: number
}

/** A rule merged with its runtime state, as consumed by the SSH Tunnels panel. */
export interface ForwardViewRow extends PortForwardRule {
  id: string
  status: ForwardStatus
  message: string | undefined
}

interface Entry {
  status: ForwardStatus
  message: string | undefined
  graceTimer: ReturnType<typeof setTimeout> | undefined
  startedAt: number
  /** Pid of the launcher this window spawned (until the record appears). */
  launcherPid?: number
  /** How the spawned launcher ended, for precise failure reporting. */
  launcherExit?: string
}

interface TunnelRecord {
  id: string
  pid: number
  startedAt: number
  launcherPid?: number
  /** Retry attempt the launcher is currently on (0 = first try). */
  attempts?: number
  /** Set by the launcher after the tunnel gave up retrying. */
  dead?: boolean
}

const CONFIG_KEY = 'portForwards'
const MAX_ATTEMPTS = 3
const VERIFY_DELAY_MS = 2500
const VERIFY_RETRY_MS = 3500
const START_TIMEOUT_MS = 8000
/** A slow launcher (cold helper spawn) is tolerated up to this bound. */
const LAUNCHER_TIMEOUT_MS = 15000
const SYNC_INTERVAL_MS = 5000

export function forwardId(rule: PortForwardRule): string {
  return `${rule.direction}://${rule.listenPort}=>${rule.hostName}:${rule.destHost}:${rule.destPort}`
}

function normalizeRule(raw: unknown): PortForwardRule | undefined {
  if (typeof raw !== 'object' || raw === null)
    return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.hostName !== 'string' || !r.hostName.trim())
    return undefined
  if (r.direction !== 'local' && r.direction !== 'remote')
    return undefined

  let listenPort: unknown
  let destPort: unknown
  let destHost: unknown
  if (r.listenPort !== undefined) {
    listenPort = r.listenPort
    destPort = r.destPort
    destHost = r.destHost
  }
  else {
    // Legacy shape: the address fields doubled as bind address (listen side)
    // and destination host (destination side), swapped by direction.
    listenPort = r.direction === 'local' ? r.localPort : r.remotePort
    destPort = r.direction === 'local' ? r.remotePort : r.localPort
    destHost = r.direction === 'local' ? r.remoteAddress : r.localAddress
  }
  const listen = Number(listenPort)
  const dest = Number(destPort)
  if (!Number.isInteger(listen) || listen < 1 || listen > 65535)
    return undefined
  if (!Number.isInteger(dest) || dest < 1 || dest > 65535)
    return undefined
  return {
    hostName: r.hostName.trim(),
    direction: r.direction,
    listenPort: listen,
    destHost: typeof destHost === 'string' && destHost.trim() ? destHost.trim() : 'localhost',
    destPort: dest,
  }
}

function readRules(): PortForwardRule[] {
  const raw = workspace.getConfiguration('sshConfigAllInOne').get<unknown[]>(CONFIG_KEY, [])
  return (Array.isArray(raw) ? raw : []).map(normalizeRule).filter((r): r is PortForwardRule => r !== undefined)
}

async function writeRules(rules: PortForwardRule[]): Promise<void> {
  await workspace.getConfiguration('sshConfigAllInOne').update(CONFIG_KEY, rules, true)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

/**
 * Keeps persistent `ssh -N -L/-R` tunnels alive for configured port forward
 * rules, restarting crashed tunnels up to {@link MAX_ATTEMPTS} times.
 *
 * Tunnels follow the VS Code application process, not the window: ssh is
 * spawned detached (surviving Reload Window and window closes), every tunnel
 * gets a record file in the extension's shared global storage so all windows
 * see and control the same set, and a small watchdog kills the tunnels when
 * the VS Code main process exits.
 */
export class PortForwardManager implements Disposable {
  private readonly entries = new Map<string, Entry>()
  private readonly _onDidChange = new EventEmitter<void>()
  private readonly configListener: Disposable
  private readonly syncTimer: ReturnType<typeof setInterval>
  private readonly channel: OutputChannel = window.createOutputChannel('SSH Tunnels')
  private readonly tunnelsDir: string
  private readonly logsDir: string

  constructor(
    private readonly provider: SSHExplorerProvider,
    storageDir: string,
    private readonly extensionUri: Uri,
  ) {
    const stateDir = join(storageDir, 'sshTunnels')
    this.tunnelsDir = join(stateDir, 'tunnels')
    this.logsDir = join(stateDir, 'logs')
    try {
      mkdirSync(this.tunnelsDir, { recursive: true })
      mkdirSync(this.logsDir, { recursive: true })
    }
    catch { /* read-only storage: in-memory operation only */ }

    this.configListener = workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sshConfigAllInOne.portForwards')) {
        this.syncWithSettings()
        this._onDidChange.fire()
      }
    })

    this.syncFromDisk()
    this._onDidChange.fire()
    this.syncTimer = setInterval(() => {
      this.syncFromDisk()
    }, SYNC_INTERVAL_MS)

    this.spawnWatchdog()
  }

  get onDidChange(): Event<void> {
    return this._onDidChange.event
  }

  getRules(): PortForwardRule[] {
    return readRules()
  }

  getViewRows(): ForwardViewRow[] {
    return readRules().map((rule) => {
      const id = forwardId(rule)
      const entry = this.entries.get(id)
      return { ...rule, id, status: entry?.status ?? 'stopped', message: entry?.message }
    })
  }

  isActive(id: string): boolean {
    const entry = this.entries.get(id)
    return !!entry && (entry.status === 'running' || entry.status === 'starting')
  }

  toggle(id: string): void {
    if (this.isActive(id))
      this.stop(id)
    else
      void this.start(id)
  }

  async start(id: string): Promise<void> {
    const rule = this.findRule(id)
    if (!rule)
      return
    const previous = this.entries.get(id)
    if (previous?.graceTimer)
      clearTimeout(previous.graceTimer)
    this.killRecorded(id)

    let args: string[]
    try {
      args = await this.buildArgs(rule)
    }
    catch (err) {
      const message = `Failed to resolve SSH arguments: ${errorMessage(err)}`
      this.entries.set(id, { status: 'error', message, graceTimer: undefined, startedAt: Date.now() })
      this.log(`error ${id}: ${message}`)
      this._onDidChange.fire()
      return
    }

    const entry: Entry = { status: 'starting', message: undefined, graceTimer: undefined, startedAt: Date.now() }
    this.entries.set(id, entry)
    try {
      // The launcher daemonizes ssh (double detach) so the tunnel escapes
      // the extension host's process tree — VS Code kills that tree on
      // Reload Window — and owns retries + the on-disk record. Its stderr
      // is captured into the tunnel log so a launcher crash is diagnosable.
      let launcherStderr: number | 'ignore' = 'ignore'
      try {
        launcherStderr = openSync(this.logPath(id), 'a')
      }
      catch { /* log unavailable */ }
      const launcher = spawn(
        process.execPath,
        [
          join(this.extensionUri.fsPath, 'media', 'sshTunnels', 'launcher.js'),
          this.tunnelsDir,
          this.safeName(id),
          id,
          this.logPath(id),
          ...args,
        ],
        {
          detached: true,
          stdio: ['ignore', 'ignore', launcherStderr],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          windowsHide: true,
        },
      )
      if (typeof launcherStderr === 'number')
        closeSync(launcherStderr)
      launcher.unref()
      if (launcher.pid)
        entry.launcherPid = launcher.pid
      launcher.on('error', (err) => {
        entry.launcherExit = `spawn error: ${err.message}`
      })
      launcher.on('exit', (code, signal) => {
        if (!entry.launcherExit)
          entry.launcherExit = `exited code=${code ?? 'none'}${signal ? ` signal=${signal}` : ''}`
      })
    }
    catch (err) {
      entry.status = 'error'
      entry.message = `Failed to spawn tunnel launcher: ${errorMessage(err)}`
      this.log(`error ${id}: ${entry.message}`)
      this._onDidChange.fire()
      this.notifyFailure(id, entry.message)
      return
    }

    this.log(`start ${id}: ssh ${args.join(' ')}`)

    // Verify the forward after start: check stderr for complaints about OUR
    // forward (ssh runs without ExitOnForwardFailure, see buildArgs) and
    // confirm a live tunnel record exists. A second, final check keeps a
    // slow launcher from being declared dead too early; a legitimate retry
    // (launcher alive) is never failed here.
    const check = (final: boolean) => {
      entry.graceTimer = undefined
      if (this.entries.get(id) !== entry)
        return
      const detail = this.forwardFailureDetail(rule, this.readTail(id))
      if (detail) {
        this.log(`error ${id}: ${detail}`)
        this.killRecorded(id)
        this.entries.delete(id)
        this._onDidChange.fire()
        this.notifyFailure(id, detail)
        return
      }
      const record = this.readRecord(id)
      if (record && pidAlive(record.pid)) {
        entry.status = 'running'
        entry.message = undefined
        this._onDidChange.fire()
        return
      }
      if (!final) {
        entry.graceTimer = setTimeout(check, VERIFY_RETRY_MS, true)
        return
      }
      // A live launcher means the tunnel is still being set up (cold helper
      // spawn) or retried — never declare it dead from this check alone.
      const launcherAlive = (entry.launcherPid != null && pidAlive(entry.launcherPid))
        || (record != null && pidAlive(record.launcherPid ?? -1))
      if (!launcherAlive) {
        const message = this.tunnelFailureDetail(id, entry, record)
        this.log(`error ${id}: ${message}`)
        this.killRecorded(id)
        this.entries.delete(id)
        this._onDidChange.fire()
        this.notifyFailure(id, message)
      }
    }
    entry.graceTimer = setTimeout(check, VERIFY_DELAY_MS, false)
    this._onDidChange.fire()
  }

  stop(id: string): void {
    const entry = this.entries.get(id)
    if (entry?.graceTimer)
      clearTimeout(entry.graceTimer)
    this.killRecorded(id)
    this.entries.delete(id)
    this.log(`stop ${id}`)
    this._onDidChange.fire()
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.entries.keys()])
      this.stop(id)
  }

  /** Adds a rule to the settings. Returns its id, or undefined on invalid input. */
  async addRule(rule: PortForwardRule, autoStart = true): Promise<string | undefined> {
    const normalized = normalizeRule(rule)
    if (!normalized)
      return undefined
    const rules = readRules()
    const id = forwardId(normalized)
    if (rules.some(r => forwardId(r) === id)) {
      window.showWarningMessage('This port forward already exists.')
      return undefined
    }
    await writeRules([...rules, normalized])
    this._onDidChange.fire()
    if (autoStart)
      await this.start(id)
    return id
  }

  /** Applies a patch; a running tunnel is restarted with the new arguments. */
  async updateRule(id: string, patch: Partial<PortForwardRule>): Promise<void> {
    const rules = readRules()
    const idx = rules.findIndex(r => forwardId(r) === id)
    if (idx === -1)
      return
    const updated = normalizeRule({ ...rules[idx], ...patch })
    if (!updated)
      return
    const wasActive = this.isActive(id)
    this.stop(id)
    const next = [...rules]
    next[idx] = updated
    await writeRules(next)
    this._onDidChange.fire()
    if (wasActive)
      await this.start(forwardId(updated))
  }

  async removeRule(id: string): Promise<void> {
    this.stop(id)
    await writeRules(readRules().filter(r => forwardId(r) !== id))
    this._onDidChange.fire()
  }

  async toggleDirection(id: string): Promise<void> {
    const rule = this.findRule(id)
    if (rule)
      await this.updateRule(id, { direction: rule.direction === 'local' ? 'remote' : 'local' })
  }

  async changeHost(id: string, hostName: string): Promise<void> {
    await this.updateRule(id, { hostName })
  }

  findRule(id: string): PortForwardRule | undefined {
    return readRules().find(r => forwardId(r) === id)
  }

  /**
   * Tunnels outlive this window by design (they follow the application
   * process via the watchdog), so dispose only releases local listeners.
   */
  dispose(): void {
    clearInterval(this.syncTimer)
    for (const entry of this.entries.values()) {
      if (entry.graceTimer)
        clearTimeout(entry.graceTimer)
    }
    this.configListener.dispose()
    this.channel.dispose()
    this._onDidChange.dispose()
  }

  /** Everything lands in the "SSH Tunnels" output channel so failures are diagnosable. */
  private log(message: string): void {
    this.channel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`)
  }

  /**
   * Detects ssh's stderr complaints about OUR forward — not the host's own
   * config-declared forwards: a local listener that could not bind, or a
   * remote listener the server refused. Returns the message, or undefined.
   */
  private forwardFailureDetail(rule: PortForwardRule, tail: string): string | undefined {
    if (!tail)
      return undefined
    const lines = tail.split('\n')
    const localPattern = new RegExp(
      `cannot listen to port: ${rule.listenPort}\\b|bind \\[[^\\]]+\\]:${rule.listenPort}: Address already in use`,
    )
    const remotePattern = new RegExp(
      `forwarding failed for listen port ${rule.listenPort}\\b|remote forward failure for: listen ${rule.listenPort}\\b`,
    )
    const idx = lines.findIndex(l => localPattern.test(l) || remotePattern.test(l))
    if (idx === -1)
      return undefined
    const bind = idx > 0 && lines[idx - 1].trim().startsWith('bind [')
      ? `${lines[idx - 1].trim()} — `
      : ''
    return bind + lines[idx].trim()
  }

  /**
   * Builds a complete, single-line reason for a failed start: record state,
   * launcher liveness and the first meaningful ssh stderr line.
   */
  /** The most informative log line: an ssh error if present, else the launcher's last note. */
  private diagnosticLine(id: string): string {
    const lines = this.readTail(id).split('\n').map(l => l.trim()).filter(l => l.length > 0)
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].startsWith('[launcher'))
        return lines[i]
    }
    return lines[lines.length - 1] ?? ''
  }

  private tunnelFailureDetail(id: string, entry: Entry, record: TunnelRecord | undefined): string {
    const diag = this.diagnosticLine(id)
    const suffix = diag ? `: ${diag}` : ' with no output'
    if (!record) {
      const launcherAlive = entry.launcherPid != null && pidAlive(entry.launcherPid)
      if (launcherAlive)
        return `launcher is running but the tunnel never came up${diag ? ` (last: ${diag})` : ''}`
      const exit = entry.launcherExit ? ` (${entry.launcherExit})` : ''
      return `tunnel did not start — the launcher exited early${exit}${suffix}`
    }
    if (record.dead)
      return `gave up after ${MAX_ATTEMPTS} attempts${suffix}`
    const launcherState = pidAlive(record.launcherPid ?? -1) ? 'launcher alive' : 'launcher exited'
    return `ssh exited before the tunnel came up (${launcherState}, record pid ${record.pid})${suffix}`
  }

  /** Surfaces a tunnel failure as a bottom-right notification. */
  private notifyFailure(id: string, detail: string): void {
    const rule = this.findRule(id)
    const where = rule ? ` on ${rule.hostName}` : ''
    void window
      .showErrorMessage(`SSH tunnel${where} failed: ${detail}`, 'Show Output')
      .then((choice) => {
        if (choice === 'Show Output')
          this.channel.show()
      })
  }

  private safeName(id: string): string {
    return createHash('sha1').update(id).digest('hex').slice(0, 16)
  }

  private recordPath(id: string): string {
    return join(this.tunnelsDir, `${this.safeName(id)}.json`)
  }

  private logPath(id: string): string {
    return join(this.logsDir, `${this.safeName(id)}.log`)
  }

  private readRecord(id: string): TunnelRecord | undefined {
    try {
      return JSON.parse(readFileSync(this.recordPath(id), 'utf8')) as TunnelRecord
    }
    catch {
      return undefined
    }
  }

  private readTail(id: string): string {
    try {
      return readFileSync(this.logPath(id), 'utf8').trim().slice(-800)
    }
    catch {
      return ''
    }
  }

  /** Kills the recorded processes for `id` (possibly owned by another window) and drops the record. */
  private killRecorded(id: string): void {
    const record = this.readRecord(id)
    if (!record)
      return
    // Kill the launcher first so a pending retry cannot respawn the tunnel
    // after we kill the current ssh (which would leave an untracked orphan).
    if (record.launcherPid && pidAlive(record.launcherPid)) {
      try {
        process.kill(record.launcherPid)
      }
      catch { /* already gone */ }
    }
    if (record.pid > 0 && !record.dead) {
      try {
        process.kill(record.pid)
      }
      catch { /* already gone */ }
    }
    rmSync(this.recordPath(id), { force: true })
  }

  /**
   * `ssh -N [-F config] -L/-R ... host` — mirrors what VS Code Remote-SSH
   * tunnels do: no shell, detect dead connections via keepalives.
   *
   * Deliberately no `ExitOnForwardFailure=yes`: the host's ssh_config may
   * declare its own forwards (e.g. `RemoteForward 1080 ...` for a proxy),
   * and one of those failing must not kill our dedicated tunnel process.
   * Our own forward is verified from stderr after start instead.
   */
  private async buildArgs(rule: PortForwardRule): Promise<string[]> {
    const args = [
      '-N',
      // DEBUG1 verbosity: without it ssh stays SILENT when a remote forward
      // fails to bind (no ExitOnForwardFailure), which would leave a broken
      // tunnel looking healthy. The forward success/failure lines in the
      // tunnel log are what the start/adopt verification matches against.
      '-v',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=4',
    ]

    const configFile = await this.resolveConfigFile(rule.hostName)
    if (configFile)
      args.push('-F', configFile)

    const dest = `${rule.destHost || 'localhost'}:${rule.destPort}`
    args.push(rule.direction === 'local' ? '-L' : '-R', `${rule.listenPort}:${dest}`)

    args.push(rule.hostName)
    return args
  }

  /**
   * Points `ssh -F` at the config file that actually defines the host,
   * following Include directives up to the parent file (same resolution as
   * the connect commands). Returns undefined when the default user config
   * already covers the host.
   */
  private async resolveConfigFile(hostName: string): Promise<string | undefined> {
    const hosts = await parseSSHConfig()
    const host = hosts.find(h => h.host === hostName)
    if (!host?.configFile)
      return undefined
    const includedBy = await this.provider.getIncludedBy(host.configFile)
    const file = includedBy && includedBy.length > 0 ? includedBy[0] : host.configFile
    const userConfig = join(homedir(), '.ssh', 'config')
    if (file === userConfig)
      return undefined
    return file
  }

  /**
   * Reconciles in-memory state with the on-disk tunnel records: adopt tunnels
   * started by other windows (or by a previous session before a reload),
   * notice tunnels stopped elsewhere, and clean up dead records.
   */
  private syncFromDisk(): void {
    let changed = false
    let files: string[]
    try {
      files = readdirSync(this.tunnelsDir)
    }
    catch {
      return
    }

    for (const file of files) {
      if (!file.endsWith('.json'))
        continue
      let record: TunnelRecord
      try {
        record = JSON.parse(readFileSync(join(this.tunnelsDir, file), 'utf8')) as TunnelRecord
      }
      catch {
        continue
      }
      const id = record.id
      if (!id)
        continue

      // The launcher gave up retrying — surface the error until acted on.
      if (record.dead) {
        const entry = this.entries.get(id)
        if (!entry || entry.status !== 'error') {
          const message = this.diagnosticLine(id) || 'ssh exited after repeated failures'
          this.entries.set(id, {
            status: 'error',
            message,
            graceTimer: undefined,
            startedAt: Date.now(),
          })
          this.log(`error ${id}: ${message}`)
          changed = true
          this.notifyFailure(id, message)
        }
        continue
      }

      // Between launcher retries: ssh is down, the launcher is about to
      // respawn it. A LIVE ssh pid always wins over the retry flag — a
      // respawned tunnel is up regardless of when the launcher resets the
      // attempts marker.
      if ((record.attempts ?? 0) > 0 && !pidAlive(record.pid)) {
        if (pidAlive(record.launcherPid ?? -1)) {
          const message = `ssh exited; retrying (${record.attempts}/${MAX_ATTEMPTS})`
          const entry = this.entries.get(id)
          if (!entry || entry.status !== 'starting' || entry.message !== message) {
            this.entries.set(id, { status: 'starting', message, graceTimer: undefined, startedAt: Date.now() })
            this.log(`retry ${id}: ${message}`)
            changed = true
          }
          continue
        }
        // Launcher died (e.g. host teardown) before respawning — treat as stopped.
        rmSync(join(this.tunnelsDir, file), { force: true })
        if (this.entries.delete(id)) {
          changed = true
          this.notifyFailure(id, 'ssh exited before the tunnel could be re-established')
        }
        continue
      }

      if (!pidAlive(record.pid)) {
        rmSync(join(this.tunnelsDir, file), { force: true })
        if (this.entries.delete(id))
          changed = true
        continue
      }

      const entry = this.entries.get(id)
      if (!entry) {
        // Started by another window or by the session before a reload.
        // ssh stays alive when its forward fails (no ExitOnForwardFailure),
        // so verify the forward actually established — otherwise a reloaded
        // window would adopt a broken tunnel as healthy.
        const rule = this.findRule(id)
        const failure = rule ? this.forwardFailureDetail(rule, this.readTail(id)) : undefined
        if (failure) {
          this.log(`error ${id}: ${failure}`)
          this.killRecorded(id)
          this.entries.set(id, { status: 'error', message: failure, graceTimer: undefined, startedAt: Date.now() })
          changed = true
          this.notifyFailure(id, failure)
          continue
        }
        this.entries.set(id, { status: 'running', message: undefined, graceTimer: undefined, startedAt: Date.now() })
        this.log(`adopt ${id} (pid ${record.pid})`)
        changed = true
      }
      else if (entry.status === 'starting') {
        entry.status = 'running'
        entry.message = undefined
        changed = true
      }
    }

    // A 'starting' entry whose record never appeared means the launcher or
    // ssh died before writing anything (spawn failure, storage error) —
    // fail loudly instead of sitting in 'starting' forever. A slow-but-live
    // launcher is tolerated up to LAUNCHER_TIMEOUT_MS.
    for (const [id, entry] of [...this.entries]) {
      if (entry.status !== 'starting' || this.readRecord(id))
        continue
      const age = Date.now() - entry.startedAt
      const launcherAlive = entry.launcherPid != null && pidAlive(entry.launcherPid)
      if (age > START_TIMEOUT_MS && (!launcherAlive || age > LAUNCHER_TIMEOUT_MS)) {
        const message = this.tunnelFailureDetail(id, entry, undefined)
        this.entries.delete(id)
        this.log(`error ${id}: ${message}`)
        this.notifyFailure(id, message)
        changed = true
      }
    }

    if (changed)
      this._onDidChange.fire()
  }

  /** Stops tunnels whose rule disappeared from the shared settings. */
  private syncWithSettings(): void {
    const ids = new Set(readRules().map(forwardId))
    for (const id of [...this.entries.keys()]) {
      if (!ids.has(id))
        this.stop(id)
    }
    let files: string[]
    try {
      files = readdirSync(this.tunnelsDir)
    }
    catch {
      return
    }
    for (const file of files) {
      if (!file.endsWith('.json'))
        continue
      try {
        const record = JSON.parse(readFileSync(join(this.tunnelsDir, file), 'utf8')) as TunnelRecord
        if (record.id && !ids.has(record.id))
          this.killRecorded(record.id)
      }
      catch { /* unreadable record: ignore */ }
    }
  }

  /**
   * Detached helper that watches the VS Code main process and kills all
   * recorded tunnels once it exits — tunnels follow the application, not the
   * window. Needs ELECTRON_RUN_AS_NODE because process.execPath is the
   * Electron helper binary inside VS Code.
   */
  private spawnWatchdog(): void {
    const mainPid = Number(process.env.VSCODE_PID)
    if (!Number.isInteger(mainPid) || mainPid <= 0)
      return
    try {
      const watchdog = spawn(
        process.execPath,
        [join(this.extensionUri.fsPath, 'media', 'sshTunnels', 'watchdog.js'), this.tunnelsDir, String(mainPid)],
        {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          windowsHide: true,
        },
      )
      watchdog.unref()
    }
    catch { /* watchdog is best-effort; tunnels would just leak on app quit */ }
  }
}

function validatePort(value: string): string | undefined {
  return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535
    ? undefined
    : 'Enter a port between 1 and 65535'
}

interface DirectionPickItem extends QuickPickItem {
  value: ForwardDirection
}

/**
 * Multi-step quick input that creates (and starts) a port forward rule.
 * `presetHostName` comes from the explorer context menu, `presetPort` from
 * the SSH Tunnels panel's quick-add input.
 */
export async function promptAndAddPortForward(
  manager: PortForwardManager,
  presetHostName?: string,
  presetPort?: number,
): Promise<void> {
  const hosts = await parseSSHConfig()
  if (hosts.length === 0) {
    window.showWarningMessage('No SSH hosts found in your config files.')
    return
  }

  let hostName = presetHostName
  if (!hostName || !hosts.some(h => h.host === hostName)) {
    const picked = await window.showQuickPick(
      hosts.map(h => ({ label: h.host, description: h.hostname, detail: h.configFile })),
      { placeHolder: 'Forward through which SSH host?', matchOnDescription: true },
    )
    if (!picked)
      return
    hostName = picked.label
  }

  const title = `Forward Port on ${hostName}`
  const direction = await window.showQuickPick<DirectionPickItem>(
    [
      {
        label: 'Listen Local — ssh -L',
        description: 'Access a remote service from this machine, e.g. browse the remote port 80 at localhost:8080',
        value: 'local',
      },
      {
        label: 'Listen Remote — ssh -R',
        description: 'Expose a local service on the remote machine, e.g. let the remote host reach a local dev server',
        value: 'remote',
      },
    ],
    { title, placeHolder: 'Forward direction', ignoreFocusOut: true },
  )
  if (!direction)
    return

  const localPrompt = direction.value === 'local'
    ? 'Port to listen on, on this machine'
    : 'Destination port on this machine'
  const localPortStr = await window.showInputBox({
    title,
    prompt: localPrompt,
    placeHolder: '8080',
    value: presetPort ? String(presetPort) : '',
    ignoreFocusOut: true,
    validateInput: validatePort,
  })
  if (!localPortStr)
    return
  const localPort = Number.parseInt(localPortStr, 10)

  const remotePrompt = direction.value === 'local'
    ? 'Destination port on the remote side'
    : 'Port to listen on, on the remote machine'
  const remotePortStr = await window.showInputBox({
    title,
    prompt: remotePrompt,
    value: String(localPort),
    ignoreFocusOut: true,
    validateInput: validatePort,
  })
  if (!remotePortStr)
    return
  const remotePort = Number.parseInt(remotePortStr, 10)

  const rule: PortForwardRule = {
    hostName,
    direction: direction.value,
    listenPort: localPort,
    destHost: 'localhost',
    destPort: remotePort,
  }
  const id = await manager.addRule(rule, true)
  if (!id)
    return

  await commands.executeCommand('vscode-ssh-config-all-in-one.sshTunnels.focus')
  const summary = rule.direction === 'local'
    ? `localhost:${rule.listenPort} → ${rule.destHost}:${rule.destPort} (ssh -L)`
    : `${hostName}:${rule.listenPort} → ${rule.destHost}:${rule.destPort} (ssh -R)`
  window.showInformationMessage(`Port forward started: ${summary}`)
}
