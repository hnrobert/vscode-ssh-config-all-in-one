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
   * @param _token - A cancellation token.
   * @returns An array of CodeLenses or a thenable that resolves to such.
   */
  provideCodeLenses(
    document: TextDocument,
    _token: CancellationToken,
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
        const blockEndLine = this.findBlockEnd(lines, i)
        const blockEndRange = new Range(blockEndLine, 0, blockEndLine, lines[blockEndLine].length)

        for (const hostName of hostNames) {
          if (!hostName || hostName.includes('*') || hostName.includes('?'))
            continue

          const range = new Range(i, 0, i, line.length)

          codeLenses.push(
            new CodeLens(range, {
              title: 'Test Connection...',
              tooltip: `Test SSH connection to ${hostName}`,
              command: 'vscode-ssh-config-all-in-one.testConnection',
              arguments: [hostName],
            }),
          )

          codeLenses.push(
            new CodeLens(range, {
              title: 'Connect in Current Window...',
              tooltip: `Connect to ${hostName} in the current window`,
              command: 'vscode-ssh-config-all-in-one.connectCurrentWindow',
              arguments: [hostName, document.uri.fsPath],
            }),
          )

          codeLenses.push(
            new CodeLens(range, {
              title: 'Connect in New Window...',
              tooltip: `Connect to ${hostName} in a new window`,
              command: 'vscode-ssh-config-all-in-one.connectNewWindow',
              arguments: [hostName, document.uri.fsPath],
            }),
          )

          codeLenses.push(
            new CodeLens(range, {
              title: 'Send Public Key...',
              tooltip: `Send SSH public key to ${hostName}`,
              command: 'vscode-ssh-config-all-in-one.copyPublicKey',
              arguments: [hostName],
            }),
          )

          codeLenses.push(
            new CodeLens(blockEndRange, {
              title: 'Show in Explorer',
              tooltip: `Show ${hostName} in SSH Config All In One`,
              command: 'vscode-ssh-config-all-in-one.revealHost',
              arguments: [hostName],
            }),
          )
        }
      }
    }

    return codeLenses
  }

  private findBlockEnd(lines: string[], hostLineIndex: number): number {
    for (let i = hostLineIndex + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim()
      if (
        trimmed === ''
        || trimmed.startsWith('Host ')
        || trimmed.startsWith('Match ')
      ) {
        // Attach CodeLens to the terminating line (blank or next Host/Match)
        // so it renders below the block content
        return i
      }
    }
    return lines.length - 1
  }
}
