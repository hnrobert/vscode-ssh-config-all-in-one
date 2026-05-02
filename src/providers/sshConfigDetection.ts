import type { Disposable } from 'vscode'
import { languages, workspace } from 'vscode'

const SSH_KEYWORDS = [
  'HostName',
  'User',
  'Port',
  'IdentityFile',
  'ProxyCommand',
  'ProxyJump',
  'ForwardAgent',
  'ForwardX11',
  'LocalForward',
  'RemoteForward',
  'DynamicForward',
  'StrictHostKeyChecking',
  'UserKnownHostsFile',
  'AddKeysToAgent',
  'UseKeychain',
  'HostKeyAlgorithms',
  'PubkeyAuthentication',
  'PasswordAuthentication',
  'GSSAPIAuthentication',
  'ConnectTimeout',
  'ServerAliveInterval',
  'ServerAliveCountMax',
  'Compression',
  'LogLevel',
  'SendEnv',
  'SetEnv',
  'UpdateHostKeys',
  'CanonicalDomains',
  'CanonicalizeHostname',
  'Match',
  'Include',
  'IgnoreUnknown',
  'IdentitiesOnly',
  'PreferredAuthentications',
  'AddressFamily',
  'BatchMode',
  'BindAddress',
  'CanonicalizeFallbackLocal',
  'CanonicalizeMaxDots',
  'ChallengeResponseAuthentication',
  'CheckHostIP',
  'Cipher',
  'Ciphers',
  'ClearAllForwardings',
  'ConnectionAttempts',
  'ControlMaster',
  'ControlPath',
  'ControlPersist',
  'EnableSSHKeysign',
  'EscapeChar',
  'ExitOnForwardFailure',
  'FingerprintHash',
  'GatewayPorts',
  'GlobalKnownHostsFile',
  'HostbasedAuthentication',
  'HostKeyAlias',
  'IPQoS',
  'KbdInteractiveAuthentication',
  'KexAlgorithms',
  'LocalCommand',
  'MACs',
  'NoHostAuthenticationForLocalhost',
  'NumberOfPasswordPrompts',
  'PermitLocalCommand',
  'PKCS11Provider',
  'Protocol',
  'ProxyUseFdpass',
  'RekeyLimit',
  'RequestTTY',
  'RevokedHostKeys',
  'StreamLocalBindMask',
  'StreamLocalBindUnlink',
  'TCPKeepAlive',
  'Tunnel',
  'TunnelDevice',
  'UsePrivilegedPort',
  'VerifyHostKeyDNS',
  'VisualHostKey',
  'XAuthLocation',
]

// eslint-disable-next-line regexp/no-unused-capturing-group
const KEYWORD_RE = new RegExp(`^\\s+(${SSH_KEYWORDS.join('|')})\\b`, 'i')
const BLOCK_RE = /^\s*(?:Host|Match)\s+\S/
const MAX_CHECK_LINES = 100

function isSSHConfigContent(text: string): boolean {
  let hasBlock = false
  let hasKeyword = false

  for (const line of text.split('\n').slice(0, MAX_CHECK_LINES)) {
    if (BLOCK_RE.test(line))
      hasBlock = true
    if (KEYWORD_RE.test(line))
      hasKeyword = true
    if (hasBlock && hasKeyword)
      return true
  }

  return false
}

export function registerSSHConfigDetection(disposables: Disposable[]): void {
  disposables.push(workspace.onDidOpenTextDocument(async (doc) => {
    const cfg = workspace.getConfiguration('sshConfigAllInOne.detection')
    if (!cfg.get<boolean>('enabled', true))
      return

    if (doc.languageId === 'ssh_config')
      return

    // Only check files whose language is not already identified as a specific language
    const knownLangs = new Set([
      'json',
      'yaml',
      'yml',
      'xml',
      'html',
      'css',
      'javascript',
      'typescript',
      'python',
      'java',
      'c',
      'cpp',
      'go',
      'rust',
      'ruby',
      'php',
      'sql',
      'sh',
      'bash',
      'powershell',
      'dockerfile',
      'ini',
      'toml',
      'markdown',
      'lua',
      'perl',
      'r',
      'swift',
      'kotlin',
      'dart',
      'scala',
      'groovy',
      'makefile',
      'csv',
      'properties',
      'gitignore',
      'editorconfig',
    ])
    if (knownLangs.has(doc.languageId))
      return

    // Check filename contains "config"
    const fileName = doc.uri.path.split('/').pop() ?? ''
    if (!/config/i.test(fileName))
      return

    if (!isSSHConfigContent(doc.getText()))
      return

    try {
      await languages.setTextDocumentLanguage(doc, 'ssh_config')
    }
    catch {
      // setTextDocumentLanguage can fail for untitled/invalid docs
    }
  }))
}
