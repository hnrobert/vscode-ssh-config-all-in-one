/* eslint-disable no-template-curly-in-string */
import type {
  CompletionItemProvider,
  Disposable,
  Position,
  SignatureHelpProvider,
  TextDocument,
} from 'vscode'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  CompletionItem,
  CompletionItemKind,
  languages,
  MarkdownString,
  ParameterInformation,
  SignatureHelp,
  SignatureInformation,
  SnippetString,
} from 'vscode'
import { SSH_CONFIG_OPTIONS } from '../models/SSHHost'
import { DOCUMENT_PROVIDER } from './utils'

const blockKeywords = new Set(['Host', 'Match'])
const topLevelKeywords = ['Host', 'Match', 'Include']
const INCLUDE_RE = /^Include\s+(\S*)$/

const ENUM_VALUES: Record<string, readonly string[]> = {
  LogLevel: ['QUIET', 'FATAL', 'ERROR', 'INFO', 'VERBOSE', 'DEBUG', 'DEBUG1', 'DEBUG2', 'DEBUG3'],
  StrictHostKeyChecking: ['yes', 'no', 'ask'],
  AddKeysToAgent: ['yes', 'no', 'ask', 'confirm'],
  ControlMaster: ['yes', 'no', 'ask', 'auto', 'autoask'],
  RequestTTY: ['no', 'yes', 'force', 'auto'],
  AddressFamily: ['any', 'inet', 'inet6'],
  FingerprintHash: ['md5', 'sha256'],
  ForwardAgent: ['yes', 'no'],
  ForwardX11: ['yes', 'no'],
  Compression: ['yes', 'no'],
  PubkeyAuthentication: ['yes', 'no'],
  PasswordAuthentication: ['yes', 'no'],
  BatchMode: ['yes', 'no'],
  IdentitiesOnly: ['yes', 'no'],
  TCPKeepAlive: ['yes', 'no'],
  GatewayPorts: ['yes', 'no'],
  ExitOnForwardFailure: ['yes', 'no'],
  UseKeychain: ['yes', 'no'],
}

// ssh_config keys are case-insensitive; map lowercase spellings to their enum values
const ENUM_VALUES_LOWER: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries(ENUM_VALUES).map(([key, values]) => [key.toLowerCase(), values]),
)

interface DirectiveSignature {
  label: string
  documentation: string
  params: { label: string, documentation: string }[]
  /** When set, the last parameter repeats (space-separated list). */
  variadic?: boolean
}

// Friendliest argument labels for single-value directives that have no
// curated multi-argument signature; anything else falls back to `value`.
const ARG_LABELS: ReadonlyMap<string, string> = new Map(Object.entries({
  hostname: 'hostname',
  port: 'port',
  user: 'username',
  identityfile: 'file',
  certificatefile: 'file',
  controlpath: 'path',
  proxyjump: '[user@]host[:port]',
  proxycommand: 'command',
  remotecommand: 'command',
  knownhostscommand: 'command',
  localcommand: 'command',
  logverbose: 'pattern',
  bindaddress: 'address',
  bindinterface: 'interface',
  casignaturealgorithms: 'algorithm list',
  ciphers: 'cipher list',
  macs: 'mac list',
  kexalgorithms: 'algorithm list',
  hostkeyalgorithms: 'algorithm list',
  pkcs11provider: 'provider',
  securitykeyprovider: 'provider',
  revokedhostkeys: 'file',
  userknownhostsfile: 'file list',
  globalknownhostsfile: 'file list',
  controlpersist: 'yes | no | [hh:]mm:ss',
  serveraliveinterval: 'seconds',
  serveralivecountmax: 'count',
  connecttimeout: 'seconds',
  forwardx11timeout: 'time format',
}))

