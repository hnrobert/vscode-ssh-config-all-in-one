import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { env, workspace } from 'vscode'

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
  isCustom?: boolean
  isAutoDetected?: boolean
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
          isCustom: true,
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

  // Auto-detect files referenced via Include directives
  const knownPaths = new Set(configFiles.map(f => f.path))
  const autoDetected = await resolveIncludedFiles(configFiles, knownPaths, excludeSet)
  configFiles.push(...autoDetected)

  return configFiles
}

async function resolveIncludedFiles(
  configFiles: SSHConfigFile[],
  knownPaths: Set<string>,
  excludeSet: Set<string>,
): Promise<SSHConfigFile[]> {
  const result: SSHConfigFile[] = []
  const visited = new Set(knownPaths)

  for (const cfg of configFiles) {
    const includes = parseIncludeDirectives(cfg.path)
    for (const pattern of includes) {
      const resolvedPaths = resolveIncludePattern(pattern, dirname(cfg.path))
      for (const resolvedPath of resolvedPaths) {
        if (visited.has(resolvedPath) || excludeSet.has(resolvedPath))
          continue
        visited.add(resolvedPath)

        const hosts = await parseSSHConfigFile(resolvedPath)
        if (hosts.length === 0)
          continue

        result.push({
          path: resolvedPath,
          label: `${basename(resolvedPath)} (auto-detected)`,
          hosts,
          isAutoDetected: true,
        })
      }
    }
  }

  return result
}

function parseIncludeDirectives(configPath: string): string[] {
  let content: string
  try {
    content = readFileSync(configPath, 'utf8')
  }
  catch {
    return []
  }

  const includes: string[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#') || trimmed === '')
      continue
    const match = /^Include\s+(\S+)$/i.exec(trimmed)
    if (match)
      includes.push(match[1])
  }
  return includes
}

function resolveIncludePattern(pattern: string, configDir: string): string[] {
  // Expand ~
  let expanded: string
  if (pattern.startsWith('~')) {
    expanded = join(homedir(), pattern.slice(2))
  }
  else if (pattern.startsWith('/')) {
    expanded = pattern
  }
  else {
    // Relative to the config file's directory
    expanded = resolve(configDir, pattern)
  }

  // If no glob characters, return as-is if file exists
  if (!expanded.includes('*') && !expanded.includes('?')) {
    return existsSync(expanded) ? [expanded] : []
  }

  // Resolve glob: list directory and match
  const baseDir = dirname(expanded)
  const globPart = basename(expanded)
  if (!existsSync(baseDir))
    return []

  const globRe = globToRegex(globPart)
  let entries: string[]
  try {
    entries = readdirSync(baseDir)
  }
  catch {
    return []
  }

  return entries
    .filter(e => globRe.test(e))
    .map(e => join(baseDir, e))
    .filter((e) => {
      try {
        return statSync(e).isFile()
      }
      catch {
        return false
      }
    })
}

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const pattern = escaped.replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${pattern}$`)
}

async function parseSSHConfigFile(configPath: string): Promise<HostEntry[]> {
  let content: string
  try {
    content = readFileSync(configPath, 'utf8')
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
