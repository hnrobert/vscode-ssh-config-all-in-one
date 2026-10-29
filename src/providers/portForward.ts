import type { Disposable, Event, OutputChannel, QuickPickItem, Uri } from 'vscode'
import type { SSHExplorerProvider } from './explorer'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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
  /** For -L: local bind address. For -R: destination host on this machine. */
  localAddress: string
  localPort: number
  /** For -L: destination host resolved on the remote machine. For -R: bind address on the remote machine. */
  remoteAddress: string
  remotePort: number
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
const RUNNING_GRACE_MS = 1500
const SYNC_INTERVAL_MS = 5000

export function forwardId(rule: PortForwardRule): string {
  const local = rule.localAddress || 'localhost'
  const remote = rule.remoteAddress || 'localhost'
  return `${rule.direction}://${local}:${rule.localPort}=>${rule.hostName}:${remote}:${rule.remotePort}`
}

function normalizeRule(raw: unknown): PortForwardRule | undefined {
  if (typeof raw !== 'object' || raw === null)
    return undefined
  const r = raw as Partial<PortForwardRule>
  if (typeof r.hostName !== 'string' || !r.hostName.trim())
    return undefined
  if (r.direction !== 'local' && r.direction !== 'remote')
    return undefined
  const localPort = Number(r.localPort)
  const remotePort = Number(r.remotePort)
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535)
    return undefined
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535)
    return undefined
  return {
    hostName: r.hostName.trim(),
    direction: r.direction,
    localAddress: typeof r.localAddress === 'string' && r.localAddress.trim() ? r.localAddress.trim() : 'localhost',
    localPort,
    remoteAddress: typeof r.remoteAddress === 'string' && r.remoteAddress.trim() ? r.remoteAddress.trim() : 'localhost',
    remotePort,
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
      this.entries.set(id, { status: 'error', message, graceTimer: undefined })
      this.log(`error ${id}: ${message}`)
      this._onDidChange.fire()
      return
    }

    const entry: Entry = { status: 'starting', message: undefined, graceTimer: undefined }
    this.entries.set(id, entry)
    try {
      // The launcher daemonizes ssh (double detach) so the tunnel escapes
      // the extension host's process tree — VS Code kills that tree on
      // Reload Window — and owns retries + the on-disk record.
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
          stdio: 'ignore',
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          windowsHide: true,
        },
      )
      launcher.unref()
    }
    catch (err) {
      entry.status = 'error'
      entry.message = `Failed to spawn tunnel launcher: ${errorMessage(err)}`
      this.log(`error ${id}: ${entry.message}`)
      this._onDidChange.fire()
      return
    }

    this.log(`start ${id}: ssh ${args.join(' ')}`)
    entry.graceTimer = setTimeout(() => {
      entry.graceTimer = undefined
      const record = this.readRecord(id)
      if (this.entries.get(id) === entry && record && pidAlive(record.pid)) {
        entry.status = 'running'
        entry.message = undefined
        this._onDidChange.fire()
      }
    }, RUNNING_GRACE_MS)
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
      return readFileSync(this.logPath(id), 'utf8').trim().slice(-400)
    }
    catch {
      return ''
    }
  }

  /** Kills the recorded process for `id` (possibly owned by another window) and drops the record. */
  private killRecorded(id: string): void {
    const record = this.readRecord(id)
    if (!record)
      return
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
   * tunnels do: no shell, fail fast when the forward cannot be established,
   * detect dead connections via keepalives.
   */
  private async buildArgs(rule: PortForwardRule): Promise<string[]> {
    const args = [
      '-N',
      '-o',
      'ExitOnForwardFailure=yes',
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

    const local = rule.localAddress || 'localhost'
    const remote = rule.remoteAddress || 'localhost'
    if (rule.direction === 'local')
      args.push('-L', `${local}:${rule.localPort}:${remote}:${rule.remotePort}`)
    else
      args.push('-R', `${remote}:${rule.remotePort}:${local}:${rule.localPort}`)

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
          this.entries.set(id, {
            status: 'error',
            message: this.readTail(id) || 'ssh exited after repeated failures',
            graceTimer: undefined,
          })
          this.log(`error ${id}: tunnel gave up after retries`)
          changed = true
        }
        continue
      }

      // Between launcher retries — ssh may be down for a few seconds.
      if ((record.attempts ?? 0) > 0) {
        if (pidAlive(record.pid) || pidAlive(record.launcherPid ?? -1)) {
          const message = `ssh exited; retrying (${record.attempts}/${MAX_ATTEMPTS})`
          const entry = this.entries.get(id)
          if (!entry || entry.status !== 'starting' || entry.message !== message) {
            this.entries.set(id, { status: 'starting', message, graceTimer: undefined })
            this.log(`retry ${id}: ${message}`)
            changed = true
          }
          continue
        }
        // Launcher died (e.g. host teardown) before respawning — treat as stopped.
        rmSync(join(this.tunnelsDir, file), { force: true })
        if (this.entries.delete(id))
          changed = true
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
        this.entries.set(id, { status: 'running', message: undefined, graceTimer: undefined })
        this.log(`adopt ${id} (pid ${record.pid})`)
        changed = true
      }
      else if (entry.status === 'starting') {
        entry.status = 'running'
        entry.message = undefined
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
    localAddress: 'localhost',
    localPort,
    remoteAddress: 'localhost',
    remotePort,
  }
  const id = await manager.addRule(rule, true)
  if (!id)
    return

  await commands.executeCommand('vscode-ssh-config-all-in-one.sshTunnels.focus')
  const summary = rule.direction === 'local'
    ? `localhost:${localPort} → ${hostName}:${remotePort} (ssh -L)`
    : `${hostName}:${remotePort} → localhost:${localPort} (ssh -R)`
  window.showInformationMessage(`Port forward started: ${summary}`)
}