// Directives taking several space-separated arguments: shown as parameter
// hints instead of completions while the arguments are typed.
const SIGNATURES: ReadonlyMap<string, DirectiveSignature> = new Map(Object.entries({
  localforward: {
    label: 'LocalForward [bind_address:]port host:hostport',
    documentation: 'Listen on a local port and forward connections through the remote host.',
    params: [
      { label: '[bind_address:]port', documentation: 'Local port to listen on, optionally prefixed by a bind address (e.g. `8080` or `127.0.0.1:8080`).' },
      { label: 'host:hostport', documentation: 'Destination as seen from the remote host (e.g. `localhost:80`).' },
    ],
  },
  remoteforward: {
    label: 'RemoteForward [bind_address:]port [host:hostport]',
    documentation: 'Listen on a port on the remote host and forward connections back through this machine. Omit the destination for a dynamic (SOCKS) remote forward.',
    params: [
      { label: '[bind_address:]port', documentation: 'Remote port to listen on, optionally prefixed by a bind address (needs sshd `GatewayPorts` to bind beyond loopback).' },
      { label: '[host:hostport]', documentation: 'Destination as seen from this machine (e.g. `localhost:3000`).' },
    ],
  },
  dynamicforward: {
    label: 'DynamicForward [bind_address:]port',
    documentation: 'Open a local SOCKS proxy that forwards through the remote host.',
    params: [
      { label: '[bind_address:]port', documentation: 'Local port for the SOCKS proxy, optionally prefixed by a bind address.' },
    ],
  },
  sendenv: {
    label: 'SendEnv VARIABLE ...',
    documentation: 'Environment variables to send to the server (repeatable / space-separated).',
    params: [
      { label: 'VARIABLE', documentation: 'Environment variable name, may contain wildcards (e.g. `LANG`, `LC_*`).' },
    ],
    variadic: true,
  },
  setenv: {
    label: 'SetEnv NAME=VALUE ...',
    documentation: 'Environment variables to set in the session started by ssh.',
    params: [
      { label: 'NAME=VALUE', documentation: 'Assignment added to the session environment (e.g. `FOO=bar`).' },
    ],
    variadic: true,
  },
  permitremoteopen: {
    label: 'PermitRemoteOpen host:port ...',
    documentation: 'Remote forwarding destinations allowed when acting as a client; `none` forbids all, an empty list allows all.',
    params: [
      { label: 'host:port', documentation: 'Allowed destination, e.g. `localhost:8080`.' },
    ],
    variadic: true,
  },
  include: {
    label: 'Include file ...',
    documentation: 'Include the listed config files (tilde-expanded, glob patterns allowed).',
    params: [
      { label: 'file', documentation: 'Path or glob, relative paths resolve against `~/.ssh`.' },
    ],
    variadic: true,
  },
  rekeylimit: {
    label: 'RekeyLimit data [at interval]',
    documentation: 'Session key re-exchange thresholds.',
    params: [
      { label: 'data', documentation: 'Max data before rekeying, e.g. `1G`; `default` to only use the second limit.' },
      { label: 'at: interval', documentation: 'Optional time before rekeying, e.g. `at 1h`.' },
    ],
  },
}))

const OPTIONS_LOWER: ReadonlyMap<string, { label: string, documentation: string }> = new Map(
  SSH_CONFIG_OPTIONS.map(o => [o.label.toLowerCase(), { label: o.label, documentation: o.documentation }]),
)

function isInHostBlock(document: TextDocument, line: number): boolean {
  const currentLine = document.lineAt(line).text
  if (/^\s*(?:Host|Match)\s/i.test(currentLine))
    return false
  if (/^\s/.test(currentLine))
    return true
  return false
}

function resolveIncludeBasePath(partial: string): { dir: string, prefix: string } {
  if (partial.startsWith('~')) {
    const expanded = partial.replace(/^~/, homedir())
    const dir = partial.endsWith('/') ? expanded : dirname(expanded)
    const prefix = partial.endsWith('/') ? '' : basename(expanded)
    return { dir, prefix }
  }
  if (partial.startsWith('/')) {
    const dir = partial.endsWith('/') ? partial : dirname(partial)
    const prefix = partial.endsWith('/') ? '' : basename(partial)
    return { dir, prefix }
  }
  // No prefix: relative to ~/.ssh/
  const sshDir = join(homedir(), '.ssh')
  if (!partial) {
    return { dir: sshDir, prefix: '' }
  }
  const fullPath = join(sshDir, partial)
  const dir = partial.endsWith('/') ? fullPath : dirname(fullPath)
  const prefix = partial.endsWith('/') ? '' : basename(fullPath)
  return { dir, prefix }
}

