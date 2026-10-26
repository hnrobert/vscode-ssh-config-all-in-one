import type { ChildProcess } from 'node:child_process'
import type { Disposable, Event, QuickPickItem } from 'vscode'
import type { SSHExplorerProvider } from './explorer'
import { spawn } from 'node:child_process'
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

/** A rule merged with its runtime state, as consumed by the SSH PORTS panel. */
export interface ForwardViewRow extends PortForwardRule {
  id: string
  status: ForwardStatus
  message: string | undefined
}

interface Entry {
  proc: ChildProcess | undefined
  stopping: boolean
  attempts: number
  status: ForwardStatus
  message: string | undefined
  graceTimer: ReturnType<typeof setTimeout> | undefined
  retryTimer: ReturnType<typeof setTimeout> | undefined
}

const CONFIG_KEY = 'portForwards'
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 4000
const RUNNING_GRACE_MS = 1500

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

/**
 * Keeps persistent `ssh -N -L/-R` processes alive for configured port forward
 * rules, restarting crashed tunnels up to {@link MAX_ATTEMPTS} times.
 */
export class PortForwardManager implements Disposable {
  private readonly entries = new Map<string, Entry>()
  private readonly _onDidChange = new EventEmitter<void>()
  private readonly configListener: Disposable

  constructor(private readonly provider: SSHExplorerProvider) {
    this.configListener = workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sshConfigAllInOne.portForwards')) {
        this.syncWithSettings()
        this._onDidChange.fire()
      }
    })
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
    this.stop(id)
    const entry: Entry = {
      proc: undefined,
      stopping: false,
      attempts: 0,
      status: 'starting',
      message: undefined,
      graceTimer: undefined,
      retryTimer: undefined,
    }
    this.entries.set(id, entry)
    this._onDidChange.fire()
    await this.spawnProcess(id, rule, entry)
  }

  stop(id: string): void {
    const entry = this.entries.get(id)
    if (!entry)
      return
    entry.stopping = true
    if (entry.graceTimer)
      clearTimeout(entry.graceTimer)
    if (entry.retryTimer)
      clearTimeout(entry.retryTimer)
    entry.proc?.kill()
    this.entries.delete(id)
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

  dispose(): void {
    void this.stopAll()
    this.configListener.dispose()
    this._onDidChange.dispose()
  }

  private async spawnProcess(id: string, rule: PortForwardRule, entry: Entry): Promise<void> {
    if (entry.stopping)
      return

    let args: string[]
    try {
      args = await this.buildArgs(rule)
    }
    catch (err) {
      this.failEntry(entry, `Failed to resolve SSH arguments: ${errorMessage(err)}`)
      return
    }
    if (entry.stopping)
      return

    let child: ChildProcess
    try {
      child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    }
    catch (err) {
      this.failEntry(entry, `Failed to spawn ssh: ${errorMessage(err)}`)
      return
    }

    entry.proc = child
    entry.status = 'starting'
    this._onDidChange.fire()

    let stderrTail = ''
    child.stderr?.on('data', (chunk) => {
      stderrTail = `${stderrTail}${String(chunk)}`.slice(-400)
    })

    entry.graceTimer = setTimeout(() => {
      entry.graceTimer = undefined
      if (this.entries.get(id) === entry && !entry.stopping) {
        entry.status = 'running'
        entry.message = undefined
        this._onDidChange.fire()
      }
    }, RUNNING_GRACE_MS)

    child.on('error', (err) => {
      if (this.entries.get(id) !== entry || entry.stopping)
        return
      entry.proc = undefined
      this.failEntry(entry, err.message)
    })

    child.on('exit', (code) => {
      if (this.entries.get(id) !== entry)
        return
      entry.proc = undefined
      if (entry.graceTimer) {
        clearTimeout(entry.graceTimer)
        entry.graceTimer = undefined
      }
      if (entry.stopping || code === 0) {
        this.entries.delete(id)
        this._onDidChange.fire()
        return
      }
      entry.attempts += 1
      if (entry.attempts <= MAX_ATTEMPTS) {
        entry.status = 'starting'
        entry.message = `ssh exited with code ${code}; retrying (${entry.attempts}/${MAX_ATTEMPTS})`
        this._onDidChange.fire()
        entry.retryTimer = setTimeout(() => {
          entry.retryTimer = undefined
          if (this.entries.get(id) === entry && !entry.stopping)
            void this.spawnProcess(id, rule, entry)
        }, RETRY_DELAY_MS)
      }
      else {
        entry.status = 'error'
        entry.message = stderrTail.trim() || `ssh exited with code ${code}`
        this._onDidChange.fire()
      }
    })
  }

  private failEntry(entry: Entry, message: string): void {
    entry.status = 'error'
    entry.message = message
    this._onDidChange.fire()
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

  private syncWithSettings(): void {
    const ids = new Set(readRules().map(forwardId))
    for (const id of [...this.entries.keys()]) {
      if (!ids.has(id))
        this.stop(id)
    }
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
 * the SSH PORTS panel's quick-add input.
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
        label: 'Local → Remote (ssh -L)',
        description: 'Listen on this machine, tunnel into the remote network',
        value: 'local',
      },
      {
        label: 'Remote → Local (ssh -R)',
        description: 'Listen on the remote machine, tunnel back to this machine',
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

  await commands.executeCommand('vscode-ssh-config-all-in-one.sshPorts.focus')
  const arrow = rule.direction === 'local' ? '→' : '←'
  window.showInformationMessage(
    `Port forward started: localhost:${localPort} ${arrow} ${hostName}:${remotePort}`,
  )
}
