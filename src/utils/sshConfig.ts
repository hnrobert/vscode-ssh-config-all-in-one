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

type IncludeMode = 'merge' | 'separate' | 'none'
type IncludeDepth = '0' | '1' | 'unlimited'

function resolveTilde(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

function getIncludeSettings(): { mode: IncludeMode, maxDepth: IncludeDepth } {
  const cfg = workspace.getConfiguration('sshConfigAllInOne.include')
  return {
    mode: cfg.get<IncludeMode>('mode', 'separate'),
    maxDepth: cfg.get<IncludeDepth>('maxDepth', '1'),
  }
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
  const { mode, maxDepth } = getIncludeSettings()

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

  // Process Include directives based on settings
  if (mode === 'none' || maxDepth === '0')
    return configFiles

  const maxDepthNum = maxDepth === 'unlimited' ? Infinity : Number.parseInt(maxDepth, 10)
  const knownPaths = new Set(configFiles.map(f => f.path))

  if (mode === 'merge') {
    await mergeIncludedHosts(configFiles, knownPaths, excludeSet, maxDepthNum)
  }
  else {
    const autoDetected = await resolveIncludedFiles(configFiles, knownPaths, excludeSet, maxDepthNum)
    configFiles.push(...autoDetected)
  }

  return configFiles
}

async function mergeIncludedHosts(
  configFiles: SSHConfigFile[],
  knownPaths: Set<string>,
  excludeSet: Set<string>,
  maxDepth: number,
): Promise<void> {
  const visited = new Set(knownPaths)

  for (const cfg of configFiles) {
    const queue: Array<{ parentPath: string, includePattern: string, depth: number }> = []
    const includes = parseIncludeDirectives(cfg.path)

    for (const pattern of includes) {
      queue.push({ parentPath: cfg.path, includePattern: pattern, depth: 1 })
    }

    while (queue.length > 0) {
      const { parentPath, includePattern, depth } = queue.shift()!
      if (depth > maxDepth)
        continue

      const resolvedPaths = resolveIncludePattern(includePattern, dirname(parentPath))
      for (const resolvedPath of resolvedPaths) {
        if (visited.has(resolvedPath) || excludeSet.has(resolvedPath))
          continue
        visited.add(resolvedPath)

        const hosts = await parseSSHConfigFile(resolvedPath)
        // Merge hosts into the parent config file, correcting configFile reference
        for (const host of hosts) {
          cfg.hosts.push({ ...host, configFile: cfg.path })
        }

        // Recurse into this included file's own Includes
        if (maxDepth === Infinity || depth < maxDepth) {
          const nestedIncludes = parseIncludeDirectives(resolvedPath)
          for (const nestedPattern of nestedIncludes) {
            queue.push({ parentPath: resolvedPath, includePattern: nestedPattern, depth: depth + 1 })
          }
        }
      }
    }
  }
}

async function resolveIncludedFiles(
  configFiles: SSHConfigFile[],
  knownPaths: Set<string>,
  excludeSet: Set<string>,
  maxDepth: number,
): Promise<SSHConfigFile[]> {
  const result: SSHConfigFile[] = []
  const visited = new Set(knownPaths)

  // BFS queue: files to process for their Includes
  const queue: Array<{ parentPath: string, depth: number }> = []
  for (const cfg of configFiles) {
    queue.push({ parentPath: cfg.path, depth: 0 })
  }

  while (queue.length > 0) {
    const { parentPath, depth } = queue.shift()!
    if (depth >= maxDepth)
      continue

    const includes = parseIncludeDirectives(parentPath)
    for (const pattern of includes) {
      const resolvedPaths = resolveIncludePattern(pattern, dirname(parentPath))
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

        // Recurse into this file's Includes
        if (maxDepth === Infinity || depth + 1 < maxDepth) {
          queue.push({ parentPath: resolvedPath, depth: depth + 1 })
        }
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
  let expanded: string
  if (pattern.startsWith('~')) {
    expanded = join(homedir(), pattern.slice(2))
  }
  else if (pattern.startsWith('/')) {
    expanded = pattern
  }
  else {
    expanded = resolve(configDir, pattern)
  }

  if (!expanded.includes('*') && !expanded.includes('?')) {
    return existsSync(expanded) ? [expanded] : []
  }

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
