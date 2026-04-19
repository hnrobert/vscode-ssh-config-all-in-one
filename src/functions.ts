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
 * Copies the SSH public key to a remote host.
 * @param hostName - The name of the host to copy the key to.
 */
export async function copyPublicKey(hostName: string) {
  try {
    const publicKeyPath = await findPublicKey()

    if (!publicKeyPath) {
      await promptGenerateKeys()
      return
    }

    const isWindows = platform() === 'win32'

    if (isWindows) {
      await copyPublicKeyWindows(hostName, publicKeyPath)
    } else {
      await copyPublicKeyUnix(hostName, publicKeyPath)
    }
  } catch (error) {
    window.showErrorMessage(`Failed to copy public key: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Copies the SSH public key to a remote host on Unix systems.
 * @param hostName - The name of the host to copy the key to.
 * @param publicKeyPath - The path to the public key file.
 */
async function copyPublicKeyUnix(hostName: string, publicKeyPath: string) {
  try {
    await execAsync('which ssh-copy-id')

    const terminal = window.createTerminal('SSH Copy ID')
    terminal.show()
    terminal.sendText(`ssh-copy-id -i "${publicKeyPath}" ${hostName}`)

    window.showInformationMessage(`Copying public key to ${hostName}. Please enter your password in the terminal.`)
  } catch {
    const terminal = window.createTerminal('SSH Copy ID')
    terminal.show()
    terminal.sendText(`cat "${publicKeyPath}" | ssh ${hostName} "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && chmod 700 ~/.ssh"`)

    window.showInformationMessage(`Copying public key to ${hostName}. Please enter your password in the terminal.`)
  }
}

/**
 * Copies the SSH public key to a remote host on Windows systems.
 * @param hostName - The name of the host to copy the key to.
 * @param publicKeyPath - The path to the public key file.
 */
async function copyPublicKeyWindows(hostName: string, publicKeyPath: string) {
  const terminal = window.createTerminal('SSH Copy ID')
  terminal.show()

  const script = `$pubKey = Get-Content "${publicKeyPath}" -Raw; ssh ${hostName} "mkdir -p ~/.ssh && echo '$pubKey' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && chmod 700 ~/.ssh"`

  terminal.sendText(script)

  window.showInformationMessage(`Copying public key to ${hostName}. Please enter your password in the terminal.`)
}
