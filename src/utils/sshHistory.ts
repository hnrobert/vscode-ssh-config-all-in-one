import { readFile } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { env } from 'vscode'
import { decodeSSHHostname } from './sshDetection'

const readFileAsync = promisify(readFile)

interface RecentWorkspace {
  folderUri?: string
  workspace?: { configPath: string }
  label?: string
}

export async function getVSCodeStoragePath(): Promise<string> {
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

export async function getRecentSSHConnections(): Promise<Map<string, string[]>> {
  const hostFolders = new Map<string, string[]>()

  try {
    const dbPath = await getVSCodeStoragePath()

    // Try to use sqlite3 command to read the database
    const { exec } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execAsync = promisify(exec)

    try {
      const { stdout } = await execAsync(
        `sqlite3 "${dbPath}" "SELECT value FROM ItemTable WHERE key='history.recentlyOpenedPathsList'"`,
      )

      if (stdout.trim()) {
        const data = JSON.parse(stdout.trim())
        const entries: RecentWorkspace[] = data.entries || []

        // // console.log(`[SSH Explorer] Found ${entries.length} total entries`)

        for (const entry of entries) {
          const uri = entry.folderUri || entry.workspace?.configPath
          if (!uri)
            continue

          // Parse vscode-remote://ssh-remote+<encoded-host>/path/to/folder
          // or vscode-remote://ssh-remote%2B<hex-encoded-json>/path/to/folder
          const match = /^vscode-remote:\/\/ssh-remote[+%]2[Bb]([^/]+)(\/.*)$/.exec(uri)
          if (match) {
            let hostname = match[1]
            const folderPath = match[2] || '/'

            // The hostname is hex-encoded JSON
            try {
              hostname = await decodeSSHHostname(hostname)
            }
            catch (err) {
              // If decoding fails, try URL decoding
              hostname = decodeURIComponent(hostname)
            }

            if (!hostFolders.has(hostname)) {
              hostFolders.set(hostname, [])
            }

            const folders = hostFolders.get(hostname)!
            if (!folders.includes(folderPath)) {
              folders.push(folderPath)
            }
          }
        }

        // // console.log(`[SSH Explorer] Parsed ${hostFolders.size} SSH hosts with folders:`)
        // for (const [host, folders] of hostFolders.entries()) {
        //   // console.log(`  ${host}: ${folders.length} folders`)
        // }
      }
      else {
        // // console.log('[SSH Explorer] No data returned from SQLite query')
      }
    }
    catch (sqliteError) {
      // // console.error('[SSH Explorer] Failed to read SQLite database:', sqliteError)
    }
  }
  catch (error) {
    // // console.error('[SSH Explorer] Failed to get recent SSH connections:', error)
  }

  return hostFolders
}
