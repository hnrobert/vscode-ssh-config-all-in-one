import type { Disposable, HoverProvider, Position, TextDocument } from 'vscode'
import { Hover, languages } from 'vscode'
import { getSSHConfigOptions } from '../functions'
import { DOCUMENT_PROVIDER } from './utils'

const optionsMap: Record<string, string> = {}

async function fetchSSHConfigOptions() {
  try {
    const options = await getSSHConfigOptions()
    if (Array.isArray(options)) {
      options.forEach((option: Option) => {
        optionsMap[option.label] = option.documentation
      })
    }
  } catch (error) {
    console.error('Error fetching SSH config options:', error)
  }
}

/**
 * Provides hover information for SSH configuration options.
 */
export class SSHHoverProvider implements HoverProvider {
  /**
   * Constructs a new instance of SSHHoverProvider.
   * @param disposables - The array of disposables to which the hover provider will be added.
   */
  constructor(disposables: Disposable[]) {
    disposables.push(languages.registerHoverProvider(DOCUMENT_PROVIDER, this))
    fetchSSHConfigOptions()
  }

  /**
   * Provides hover information for the given document and position.
   * @param document - The text document.
   * @param position - The position in the document.
   * @returns A hover object containing the hover information.
   */
  async provideHover(document: TextDocument, position: Position) {
    const wordRange = document.getWordRangeAtPosition(position)
    if (!wordRange) {
      return
    }

    const word = document.getText(wordRange)

    if (optionsMap[word]) {
      const hoverContent = [`**${word}**`, `\`\`\`\n${optionsMap[word]}\n\`\`\``]
      return new Hover(hoverContent)
    }
  }
}
