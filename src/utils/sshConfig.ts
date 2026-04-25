import { readFile } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { env } from 'vscode'

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

export async function getSSHConfigFiles(): Promise<SSHConfigFile[]> {
  const configFiles: SSHConfigFile[] = []

  // User config
  const userConfigPath = join(homedir(), '.ssh', 'config')
  const userHosts = await parseSSHConfigFile(userConfigPath)
  if (userHosts.length > 0) {
    configFiles.push({
      path: userConfigPath,
      label: 'User Config (~/.ssh/config)',
      hosts: userHosts,
    })
  }

  // System config (if accessible)
  const systemConfigPath = '/etc/ssh/ssh_config'
  const systemHosts = await parseSSHConfigFile(systemConfigPath)
  if (systemHosts.length > 0) {
    configFiles.push({
      path: systemConfigPath,
      label: 'System Config (/etc/ssh/ssh_config)',
      hosts: systemHosts,
    })
  }

  // Remote config (if in remote session)
  if (env.remoteName === 'ssh-remote') {
    const remoteConfigPath = join(homedir(), '.ssh', 'config')
    const remoteHosts = await parseSSHConfigFile(remoteConfigPath)
    if (remoteHosts.length > 0 && remoteConfigPath !== userConfigPath) {
      configFiles.push({
        path: remoteConfigPath,
        label: 'Remote Config (Remote ~/.ssh/config)',
        hosts: remoteHosts,
      })
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
