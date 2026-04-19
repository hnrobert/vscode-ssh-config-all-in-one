import { exec } from 'node:child_process'
import { lstat, readFile } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Uri, window, workspace } from 'vscode'

const execAsync = promisify(exec)

let options: Promise<Option[]>

/**
 * Retrieves the options from the options.json file.
 * If the options have already been retrieved, it returns a cached Promise.
 * Otherwise, it reads the options from the file and returns a new Promise.
 * @returns A Promise that resolves to the options object.
 */
export function getOptions() {
  return options || (options = new Promise((resolve, reject) => {
    readFile(join(__dirname, '../thirdparty/options.json'), { encoding: 'utf8' }, (err: NodeJS.ErrnoException | null, content: string) => {
      err ? reject(err) : resolve(JSON.parse(content))
    })
  }))
}

/**
 * Retrieves the SSH configuration options.
 * @returns A promise that resolves to an array of Option objects.
 */
export async function getSSHConfigOptions(): Promise<Option[]> {
  return await getOptions()
}

export function openUserConfig() {
  const userConfig = process.env.USERPROFILE && join(process.env.USERPROFILE, '.ssh/config')

  if (!userConfig) {
    return window.showErrorMessage('USERPROFILE environment variable not set')
  }
  return openConfig(userConfig)
}

/**
 * Opens a configuration file at the specified path.
 * If the file exists, it will be opened in the editor.
 * If the file does not exist, a new untitled document will be created and opened.
 *
 * @param path - The path of the configuration file to open.
 * @returns A promise that resolves to the opened text document.
 */
export async function openConfig(path: string) {
  return fileExists(path)
    .then(async (exists) => {
      return workspace.openTextDocument(exists ? Uri.file(path) : Uri.file(path).with({ scheme: 'untitled' }))
        .then((document) => {
          return window.showTextDocument(document)
        })
    })
}

/**
 * Checks if a file exists at the specified path.
 * @param path - The path of the file to check.
 * @returns A promise that resolves to `true` if the file exists, or `false` otherwise.
 */
export function fileExists(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    lstat(path, (err: NodeJS.ErrnoException | null) => {
      if (!err) {
        resolve(true)
      } else if (err.code === 'ENOENT') {
        resolve(false)
      } else {
        reject(err)
      }
    })
  })
}

/**
 * Finds the SSH public key file.
 * @returns A promise that resolves to the path of the public key file, or null if not found.
 */
async function findPublicKey(): Promise<string | null> {
  const sshDir = join(homedir(), '.ssh')
  const keyTypes = ['id_rsa.pub', 'id_ed25519.pub', 'id_ecdsa.pub', 'id_dsa.pub']

  for (const keyType of keyTypes) {
    const keyPath = join(sshDir, keyType)
    if (await fileExists(keyPath)) {
      return keyPath
    }
  }

  return null
}

/**
 * Prompts the user to select an SSH public key file.
 * @returns A promise that resolves to the path of the selected public key file, or null if cancelled.
 */
async function promptSelectPublicKey(): Promise<string | null> {
  const sshDir = join(homedir(), '.ssh')
  const keyTypes = ['id_rsa.pub', 'id_ed25519.pub', 'id_ecdsa.pub', 'id_dsa.pub']

  const availableKeys: { label: string, path: string }[] = []

  for (const keyType of keyTypes) {
    const keyPath = join(sshDir, keyType)
    if (await fileExists(keyPath)) {
      availableKeys.push({ label: keyType, path: keyPath })
    }
  }

  if (availableKeys.length === 0) {
    return null
  }

  const choice = await window.showQuickPick(
    availableKeys.map(k => ({ label: k.label, description: k.path, value: k.path })),
    {
      placeHolder: 'Select the SSH public key to send',
      title: 'SSH Public Key',
    },
  )

  return choice?.value || null
}

/**
 * Prompts the user to generate SSH keys.
 * @returns A promise that resolves to true if keys were generated, false otherwise.
 */
async function promptGenerateKeys(): Promise<boolean> {
  const choice = await window.showInformationMessage(
    'No SSH key pair found. Would you like to generate one?',
    'Generate Keys',
    'Cancel',
  )

  if (choice !== 'Generate Keys') {
    return false
  }

  const terminal = window.createTerminal('SSH Key Generation')
  terminal.show()
  terminal.sendText('ssh-keygen -t ed25519 -C "$(whoami)@$(hostname)"')

  window.showInformationMessage('Please follow the prompts in the terminal to generate your SSH key pair.')
  return false
}

/**
 * Detects the operating system of a remote host.
 * @param hostName - The name of the host to detect.
 * @returns A promise that resolves to 'unix' or 'windows', or null if detection fails.
 */
