import { env, workspace } from 'vscode'

export async function getCurrentSSHHost(): Promise<string | undefined> {
  // Check if we're in an SSH remote session
  const remoteName = env.remoteName
  // // console.log(`[getCurrentSSHHost] env.remoteName = "${remoteName}"`)

  if (remoteName !== 'ssh-remote') {
    // // console.log(`[getCurrentSSHHost] Not an SSH remote session`)
    return undefined
  }

  // Try to get hostname from workspace URI authority first
  const workspaceFolder = workspace.workspaceFolders?.[0]
  if (workspaceFolder) {
    const authority = workspaceFolder.uri.authority
    // // console.log(`[getCurrentSSHHost] Workspace URI authority: "${authority}"`)

    if (authority.startsWith('ssh-remote+')) {
      const hostname = authority.substring('ssh-remote+'.length)
      return await decodeSSHHostname(hostname)
    }
  }

  // If no workspace folder, we cannot reliably determine the current host
  // // console.log(`[getCurrentSSHHost] No workspace folder - cannot determine current SSH host`)
  return undefined
}

export async function decodeSSHHostname(hostname: string): Promise<string> {
  // // console.log(`[decodeSSHHostname] Input: "${hostname}"`)

  // Decode URL-encoded hostname
  hostname = decodeURIComponent(hostname)
  // // console.log(`[decodeSSHHostname] After URL decode: "${hostname}"`)

  // If it's hex-encoded JSON, decode it
  if (/^[0-9a-f]+$/i.test(hostname)) {
    // // console.log(`[decodeSSHHostname] Detected hex-encoded JSON`)
    try {
      const { Buffer } = await import('node:buffer')
      const decoded = Buffer.from(hostname, 'hex').toString('utf-8')
      // // console.log(`[decodeSSHHostname] Hex decoded to: "${decoded}"`)
      const hostData = JSON.parse(decoded)
      // // console.log(`[decodeSSHHostname] Parsed JSON:`, hostData)
      hostname = hostData.hostName || hostname
      // // console.log(`[decodeSSHHostname] Final hostname: "${hostname}"`)
    }
    catch (err) {
      // // console.log(`[decodeSSHHostname] Failed to decode hex JSON:`, err)
    }
  }
  else {
    // // console.log(`[decodeSSHHostname] Not hex-encoded, using as-is: "${hostname}"`)
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
  // // console.log(`[getCurrentSSHFolder] Current folder path: "${folderPath}"`)
  return folderPath
}

export async function getAllSSHHosts(): Promise<string[]> {
  if (env.remoteName !== 'ssh-remote')
    return []

  const hosts: string[] = []
  for (const folder of workspace.workspaceFolders ?? []) {
    const authority = folder.uri.authority
    if (authority.startsWith('ssh-remote+')) {
      const hostname = authority.substring('ssh-remote+'.length)
      hosts.push(await decodeSSHHostname(hostname))
    }
  }
  // Deduplicate while preserving order
  return [...new Set(hosts)]
}
