import type {
  CancellationToken,
  CodeLensProvider,
  Disposable,
  TextDocument,
} from 'vscode'
import { CodeLens, commands, languages, Range } from 'vscode'
import { DOCUMENT_PROVIDER } from './utils'

/**
 * Provides CodeLens for SSH configuration documents.
 */
export class SSHCodeLensProvider implements CodeLensProvider {
  /**
   * Constructs a new instance of SSHCodeLensProvider.
   * @param disposables - The array of disposables to which the registration of the document formatting edit provider will be added.
   */
  constructor(disposables: Disposable[]) {
    disposables.push(
      languages.registerCodeLensProvider(DOCUMENT_PROVIDER, this),
    )
  }

  /**
   * Computes a list of lenses.
   * @param document - The document in which the command was invoked.
   * @param token - A cancellation token.
   * @returns An array of CodeLenses or a thenable that resolves to such.
   */
  provideCodeLenses(
    document: TextDocument,
    token: CancellationToken,
  ): CodeLens[] {
    const codeLenses: CodeLens[] = []
    const text = document.getText()
    const lines = text.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmedLine = line.trim()

      // Only process Host lines, ignore wildcards or regex lines if desired (though user can still try to connect)
      if (
        trimmedLine.startsWith('Host ') &&
        !trimmedLine.startsWith('Host *')
      ) {
        // Extract the host names, there could be multiple separated by space
        const hostNames = trimmedLine.substring(5).trim().split(/\s+/)

        for (const hostName of hostNames) {
          if (!hostName || hostName.includes('*') || hostName.includes('?')) {
            continue // Skip wildcards
          }

          const range = new Range(i, 0, i, line.length)

          codeLenses.push(
            new CodeLens(range, {
              title: `Connect in Current Window...`,
              tooltip: `Connect to ${hostName} in the current window`,
              command: 'vscode-ssh-config-all-in-one.connectCurrentWindow',
              arguments: [hostName],
            }),
          )

          codeLenses.push(
            new CodeLens(range, {
              title: `Connect in New Window...`,
              tooltip: `Connect to ${hostName} in a new window`,
              command: 'vscode-ssh-config-all-in-one.connectNewWindow',
              arguments: [hostName],
            }),
          )

          codeLenses.push(
            new CodeLens(range, {
              title: `Copy Public Key...`,
              tooltip: `Copy SSH public key to ${hostName}`,
              command: 'vscode-ssh-config-all-in-one.copyPublicKey',
              arguments: [hostName],
            }),
          )

          // If there are multiple hosts on one line, maybe just show connection links for the first exact host, or all?
          // Showing for all might clutter, let's just do it for all exact matches.
        }
      }
    }

    return codeLenses
  }
}