async function detectRemoteOS(hostName: string): Promise<'unix' | 'windows' | null> {
  try {
    // Try to detect Windows by checking for PowerShell
    const { stdout: psCheck } = await execAsync(`ssh -o ConnectTimeout=5 -o BatchMode=yes ${hostName} "powershell -Command \\"echo test\\"" 2>/dev/null || echo ""`, { timeout: 10000 })
    if (psCheck.trim() === 'test') {
      return 'windows'
    }

    // Try Unix/Linux detection
    const { stdout: unixCheck } = await execAsync(`ssh -o ConnectTimeout=5 -o BatchMode=yes ${hostName} "uname" 2>/dev/null || echo ""`, { timeout: 10000 })
    if (unixCheck.trim()) {
      return 'unix'
    }

    return null
  }
  catch {
    return null
  }
}

/**
 * Copies the SSH public key to a remote host.
 * @param hostName - The name of the host to copy the key to.
 */
export async function copyPublicKey(hostName: string) {
  try {
    window.showInformationMessage(`Detecting remote system type for ${hostName}...`)

    let remoteOS = await detectRemoteOS(hostName)

    if (!remoteOS) {
      const choice = await window.showQuickPick(
        [
          { label: 'Unix/Linux/Mac', value: 'unix' as const },
          { label: 'Windows', value: 'windows' as const },
        ],
        {
          placeHolder: 'Could not auto-detect. Please select the remote host operating system',
          title: 'Remote Host OS',
        },
      )

      if (!choice) {
        return
      }
      remoteOS = choice.value
    }
    else {
      window.showInformationMessage(`Detected remote system: ${remoteOS === 'unix' ? 'Unix/Linux/Mac' : 'Windows'}`)
    }

    const isLocalWindows = platform() === 'win32'
    let publicKeyPath: string | null = null

    // For Unix remote with ssh-copy-id on non-Windows local, we don't need to specify the key
    const needsKeyPath = isLocalWindows || remoteOS === 'windows'

    if (needsKeyPath) {
      publicKeyPath = await findPublicKey()

      if (!publicKeyPath) {
        const shouldGenerate = await promptGenerateKeys()
        if (!shouldGenerate) {
          return
        }
        // After generation, user needs to run the command again
        return
      }

      // If multiple keys exist, let user choose
      publicKeyPath = await promptSelectPublicKey()
      if (!publicKeyPath) {
        return
      }
    }

    if (remoteOS === 'windows') {
      await copyPublicKeyToWindowsRemote(hostName, publicKeyPath, isLocalWindows)
    }
    else {
      await copyPublicKeyToUnixRemote(hostName, publicKeyPath, isLocalWindows)
    }
  }
  catch (error) {
    window.showErrorMessage(`Failed to send public key: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Copies the SSH public key to a Unix/Linux/Mac remote host.
 * @param hostName - The name of the host to copy the key to.
 * @param publicKeyPath - The path to the public key file (optional, let ssh-copy-id choose).
 * @param isLocalWindows - Whether the local machine is Windows.
 */
async function copyPublicKeyToUnixRemote(hostName: string, publicKeyPath: string | null, isLocalWindows: boolean) {
  const terminal = window.createTerminal('SSH Copy ID')
  terminal.show()

  if (isLocalWindows) {
    if (!publicKeyPath) {
      window.showErrorMessage('Public key path is required on Windows')
      return
    }
    const script = `type "${publicKeyPath}" | ssh ${hostName} "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && chmod 700 ~/.ssh"`
    terminal.sendText(script)
  }
  else {
    try {
      await execAsync('which ssh-copy-id')
      // Let ssh-copy-id use its default key selection
      terminal.sendText(`ssh-copy-id ${hostName}`)
    }
    catch {
      if (!publicKeyPath) {
        window.showErrorMessage('ssh-copy-id not found and no public key specified')
        return
      }
      terminal.sendText(`cat "${publicKeyPath}" | ssh ${hostName} "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && chmod 700 ~/.ssh"`)
    }
  }

  window.showInformationMessage(`Sending public key to ${hostName}. Please enter your password in the terminal.`)
}

/**
 * Copies the SSH public key to a Windows remote host.
 * @param hostName - The name of the host to copy the key to.
 * @param publicKeyPath - The path to the public key file.
 * @param isLocalWindows - Whether the local machine is Windows.
 */
async function copyPublicKeyToWindowsRemote(hostName: string, publicKeyPath: string | null, isLocalWindows: boolean) {
  if (!publicKeyPath) {
    window.showErrorMessage('Public key path is required for Windows remote hosts')
    return
  }

  const terminal = window.createTerminal('SSH Copy ID')
  terminal.show()

  if (isLocalWindows) {
    const script = `type "${publicKeyPath}" | ssh ${hostName} "powershell -Command \\"New-Item -ItemType Directory -Force -Path $env:USERPROFILE\\.ssh | Out-Null; $input | Add-Content -Path $env:USERPROFILE\\.ssh\\authorized_keys\\""`
    terminal.sendText(script)
  }
  else {
    const script = `cat "${publicKeyPath}" | ssh ${hostName} "powershell -Command \\"New-Item -ItemType Directory -Force -Path \\$env:USERPROFILE\\.ssh | Out-Null; \\$input | Add-Content -Path \\$env:USERPROFILE\\.ssh\\authorized_keys\\""`
    terminal.sendText(script)
  }

  window.showInformationMessage(`Sending public key to ${hostName}. Please enter your password in the terminal.`)
}