export class SSHCompletionItemsProvider implements CompletionItemProvider, SignatureHelpProvider {
  constructor(disposables: Disposable[]) {
    disposables.push(languages.registerCompletionItemProvider(DOCUMENT_PROVIDER, this, ' ', '/', '~'))
    disposables.push(languages.registerSignatureHelpProvider(DOCUMENT_PROVIDER, this, ' '))
  }

  provideSignatureHelp(document: TextDocument, position: Position): SignatureHelp | undefined {
    const prefix = document.lineAt(position.line).text.slice(0, position.character)
    if (/^\s*(?:#|Host\s|Match\s)/i.test(prefix))
      return undefined
    const match = /^\s*(\w+)(\s.*)$/.exec(prefix)
    if (!match)
      return undefined
    const keyword = match[1].toLowerCase()

    const curated = SIGNATURES.get(keyword)
    const args = match[2].trim().split(/\s+/).filter(Boolean)
    const active = /\s$/.test(match[2]) ? args.length : args.length - 1

    let info: SignatureInformation
    if (curated) {
      if (!curated.variadic && active >= curated.params.length)
        return undefined
      info = new SignatureInformation(curated.label, new MarkdownString(curated.documentation))
      info.parameters = curated.params.map(p => new ParameterInformation(p.label, new MarkdownString(p.documentation)))
    }
    else {
      // Generic hint for every other directive: one value parameter, labeled
      // by its enum choices / argument shape, documented from ssh_config(5).
      const option = OPTIONS_LOWER.get(keyword)
      if (!option || active > 0)
        return undefined
      const enums = ENUM_VALUES[option.label]
      const argLabel = enums ? enums.join(' | ') : (ARG_LABELS.get(keyword) ?? 'value')
      // The ssh_config(5) text goes on the parameter only — putting it on
      // the signature too makes the widget render it twice.
      info = new SignatureInformation(`${option.label} ${argLabel}`)
      info.parameters = [new ParameterInformation(argLabel, new MarkdownString(option.documentation))]
    }

    const help = new SignatureHelp()
    help.signatures = [info]
    help.activeSignature = 0
    help.activeParameter = Math.max(Math.min(active, info.parameters.length - 1), 0)
    return help
  }

  async provideCompletionItems(document: TextDocument, position: Position): Promise<CompletionItem[] | undefined> {
    const line = document.lineAt(position.line)
    const prefix = line.text.slice(0, position.character)

    if (/^\s*#/.test(prefix))
      return undefined
    if (/^\s*Host\s/i.test(prefix))
      return undefined
    // Check if we're typing a path after Include
    const includeMatch = INCLUDE_RE.exec(prefix.trimEnd())
    if (includeMatch) {
      return this.providePathCompletions(includeMatch[1])
    }

    const valueMatch = /^\s*(\w+)\s+$/.exec(prefix)
    if (valueMatch) {
      const values = ENUM_VALUES_LOWER.get(valueMatch[1].toLowerCase())
      if (values) {
        return values.map((v) => {
          const item = new CompletionItem(v, CompletionItemKind.Value)
          item.sortText = v
          return item
        })
      }
      return undefined
    }

    // Past the first argument of a directive (e.g. the second LocalForward
    // value): no keyword suggestions — parameter hints cover it.
    if (/^\s*\w+\s+\S/.test(prefix))
      return undefined

    const inBlock = isInHostBlock(document, position.line)
    const items: CompletionItem[] = []

    if (!inBlock) {
      for (const label of topLevelKeywords) {
        const opt = SSH_CONFIG_OPTIONS.find(o => o.label === label)
        const item = new CompletionItem(label, CompletionItemKind.Keyword)
        item.documentation = new MarkdownString(opt?.documentation || '')
        item.insertText = `${label} `
        item.sortText = `0-${label}`
        items.push(item)
      }
      items.push(this.createHostSnippet())
      items.push(this.createTunnelsSnippet())
      items.push(this.createIncusSnippet())
    }
    else {
      const currentWord = prefix.trim()
      for (const opt of SSH_CONFIG_OPTIONS) {
        if (blockKeywords.has(opt.label))
          continue
        if (currentWord === opt.label)
          continue
        const item = new CompletionItem(opt.label, CompletionItemKind.Property)
        item.documentation = new MarkdownString(opt.documentation)
        item.insertText = this.getInsertText(opt.label)
        if (ENUM_VALUES[opt.label]) {
          item.command = { command: 'editor.action.triggerSuggest', title: 'Trigger value suggestions' }
        }
        else {
          // Every non-enum directive has parameter hints (curated or the
          // generic fallback) — pop them as soon as the keyword lands.
          item.command = { command: 'editor.action.triggerParameterHints', title: 'Trigger parameter hints' }
        }
        item.sortText = opt.label
        items.push(item)
      }
    }

    return items
  }

  private providePathCompletions(partial: string): CompletionItem[] {
    const { dir, prefix } = resolveIncludeBasePath(partial)

    if (!existsSync(dir))
      return []

    let entries: string[]
    try {
      entries = readdirSync(dir)
    }
    catch {
      return []
    }

    const filtered = prefix ? entries.filter(e => e.startsWith(prefix)) : entries
    const items: CompletionItem[] = []

    for (const entry of filtered) {
      if (entry.startsWith('.'))
        continue

      const fullPath = join(dir, entry)
      let isDir = false
      try {
        isDir = statSync(fullPath).isDirectory()
      }
      catch {
        continue
      }

      // / is a word boundary in VS Code, so insertText = just the entry name.
      // VS Code replaces only the last path component automatically.
      if (isDir) {
        const item = new CompletionItem(entry, CompletionItemKind.Folder)
        item.insertText = `${entry}/`
        item.sortText = `0-${entry}`
        items.push(item)
      }
      else {
        const item = new CompletionItem(entry, CompletionItemKind.File)
        item.insertText = entry
        item.sortText = `1-${entry}`
        items.push(item)
      }
    }

    return items
  }

  private getInsertText(label: string): string {
    return `${label} `
  }

  private createHostSnippet(): CompletionItem {
    const item = new CompletionItem('Host (template)', CompletionItemKind.Snippet)
    item.documentation = 'Insert a basic Host configuration template.'
    item.insertText = new SnippetString('Host ${1:alias}\n\tHostName ${2:hostname}\n\tUser ${3:user}\n\tPort ${4:22}')
    item.sortText = '1-host-tpl'
    return item
  }

  private createTunnelsSnippet(): CompletionItem {
    const item = new CompletionItem('Configure Tunnels', CompletionItemKind.Snippet)
    item.documentation = 'Insert a template for configuring a tunnel connection.'
    item.insertText = new SnippetString('Host ${1:alias}\n\tHostName ${2:fqn}\n\tLocalForward ${4:port} ${5:localhost}:${4:port}\n\tUser ${6:user}')
    item.sortText = '2-tunnels'
    return item
  }

  private createIncusSnippet(): CompletionItem {
    const item = new CompletionItem('Configure Incus', CompletionItemKind.Snippet)
    item.documentation = 'Creates incus and root-incus on demand.'
    item.insertText = new SnippetString('Host ${1:alias}\n\tHostName ${1:alias}.incus\n\tUser dev\n\nHost root-${1:alias}\n\tHostName root-${1:fqn}.incus\n')
    item.sortText = '3-incus'
    return item
  }
}
