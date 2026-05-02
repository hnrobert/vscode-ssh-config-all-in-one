import type { Diagnostic, Disposable, TextDocument } from 'vscode'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DiagnosticSeverity, languages, Range, workspace } from 'vscode'
import { DOCUMENT_PROVIDER } from './utils'

function resolveIncludePath(pattern: string, configDir: string): string[] {
  let expanded: string
  if (pattern.startsWith('~')) {
    expanded = join(homedir(), pattern.slice(2))
  }
  else if (pattern.startsWith('/')) {
    expanded = pattern
  }
  else {
    expanded = resolve(configDir, pattern)
  }

  if (!expanded.includes('*') && !expanded.includes('?')) {
    return [expanded]
  }

  const baseDir = dirname(expanded)
  const globPart = basename(expanded)
  if (!existsSync(baseDir))
    return []

  const escaped = globPart.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`)

  let entries: string[]
  try {
    entries = readdirSync(baseDir)
  }
  catch {
    return []
  }

  return entries
    .filter(e => re.test(e))
    .map(e => join(baseDir, e))
    .filter((e) => {
      try {
        return statSync(e).isFile()
      }
      catch {
        return false
      }
    })
}

export class SSHIncludeDiagnosticsProvider implements Disposable {
  private disposables: Disposable[] = []

  constructor() {
    const collection = languages.createDiagnosticCollection('ssh-include-cycles')
    this.disposables.push(collection)

    const check = (doc: TextDocument) => {
      if (doc.languageId !== 'ssh_config')
        return

      const diagnostics: Diagnostic[] = []
      const docPath = doc.uri.fsPath
      const lines = doc.getText().split('\n')

      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim()
        const match = /^Include\s+(\S+)$/i.exec(trimmed)
        if (!match)
          continue

        const resolvedPaths = resolveIncludePath(match[1], dirname(docPath))
        for (const resolved of resolvedPaths) {
          if (this.wouldCreateCycle(docPath, resolved, new Set())) {
            const startPos = lines[i].indexOf(match[1])
            diagnostics.push({
              severity: DiagnosticSeverity.Warning,
              range: new Range(i, startPos, i, startPos + match[1].length),
              message: `Cyclic Include detected: "${match[1]}" eventually includes this file`,
              source: 'SSH Config',
            })
          }
        }
      }

      collection.set(doc.uri, diagnostics)
    }

    this.disposables.push(
      workspace.onDidOpenTextDocument(check),
      workspace.onDidChangeTextDocument(e => check(e.document)),
    )

    for (const doc of workspace.textDocuments) {
      check(doc)
    }
  }

  private wouldCreateCycle(originPath: string, includePath: string, visited: Set<string>): boolean {
    if (includePath === originPath)
      return true
    if (visited.has(includePath))
      return false
    visited.add(includePath)

    let content: string
    try {
      content = readFileSync(includePath, 'utf8')
    }
    catch {
      return false
    }

    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('#') || trimmed === '')
        continue
      const match = /^Include\s+(\S+)$/i.exec(trimmed)
      if (!match)
        continue

      const resolvedPaths = resolveIncludePath(match[1], dirname(includePath))
      for (const resolved of resolvedPaths) {
        if (this.wouldCreateCycle(originPath, resolved, visited))
          return true
      }
    }

    return false
  }

  dispose() {
    for (const d of this.disposables)
      d.dispose()
  }
}
