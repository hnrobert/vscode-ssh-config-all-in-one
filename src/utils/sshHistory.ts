import { readFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import initSqlJs from 'sql.js'
import { env } from 'vscode'
import { decodeSSHHostname } from './sshDetection'

function log(msg: string) {
  console.log(`[SSH Config] ${msg}`)
}

function now(): number {
  return performance.now()
}

function elapsed(start: number): string {
  return `${(now() - start).toFixed(1)}ms`
}

function getVSCodeStoragePath(): string {
  const plat = platform()
  const appName = env.appName.includes('Insiders') ? 'Code - Insiders' : 'Code'

  let basePath: string
  if (plat === 'darwin') {
    basePath = join(homedir(), 'Library', 'Application Support', appName)
  }
  else if (plat === 'win32') {
    basePath = join(process.env.APPDATA || '', appName)
  }
  else {
    basePath = join(homedir(), '.config', appName)
  }

  return join(basePath, 'User', 'globalStorage', 'state.vscdb')
}

function queryValue(db: initSqlJs.Database, key: string): string | null {
  const result = db.exec(`SELECT value FROM ItemTable WHERE key = ?`, [key])
  if (result.length > 0 && result[0].values.length > 0)
    return result[0].values[0][0] as string
  return null
}

function parseRemoteSSHStorage(db: initSqlJs.Database): Map<string, string[]> {
  const t0 = now()
  const hostFolders = new Map<string, string[]>()

  const raw = queryValue(db, 'ms-vscode-remote.remote-ssh')
  if (!raw)
    return hostFolders

  try {
    const data = JSON.parse(raw)
    const folderHistory: Record<string, string[]> = data['folder.history.v1'] || {}
    log(`Remote SSH folder.history.v1: ${Object.keys(folderHistory).length} hosts`)

    for (const [rawHost, folders] of Object.entries(folderHistory)) {
      if (!Array.isArray(folders) || folders.length === 0)
        continue

      let hostname = rawHost
      try {
        hostname = decodeSSHHostname(rawHost)
      }
      catch {
        hostname = decodeURIComponent(rawHost)
      }

      hostFolders.set(hostname, folders)
    }
  }
  catch (err) {
    log(`Failed to parse Remote SSH storage: ${err instanceof Error ? err.message : String(err)}`)
  }

  log(`parseRemoteSSHStorage: ${elapsed(t0)}, ${hostFolders.size} hosts`)
  return hostFolders
}

const SSH_URI_RE = /^vscode-remote:\/\/ssh-remote(?:\+|%2[bB])([^/]+)(\/.*)$/

function parseRecentlyOpened(db: initSqlJs.Database): Map<string, string[]> {
  const t0 = now()
  const hostFolders = new Map<string, string[]>()
  const dbKeys = ['recently.opened', 'history.recentlyOpenedPathsList']

  let rawData: string | null = null
  for (const key of dbKeys) {
    rawData = queryValue(db, key)
    if (rawData) {
      log(`Found recently opened data with key: ${key}`)
      break
    }
  }

  if (!rawData)
    return hostFolders

  try {
    const data = JSON.parse(rawData)
    const entries: { folderUri?: string, workspace?: { configPath: string } }[] = data.entries || []

    for (const entry of entries) {
      const uri = entry.folderUri || entry.workspace?.configPath
      if (!uri)
        continue

      const match = SSH_URI_RE.exec(uri)
      if (!match)
        continue

      let hostname = match[1]
      const folderPath = match[2] || '/'

      try {
        hostname = decodeSSHHostname(hostname)
      }
      catch {
        hostname = decodeURIComponent(hostname)
      }

      if (!hostFolders.has(hostname))
        hostFolders.set(hostname, [])

      const folders = hostFolders.get(hostname)!
      if (!folders.includes(folderPath))
        folders.push(folderPath)
    }
  }
  catch (err) {
    log(`Failed to parse recently opened: ${err instanceof Error ? err.message : String(err)}`)
  }

  log(`parseRecentlyOpened: ${elapsed(t0)}, ${hostFolders.size} hosts`)
  return hostFolders
}

function mergeFolders(target: Map<string, string[]>, source: Map<string, string[]>): void {
  for (const [host, folders] of source) {
    if (!target.has(host)) {
      target.set(host, [...folders])
    }
    else {
      const existing = target.get(host)!
      for (const f of folders) {
        if (!existing.includes(f))
          existing.push(f)
      }
    }
  }
}

// Cache: dedup concurrent calls + persist result for refresh
let cachedPromise: Promise<Map<string, string[]>> | null = null
let cachedResult: Map<string, string[]> | null = null

export function getRecentSSHConnections(): Promise<Map<string, string[]>> {
  if (cachedResult)
    return Promise.resolve(cachedResult)

  if (!cachedPromise) {
    cachedPromise = loadRecentSSHConnections().then((result) => {
      cachedResult = result
      cachedPromise = null
      return result
    })
  }
  return cachedPromise
}

export function clearRecentCache(): void {
  cachedResult = null
  cachedPromise = null
}

async function loadRecentSSHConnections(): Promise<Map<string, string[]>> {
  const t0 = now()
  const hostFolders = new Map<string, string[]>()

  try {
    const dbPath = getVSCodeStoragePath()
    const SQL = await initSqlJs({
      locateFile: (file: string) => join(__dirname, file),
    })
    const buf = readFileSync(dbPath)
    log(`openDB (${(buf.length / 1024 / 1024).toFixed(1)}MB): ${elapsed(t0)}`)

    const db = new SQL.Database(buf)

    // Both sources are now synchronous — no await overhead
    const remoteSSHData = parseRemoteSSHStorage(db)
    const recentlyOpened = parseRecentlyOpened(db)
    db.close()

    mergeFolders(hostFolders, remoteSSHData)
    mergeFolders(hostFolders, recentlyOpened)

    log(`Total: ${hostFolders.size} hosts, ${elapsed(t0)}`)
  }
  catch (error) {
    log(`Failed to get recent SSH connections: ${error instanceof Error ? error.message : String(error)}`)
  }

  return hostFolders
}
