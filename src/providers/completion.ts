import type {
  CompletionItemProvider,
  Disposable,
  Position,
  TextDocument,
} from 'vscode'
import {
  CompletionItem,
  CompletionItemKind,
  languages,
  SnippetString,
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
    // Check if we're at the beginning of the file (top level)
    const lineText = document.lineAt(position.line).text
    const isTopLevel = position.line === 0 || lineText.trim().length === 0 || /^Host\s/i.test(lineText)

    const items: CompletionItem[] = []

    // Host template - prioritize at top level
    const hostTemplate = (() => {
      const item = new CompletionItem('Host')
      item.kind = CompletionItemKind.Snippet
      item.documentation = 'Insert a basic Host configuration template.'
      // eslint-disable-next-line no-template-curly-in-string
      item.insertText = new SnippetString('Host ${1:alias}\n    HostName ${2:hostname}\n    User ${3:user}\n    Port ${4:22}')
      // Sort first when at top level
      item.sortText = isTopLevel ? '0-host' : 'host'
      return item
    })()
    items.push(hostTemplate)

    // Configure Tunnels template
    items.push((() => {
      const item = new CompletionItem('Configure Tunnels')
      item.kind = CompletionItemKind.Snippet
      item.documentation = 'Insert a template for configuring a tunnel connection.'
      // eslint-disable-next-line no-template-curly-in-string
      item.insertText = new SnippetString('Host ${1:alias}\n    HostName ${2:fqn}\n    LocalForward ${4:port} ${5:localhost}:${4:port}\n    User ${6:user}')
      item.sortText = isTopLevel ? '1-tunnels' : 'tunnels'
      return item
    })())

    // Configure Incus template
    items.push((() => {
      const item = new CompletionItem('Configure Incus')
      item.kind = CompletionItemKind.Snippet
      item.documentation = 'Creates incus and root-incus on demand.'

      item.insertText = new SnippetString(`Host \${1:alias}\n  HostName \${1:alias}.incus\n  User dev\n\nHost root-\${1:alias}\n  HostName root-\${1:fqn}.incus\n`)
      item.sortText = isTopLevel ? '2-incus' : 'incus'
      return item
    })())

    return items
  }
}
