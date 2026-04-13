import type {
  CompletionItemProvider,
  Disposable,
  Position,
  TextDocument,
} from 'vscode'
import {
  CompletionItem,
  CompletionItemKind,
  SnippetString,
  languages,
} from 'vscode'
import { DOCUMENT_PROVIDER } from './utils'

/**
 * Provides completion items for SSH syntax.
 */
export class SSHCompletionItemsProvider implements CompletionItemProvider {
  /**
   * Initializes a new instance of the SSHCompletionItemsProvider class.
   * @param disposables The array of disposables to which the completion item provider will be added.
   */
  constructor(disposables: Disposable[]) {
    disposables.push(languages.registerCompletionItemProvider(DOCUMENT_PROVIDER, this, ' '))
  }

  /**
   * Provides completion items for the given document and position.
   * @param document The text document.
   * @param position The position in the document.
   * @returns A promise that resolves to an array of completion items or undefined.
   */

  async provideCompletionItems(document: TextDocument, position: Position): Promise<CompletionItem[] | undefined> {
    return [
      (() => {
        const item = new CompletionItem('Configure Tunnels')
        item.kind = CompletionItemKind.Snippet
        item.documentation = 'Insert a template for configuring a tunnel connection.'
        // eslint-disable-next-line no-template-curly-in-string
        item.insertText = new SnippetString('Hosts ${1:alias}\n    HostName ${2:fqn}\n    LocalForward ${4:port} ${5:localhost}:${4:port}\n    User ${6:user}')
        return item
      })(),
      (() => {
        const item = new CompletionItem('Configure Incus')
        item.kind = CompletionItemKind.Snippet
        item.documentation = 'Creates incus and root-incus on demand.'
        item.insertText = new SnippetString(`Host \${1:alias}\n  HostName \${1:alias}.incus\n  User dev\n\nHost root-\${1:alias}\n  HostName root-\${1:fqn}.incus\n`)
        return item
      })(),
    ]
  }
}
