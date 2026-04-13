import { lstat, readFile } from 'node:fs'
import { join } from 'node:path'
import { Uri, window, workspace } from 'vscode'

let options: Promise<Option[]>

/**
 * Retrieves the options from the options.json file.
 * If the options have already been retrieved, it returns a cached Promise.
 * Otherwise, it reads the options from the file and returns a new Promise.
 * @returns A Promise that resolves to the options object.
 */
export function getOptions() {
  return options || (options = new Promise((resolve, reject) => {
    readFile(join(__dirname, '../thirdparty/options.json'), { encoding: 'utf8' }, (err, content) => {
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
    lstat(path, (err, stats) => {
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
