import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SSHConfigOption {
  label: string
  documentation: string
}

export interface SSHConfigParameter {
  keyword: string
  value: string
}

/**
 * options.json documents verbatim text from the ssh_config(5) man page, which
 * uses roff quoting (``value'' and `value'). Both render broken in Markdown
 * (backticks turn into code-span delimiters), so rewrite them as proper inline
 * code. Trailing punctuation that roff pulled inside the quotes is moved back
 * out (``yes ,'' → `yes`,).
 */
function toMarkdownDocumentation(options: SSHConfigOption[]): SSHConfigOption[] {
  return options.map(option => ({
    ...option,
    documentation: option.documentation
      .replace(/``([^`]+)''|`([^`\n']+)'/g, (_, double: string, single: string) => `\`${double ?? single}\``)
      .replace(/`([^`,.;:]*)([,.;:]+)`/g, (_, content: string, punct: string) => `\`${content.trimEnd()}\`${punct}`),
  }))
}

export const SSH_CONFIG_OPTIONS: readonly SSHConfigOption[] = Object.freeze(
  toMarkdownDocumentation(
    JSON.parse(
      readFileSync(join(__dirname, '..', 'thirdparty', 'options.json'), 'utf8'),
    ) as SSHConfigOption[],
  ),
)

export const SSH_CONFIG_KEYWORDS: readonly string[] = Object.freeze(
  SSH_CONFIG_OPTIONS.map(option => option.label),
)

const canonicalKeywords = new Map(
  SSH_CONFIG_KEYWORDS.map(keyword => [keyword.toLowerCase(), keyword]),
)

const repeatableParameters = new Set([
  'certificatefile',
  'dynamicforward',
  'identityfile',
  'localforward',
  'remoteforward',
  'sendenv',
  'setenv',
])

const argumentFlags: Record<string, string> = {
  bindaddress: '-b',
  bindinterface: '-B',
  ciphers: '-c',
  controlpath: '-S',
  dynamicforward: '-D',
  escapechar: '-e',
  identityfile: '-i',
  localforward: '-L',
  macs: '-m',
  pkcs11provider: '-I',
  port: '-p',
  proxyjump: '-J',
  remoteforward: '-R',
  tag: '-P',
}

export function parseSSHConfigParameter(line: string): SSHConfigParameter | undefined {
  const trimmed = line.trim()
  const separatorIndex = trimmed.search(/[=\s]/)
  if (separatorIndex <= 0)
    return undefined

  const rawKeyword = trimmed.slice(0, separatorIndex)
  if (!/^[a-z][a-z\d]*$/i.test(rawKeyword))
    return undefined

  let value = trimmed.slice(separatorIndex).trim()
  if (value.startsWith('='))
    value = value.slice(1).trim()
  if (!value)
    return undefined

  const keyword = canonicalKeywords.get(rawKeyword.toLowerCase()) || rawKeyword
  return { keyword, value }
}

function parseConfigArguments(value: string): string[] {
  const result: string[] = []
  let current = ''
  let escaped = false
  let quoted = false
  let started = false

  for (const character of value.trim()) {
    if (escaped) {
      current += character
      escaped = false
      started = true
      continue
    }
    if (character === '\\') {
      escaped = true
      started = true
      continue
    }
    if (character === '"') {
      quoted = !quoted
      started = true
      continue
    }
    if (/\s/.test(character) && !quoted) {
      if (started) {
        result.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += character
    started = true
  }

  if (escaped)
    current += '\\'
  if (started)
    result.push(current)

  return result
}

export function parseSSHHostPatterns(value: string): string[] {
  return parseConfigArguments(value).filter(pattern =>
    !pattern.startsWith('!') && !pattern.includes('*') && !pattern.includes('?'),
  )
}

function firstConfigArgument(value: string): string {
  return parseConfigArguments(value)[0] || value.trim()
}

function formatForward(value: string): string {
  const parts = parseConfigArguments(value)
  return parts.length > 1 ? parts.join(':') : (parts[0] || value.trim())
}

function quoteShellArgument(value: string): string {
  if (/^[\w@%+=:,./~-]+$/.test(value))
    return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function renderGenericParameter(parameter: SSHConfigParameter): string[] {
  return ['-o', `${parameter.keyword}=${parameter.value}`]
}

function renderParameter(parameter: SSHConfigParameter): string[] {
  const normalizedKeyword = parameter.keyword.toLowerCase()
  const value = firstConfigArgument(parameter.value)
  const argumentFlag = argumentFlags[normalizedKeyword]

  if (argumentFlag) {
    const argument = normalizedKeyword === 'localforward' || normalizedKeyword === 'remoteforward'
      ? formatForward(parameter.value)
      : value
    return argument ? [argumentFlag, argument] : renderGenericParameter(parameter)
  }

  switch (normalizedKeyword) {
    case 'addressfamily':
      if (value.toLowerCase() === 'inet')
        return ['-4']
      if (value.toLowerCase() === 'inet6')
        return ['-6']
      break
    case 'compression':
      if (value.toLowerCase() === 'yes')
        return ['-C']
      break
    case 'controlmaster':
      if (value.toLowerCase() === 'yes')
        return ['-M']
      if (value.toLowerCase() === 'ask')
        return ['-MM']
      break
    case 'forkafterauthentication':
      if (value.toLowerCase() === 'yes')
        return ['-f']
      break
    case 'forwardagent':
      if (value.toLowerCase() === 'yes')
        return ['-A']
      if (value.toLowerCase() === 'no')
        return ['-a']
      break
    case 'forwardx11':
      if (value.toLowerCase() === 'yes')
        return ['-X']
      if (value.toLowerCase() === 'no')
        return ['-x']
      break
    case 'gatewayports':
      if (value.toLowerCase() === 'yes')
        return ['-g']
      break
    case 'requesttty':
      if (value.toLowerCase() === 'yes')
        return ['-t']
      if (value.toLowerCase() === 'force')
        return ['-tt']
      if (value.toLowerCase() === 'no')
        return ['-T']
      break
    case 'sessiontype':
      if (value.toLowerCase() === 'none')
        return ['-N']
      break
    case 'stdinnull':
      if (value.toLowerCase() === 'yes')
        return ['-n']
      break
  }

  return renderGenericParameter(parameter)
}

export class SSHHost {
  public readonly parameters: readonly SSHConfigParameter[]

  static parseConfig(content: string, configFile: string): SSHHost[] {
    const hosts: SSHHost[] = []
    let currentHostPatterns: string[] = []
    let currentParameters: SSHConfigParameter[] = []
    let currentLineNumber = 0
    let lineNumber = 0

    const addCurrentHosts = () => {
      for (const host of currentHostPatterns)
        hosts.push(new SSHHost(host, currentParameters, configFile, currentLineNumber))
    }

    for (const line of content.split('\n')) {
      lineNumber++
      const trimmed = line.trim()
      if (trimmed.startsWith('#') || trimmed === '')
        continue

      const parameter = parseSSHConfigParameter(line)
      if (!parameter)
        continue

      const normalizedKeyword = parameter.keyword.toLowerCase()
      if (normalizedKeyword === 'host') {
        addCurrentHosts()
        currentHostPatterns = parseSSHHostPatterns(parameter.value)
        currentParameters = []
        currentLineNumber = lineNumber
        continue
      }

      if (normalizedKeyword === 'match') {
        addCurrentHosts()
        currentHostPatterns = []
        currentParameters = []
        currentLineNumber = 0
        continue
      }

      if (currentHostPatterns.length > 0)
        currentParameters.push(parameter)
    }

    addCurrentHosts()
    return hosts
  }

  constructor(
    public readonly host: string,
    parameters: readonly SSHConfigParameter[],
    public readonly configFile: string,
    public readonly lineNumber: number,
  ) {
    this.parameters = Object.freeze(
      parameters.map(parameter => Object.freeze({ ...parameter })),
    )
  }

  get hostname(): string | undefined {
    return this.getParameter('HostName')
  }

  get user(): string | undefined {
    return this.getParameter('User')
  }

  get port(): string | undefined {
    return this.getParameter('Port')
  }

  get identityFile(): string | undefined {
    return this.getParameter('IdentityFile')
  }

  getParameter(keyword: string): string | undefined {
    const normalizedKeyword = keyword.toLowerCase()
    const parameter = this.parameters.find(item => item.keyword.toLowerCase() === normalizedKeyword)
    return parameter ? firstConfigArgument(parameter.value) : undefined
  }

  getParameters(keyword: string): string[] {
    const normalizedKeyword = keyword.toLowerCase()
    return this.parameters
      .filter(item => item.keyword.toLowerCase() === normalizedKeyword)
      .map(item => item.value)
  }

  withConfigFile(configFile: string): SSHHost {
    return new SSHHost(this.host, this.parameters, configFile, this.lineNumber)
  }

  toSSHCommand(): string {
    const hostname = this.hostname || this.host
    const target = this.user ? `${this.user}@${hostname}` : hostname
    const renderedParameters: string[] = []
    const seenParameters = new Set<string>()

    for (const parameter of this.parameters) {
      const normalizedKeyword = parameter.keyword.toLowerCase()
      if (normalizedKeyword === 'hostname' || normalizedKeyword === 'user')
        continue
      if (!repeatableParameters.has(normalizedKeyword) && seenParameters.has(normalizedKeyword))
        continue

      seenParameters.add(normalizedKeyword)
      renderedParameters.push(...renderParameter(parameter))
    }

    return ['ssh', ...renderedParameters, target]
      .map(quoteShellArgument)
      .join(' ')
  }
}
