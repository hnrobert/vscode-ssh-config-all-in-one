import type { Disposable, Webview, WebviewView, WebviewViewProvider } from 'vscode'
import type { PortForwardManager } from './portForward'
import { env, Uri, window, workspace } from 'vscode'
import { parseSSHConfig } from '../utils/sshConfig'
import { getCurrentSSHHost } from '../utils/sshDetection'
import { promptAndAddPortForward } from './portForward'

interface PanelMessage {
  type: string
  id?: string
  field?: 'listen' | 'dest'
  port?: number
  host?: string
}

/**
 * The SSH Tunnels panel — a webview view in the bottom panel, styled after
 * VS Code's built-in Ports view. Each row is an `ssh -N -L/-R` tunnel whose
 * direction, host and both-sided addresses are editable in place.
 *
 * The webview assets (panel.html / panel.css / panel.js) live in
 * media/sshTunnels and are loaded through asWebviewUri, so the script is
 * plain JavaScript — no TS template-literal escaping to trip over.
 */
export class SSHTunnelsPanelProvider implements WebviewViewProvider, Disposable {
  static readonly viewId = 'vscode-ssh-config-all-in-one.sshTunnels'

  private view: WebviewView | undefined
  private readonly listener: Disposable

  constructor(
    private readonly manager: PortForwardManager,
    private readonly extensionUri: Uri,
  ) {
    this.listener = manager.onDidChange(() => this.pushState())
  }

  dispose(): void {
    this.listener.dispose()
  }

  async resolveWebviewView(view: WebviewView): Promise<void> {
    this.view = view
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    }
    view.webview.html = await this.buildHtml(view.webview)
    view.webview.onDidReceiveMessage((msg: PanelMessage) => {
      void this.onMessage(msg)
    })
    this.pushState()
  }

  private pushState(): void {
    const view = this.view
    if (!view)
      return
    void (async () => {
      // The webview auto-filters to the window's current SSH remote, if any.
      const currentHost = await getCurrentSSHHost()
      // The webview is destroyed while hidden; posting to it rejects, which is fine.
      view.webview
        .postMessage({ type: 'state', rows: this.manager.getViewRows(), currentHost: currentHost ?? '' })
        .then(undefined, () => {})
    })()
  }

  private async onMessage(msg: PanelMessage): Promise<void> {
    const id = msg.id ?? ''
    switch (msg.type) {
      case 'ready':
        this.pushState()
        break
      case 'quickAdd':
        await promptAndAddPortForward(this.manager, msg.host)
        break
      case 'toggle':
        this.manager.toggle(id)
        break
      case 'delete':
        await this.manager.removeRule(id)
        break
      case 'direction':
        await this.manager.toggleDirection(id)
        break
      case 'host':
        await this.pickHost(id)
        break
      case 'edit':
        if (!msg.field)
          break
        await this.manager.updateRule(id, msg.field === 'listen'
          ? { listenPort: Number(msg.port) }
          : { destHost: msg.host || 'localhost', destPort: Number(msg.port) })
        break
      case 'openBrowser':
        await this.openInBrowser(id)
        break
    }
  }

  private async pickHost(id: string): Promise<void> {
    const hosts = await parseSSHConfig()
    const picked = await window.showQuickPick(
      hosts.map(h => ({ label: h.host, description: h.hostname })),
      { placeHolder: 'Forward through which host?', matchOnDescription: true },
    )
    if (picked)
      await this.manager.changeHost(id, picked.label)
  }

  private async openInBrowser(id: string): Promise<void> {
    const row = this.manager.getViewRows().find(r => r.id === id)
    if (!row)
      return
    // The globe only shows on -L rows, where ssh listens on this machine
    // (loopback, since bind addresses were dropped from the rule model).
    await env.openExternal(Uri.parse(`http://localhost:${row.listenPort}/`))
  }

  private async buildHtml(webview: Webview): Promise<string> {
    const base = Uri.joinPath(this.extensionUri, 'media', 'sshTunnels')
    const cssUri = webview.asWebviewUri(Uri.joinPath(base, 'panel.css'))
    const scriptUri = webview.asWebviewUri(Uri.joinPath(base, 'panel.js'))
    const csp = [
      'default-src \'none\'',
      `style-src ${webview.cspSource}`,
      `script-src ${webview.cspSource}`,
    ].join('; ')

    const template = new TextDecoder('utf-8').decode(
      await workspace.fs.readFile(Uri.joinPath(base, 'panel.html')),
    )
    return template
      .replace(/\{\{csp\}\}/g, () => csp)
      .replace(/\{\{cssUri\}\}/g, () => cssUri.toString())
      .replace(/\{\{scriptUri\}\}/g, () => scriptUri.toString())
  }
}
