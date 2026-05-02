import { Buffer } from 'node:buffer'
import { env, workspace } from 'vscode'

export async function getCurrentSSHHost(): Promise<string | undefined> {
  // Check if we're in an SSH remote session
  const remoteName = env.remoteName
  // console.log(`[getCurrentSSHHost] env.remoteName = "${remoteName}"`)

  if (remoteName !== 'ssh-remote') {
    // console.log(`[getCurrentSSHHost] Not an SSH remote session`)
    return undefined
  }

  // Try to get hostname from workspace URI authority first
  const workspaceFolder = workspace.workspaceFolders?.[0]
  if (workspaceFolder) {
    const authority = workspaceFolder.uri.authority
    // console.log(`[getCurrentSSHHost] Workspace URI authority: "${authority}"`)

    if (authority.startsWith('ssh-remote+')) {
      const hostname = authority.substring('ssh-remote+'.length)
      return await decodeSSHHostname(hostname)
    }
  }

  // If no workspace folder, we cannot reliably determine the current host
  // console.log(`[getCurrentSSHHost] No workspace folder - cannot determine current SSH host`)
  return undefined
}

export function decodeSSHHostname(hostname: string): string {
  hostname = decodeURIComponent(hostname)

  if (/^[0-9a-f]+$/i.test(hostname)) {
    try {
      const decoded = Buffer.from(hostname, 'hex').toString('utf-8')
      const hostData = JSON.parse(decoded)
      hostname = hostData.hostName || hostname
    }
    catch {}
  }

  return hostname
}

export function getCurrentSSHFolder(): string | undefined {
  // Get current workspace folder path if in SSH session
  if (env.remoteName !== 'ssh-remote')
    return undefined

  const workspaceFolder = workspace.workspaceFolders?.[0]
  if (!workspaceFolder)
    return undefined

  // The URI path for remote workspaces
  const folderPath = workspaceFolder.uri.path
  // console.log(`[getCurrentSSHFolder] Current folder path: "${folderPath}"`)
  return folderPath
}
