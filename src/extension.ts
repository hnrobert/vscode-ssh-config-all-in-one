import { type Disposable, type ExtensionContext, commands } from 'vscode'
import { SSHCompletionItemsProvider, SSHDocumentLinkProvider, SSHFormatProvider, SSHHoverProvider } from './providers'
import { openUserConfig } from './functions'

/**
 * Activates the extension.
 *
 * @param context - The extension context.
 */
export function activate(context: ExtensionContext) {
  const subscriptions = context.subscriptions
  const disposable: Disposable[] = []

  disposable.push(commands.registerCommand('ssh.openUserConfig', () => openUserConfig()))

  new SSHCompletionItemsProvider(disposable)
  new SSHHoverProvider(disposable)
  new SSHDocumentLinkProvider(disposable)
  new SSHFormatProvider(disposable)

  subscriptions.push(...disposable)
}

export function deactivate() {
  // noop
}
