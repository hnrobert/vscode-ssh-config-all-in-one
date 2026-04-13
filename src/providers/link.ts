import type {
  CancellationToken,
  Disposable,
  DocumentLinkProvider,
  TextDocument,
} from 'vscode'
import {
  DocumentLink,
  FileType,
  Range,
  Uri,
  languages,
  workspace,
} from 'vscode'
import { DOCUMENT_PROVIDER } from './utils'

/**
 * Provides document links for SSH files.
 */
export class SSHDocumentLinkProvider implements DocumentLinkProvider {
  /**
   * Constructs a new SSHDocumentLinkProvider.
   * @param disposables - The array of disposables to which the document link provider will be added.
   */
  constructor(disposables: Disposable[]) {
    disposables.push(languages.registerDocumentLinkProvider(DOCUMENT_PROVIDER, this))
  }

  /**
   * Provides document links for the given text document.
   * @param document - The text document for which to provide document links.
   * @param token - A cancellation token that can be used to cancel the operation.
   * @returns An array of document links.
   */
  async provideDocumentLinks(document: TextDocument, token: CancellationToken) {
    const INCLUDE_REGEXP = /(Include\s+)(\S+)/g
    const code: string = document.getText()
    const result = []
    let matched: RegExpMatchArray | null = null

    try {
      // eslint-disable-next-line no-cond-assign
      while ((matched = INCLUDE_REGEXP.exec(code)) != null) {
        let p = matched[2]
        if (p.startsWith('~/.ssh/')) {
          // replace ~/ssh with nothing
          p = p.replace(/^~\/.ssh\//, ``)
        }
        let uri = Uri.joinPath(document.uri, '..', p)

        try {
          const stat = await workspace.fs.stat(uri)
          if (stat.type !== FileType.File && stat.type !== FileType.SymbolicLink) continue
        } catch (error) {
          continue
        }

        const offset1 = matched.index! + matched[1].length
        const offset2 = offset1 + matched[2].length
        result.push(
          new DocumentLink(new Range(document.positionAt(offset1), document.positionAt(offset2)), uri),
        )
      }
    } catch (ex) {
      console.error(ex)
    }
    return result
  }
}
