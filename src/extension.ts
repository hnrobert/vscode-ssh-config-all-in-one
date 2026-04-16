import type { Disposable, ExtensionContext } from 'vscode'
import { commands, Uri } from 'vscode'
import { openUserConfig } from './functions'
import {
  SSHCodeLensProvider,
  SSHCompletionItemsProvider,
  SSHDocumentLinkProvider,
  SSHFormatProvider,
  SSHHoverProvider,
} from './providers'

/**
 * Activates the extension.
 *
 * @param context - The extension context.
 */
export function activate(context: ExtensionContext) {
  const subscriptions = context.subscriptions
  const disposable: Disposable[] = []

  disposable.push(
    commands.registerCommand(
      'vscode-ssh-config-all-in-one.openUserConfig',
      () => openUserConfig(),
    ),
  )

  disposable.push(
    commands.registerCommand(
      'vscode-ssh-config-all-in-one.connectCurrentWindow',
      (hostStr: string) => {
        commands
          .executeCommand('opensshremotes.openEmptyWindowInCurrentWindow', {
            host: hostStr,
          })
          .then(undefined, () => {
            // Fallback if the remote extension changes its API
            commands.executeCommand('vscode.newWindow', {
              remoteAuthority: `ssh-remote+${hostStr}`,
              reuseWindow: true,
            })
          })
      },
    ),
  )

  disposable.push(
    commands.registerCommand(
      'vscode-ssh-config-all-in-one.connectNewWindow',
      (hostStr: string) => {
        commands
          .executeCommand('opensshremotes.openEmptyWindow', { host: hostStr })
          .then(undefined, () => {
            // Fallback
            commands.executeCommand('vscode.newWindow', {
              remoteAuthority: `ssh-remote+${hostStr}`,
              reuseWindow: false,
            })
          })
      },
    ),
  )

  new SSHCompletionItemsProvider(disposable)
  new SSHHoverProvider(disposable)
  new SSHDocumentLinkProvider(disposable)
  new SSHFormatProvider(disposable)
  new SSHCodeLensProvider(disposable)

  subscriptions.push(...disposable)
}

export function deactivate() {
  // noop
}
