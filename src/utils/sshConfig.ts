import { readFile } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { env, workspace } from 'vscode'

const readFileAsync = promisify(readFile)

export interface HostEntry {
  host: string
  hostname?: string
  configFile?: string
  lineNumber?: number
}

export interface SSHConfigFile {
  path: string
  label: string
  hosts: HostEntry[]
}

function resolveTilde(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

function getConfigSettings() {
  const cfg = workspace.getConfiguration('sshConfigAllInOne.config')
  return {
    additionalFiles: cfg.get<string[]>('additionalFiles', []),
    excludeDefaultFiles: cfg.get<string[]>('excludeDefaultFiles', []),
  }
}

export async function getSSHConfigFiles(): Promise<SSHConfigFile[]> {
  const configFiles: SSHConfigFile[] = []
  const { additionalFiles, excludeDefaultFiles } = getConfigSettings()
  const excludeSet = new Set(excludeDefaultFiles.map(resolveTilde))

  // Load default configs in parallel
  const defaultPaths = [
    { path: join(homedir(), '.ssh', 'config'), label: 'User Config (~/.ssh/config)' },
    { path: '/etc/ssh/ssh_config', label: 'System Config (/etc/ssh/ssh_config)' },
  ]

  const defaultResults = await Promise.all(
    defaultPaths.map(async ({ path, label }) => {
      if (excludeSet.has(path))
        return null
      const hosts = await parseSSHConfigFile(path)
      return hosts.length > 0 ? { path, label, hosts } : null
    }),
  )

  for (const result of defaultResults) {
    if (result)
      configFiles.push(result)
  }

  // Load additional config files from settings
  if (additionalFiles.length > 0) {
    const additionalResults = await Promise.all(
      additionalFiles.map(async (rawPath) => {
        const path = resolveTilde(rawPath)
        const hosts = await parseSSHConfigFile(path)
        if (hosts.length === 0)
          return null
        return {
          path,
          label: `${basename(path)} (${rawPath})`,
          hosts,
        }
      }),
    )

    for (const result of additionalResults) {
      if (result)
        configFiles.push(result)
    }
  }

  // Remote config (if in remote session)
  if (env.remoteName === 'ssh-remote') {
    const remoteConfigPath = join(homedir(), '.ssh', 'config')
    const userConfigPath = join(homedir(), '.ssh', 'config')
    if (remoteConfigPath !== userConfigPath && !excludeSet.has(remoteConfigPath)) {
      const remoteHosts = await parseSSHConfigFile(remoteConfigPath)
      if (remoteHosts.length > 0) {
        configFiles.push({
          path: remoteConfigPath,
          label: 'Remote Config (Remote ~/.ssh/config)',
          hosts: remoteHosts,
        })
      }
    }
  }

  return configFiles
}

async function parseSSHConfigFile(configPath: string): Promise<HostEntry[]> {
  let content: string
  try {
    content = await readFileAsync(configPath, 'utf8')
  }
  catch {
    return []
  }

  const hosts: HostEntry[] = []
  let currentHost: HostEntry | null = null
  let lineNumber = 0

  for (const line of content.split('\n')) {
    lineNumber++
    const trimmed = line.trim()
    if (trimmed.startsWith('#') || trimmed === '')
      continue

    const matchHost = /^Host\s+(\S.*)$/i.exec(trimmed)
    if (matchHost) {
      if (currentHost)
        hosts.push(currentHost)
      const name = matchHost[1].trim()
      if (name.includes('*') || name.includes('?'))
        continue
      currentHost = {
        host: name,
        configFile: configPath,
        lineNumber,
      }
      continue
    }

    if (currentHost) {
      const matchHostname = /^\s*HostName\s+(\S.*)$/i.exec(trimmed)
      if (matchHostname)
        currentHost.hostname = matchHostname[1].trim()
    }
  }

  if (currentHost)
    hosts.push(currentHost)

  return hosts
}

export async function parseSSHConfig(): Promise<HostEntry[]> {
  const configFiles = await getSSHConfigFiles()
  return configFiles.flatMap(file => file.hosts)
}
