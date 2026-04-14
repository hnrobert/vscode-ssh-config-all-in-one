import type {
  Disposable,
  DocumentFormattingEditProvider,
  FormattingOptions,
  ProviderResult,
  TextDocument,
} from 'vscode';
import { Range, TextEdit, languages, window, workspace } from 'vscode';
import { DOCUMENT_PROVIDER } from './utils';

/**
 * Provides formatting for SSH configuration documents.
 */
export class SSHFormatProvider implements DocumentFormattingEditProvider {
  /**
   * Constructs a new instance of SSHFormatProvider.
   * @param disposables - The array of disposables to which the registration of the document formatting edit provider will be added.
   */
  constructor(disposables: Disposable[]) {
    disposables.push(
      languages.registerDocumentFormattingEditProvider(DOCUMENT_PROVIDER, this),
    );
  }

  /**
   * Provides the formatting edits for the given document.
   * @param document - The document to be formatted.
   * @param options - The formatting options.
   */
  provideDocumentFormattingEdits(
    document: TextDocument,
    options: FormattingOptions,
  ): ProviderResult<TextEdit[]> {
    const editor = window.activeTextEditor;
    const indentSize = workspace
      .getConfiguration('sshConfigAllInOne.format')
      .get('indentSize', 2);

    if (!editor) {
      return;
    }

    const text = document.getText();
    const formattedText = this.formatSshConfig(text, indentSize);

    if (text === formattedText) {
      return [];
    }

    const fullRange = new Range(
      document.positionAt(0),
      document.positionAt(text.length),
    );

    return [TextEdit.replace(fullRange, formattedText)];
  }

  /**
   * Formats the SSH configuration text.
   * @param text - The SSH configuration text to be formatted.
   * @param indentSize - The size of the indentation.
   * @returns The formatted SSH configuration text.
   */
  private formatSshConfig(text: string, indentSize: number): string {
    const customIndentation = ' '.repeat(indentSize);
    let isHostBlock = false;
    let isFirstLine = true;
    return text
      .split('\n')
      .map((line, index, lines) => {
        if (
          line.trim().startsWith('Host ') ||
          line.trim().startsWith('Match ')
        ) {
          isHostBlock = true;
          if (
            !isFirstLine &&
            lines[index - 1].trim() !== '' &&
            !lines[index - 1].trim().startsWith('#')
          ) {
            return `\n${line.trim()}`;
          }
          return line.trim();
        } else if (line.trim() === '') {
          isHostBlock = false;
          isFirstLine = false;
          return line;
        } else {
          isFirstLine = false;
          return isHostBlock
            ? `${customIndentation}${line.trim()}`
            : line.trim();
        }
      })
      .join('\n');
  }
}
