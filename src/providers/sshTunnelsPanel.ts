import type { Disposable, Webview, WebviewView, WebviewViewProvider } from 'vscode'
import type { PortForwardManager } from './portForward'
import { randomUUID } from 'node:crypto'
import { env, Uri, window } from 'vscode'
import { parseSSHConfig } from '../utils/sshConfig'
import { promptAndAddPortForward } from './portForward'

interface PanelMessage {
  type: string
  id?: string
  field?: 'local' | 'remote'
  address?: string
  port?: number
}

/**
 * The SSH Tunnels panel — a webview view in the bottom panel, styled after
 * VS Code's built-in Ports view. Each row is an `ssh -N -L/-R` tunnel whose
 * direction, host and both-sided addresses are editable in place.
 */
export class SSHTunnelsPanelProvider implements WebviewViewProvider, Disposable {
  static readonly viewId = 'vscode-ssh-config-all-in-one.sshTunnels'

  private view: WebviewView | undefined
  private readonly listener: Disposable

  constructor(private readonly manager: PortForwardManager) {
    this.listener = manager.onDidChange(() => this.pushState())
  }

  dispose(): void {
    this.listener.dispose()
  }

  resolveWebviewView(view: WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true }
    view.webview.html = this.buildHtml(view.webview)
    view.webview.onDidReceiveMessage((msg: PanelMessage) => {
      void this.onMessage(msg)
    })
    this.pushState()
  }

  private pushState(): void {
    // The webview is destroyed while hidden; posting to it rejects, which is fine.
    this.view?.webview
      .postMessage({ type: 'state', rows: this.manager.getViewRows() })
      .then(undefined, () => {})
  }

  private async onMessage(msg: PanelMessage): Promise<void> {
    const id = msg.id ?? ''
    switch (msg.type) {
      case 'ready':
        this.pushState()
        break
      case 'quickAdd':
        await promptAndAddPortForward(this.manager, undefined, msg.port)
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
        await this.manager.updateRule(id, msg.field === 'local'
          ? { localAddress: msg.address || 'localhost', localPort: Number(msg.port) }
          : { remoteAddress: msg.address || 'localhost', remotePort: Number(msg.port) })
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
    const host = !row.localAddress || row.localAddress === '0.0.0.0' ? 'localhost' : row.localAddress
    await env.openExternal(Uri.parse(`http://${host}:${row.localPort}/`))
  }

  private buildHtml(webview: Webview): string {
    const nonce = randomUUID()
    const csp = [
      'default-src \'none\'',
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ')

    const style = `
      * { box-sizing: border-box; }
      body {
        margin: 0;
        display: flex;
        flex-direction: column;
        height: 100vh;
        overflow: hidden;
        background: var(--vscode-panel-background);
        color: var(--vscode-foreground);
        font-family: var(--vscode-font-family);
        font-size: 13px;
      }
      header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        flex: none;
        border-bottom: 1px solid var(--vscode-panel-border);
      }
      #portInput {
        width: 150px;
        height: 26px;
        padding: 0 8px;
        border: none;
        border-radius: 2px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        outline: 1px solid transparent;
      }
      #portInput:focus { outline: 1px solid var(--vscode-focusBorder); }
      #portInput::placeholder { color: var(--vscode-input-placeholderForeground); }
      .icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        border: none;
        border-radius: 5px;
        background: transparent;
        color: var(--vscode-foreground);
        cursor: pointer;
      }
      .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
      .icon-btn svg { width: 16px; height: 16px; }
      #tableWrap { flex: 1; overflow: auto; }
      table { width: 100%; border-collapse: collapse; table-layout: fixed; }
      th {
        position: sticky;
        top: 0;
        z-index: 1;
        background: var(--vscode-panel-background);
        text-align: left;
        font-weight: 400;
        font-size: 11px;
        padding: 5px 12px;
        color: var(--vscode-descriptionForeground);
        border-bottom: 1px solid var(--vscode-panel-border);
        white-space: nowrap;
      }
      td {
        padding: 0 12px;
        height: 26px;
        line-height: 26px;
        border-bottom: 1px solid var(--vscode-panel-border);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        vertical-align: middle;
        font-variant-numeric: tabular-nums;
      }
      tbody tr:hover td { background: var(--vscode-list-hoverBackground); }
      .cell-btn {
        all: unset;
        cursor: pointer;
        height: 22px;
        line-height: 22px;
        padding: 0 4px;
        margin-left: -4px;
        border-radius: 4px;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .cell-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
      .dir-local .dir-ic { color: var(--vscode-charts-blue); }
      .dir-remote .dir-ic { color: var(--vscode-charts-purple); }
      .dir-ic svg { width: 12px; height: 12px; display: block; }
      .editable { cursor: text; }
      .editable:hover {
        text-decoration: underline dotted 1px;
        text-underline-offset: 3px;
      }
      .cell-input {
        width: 100%;
        height: 22px;
        font: inherit;
        padding: 0 4px;
        margin: 0 -4px;
        border: none;
        border-radius: 2px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        outline: 1px solid var(--vscode-focusBorder);
      }
      .status {
        display: flex;
        align-items: center;
        gap: 6px;
        height: 26px;
      }
      .status .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
      .status.ok .dot { background: var(--vscode-charts-green); }
      .status.pending .dot { background: var(--vscode-charts-yellow); }
      .status.err .dot { background: var(--vscode-charts-red); }
      .status.off .dot { background: var(--vscode-descriptionForeground); opacity: .5; }
      .status.err { color: var(--vscode-errorForeground); }
      .status.off { color: var(--vscode-descriptionForeground); }
      .row-actions {
        display: flex;
        gap: 2px;
        justify-content: flex-end;
        visibility: hidden;
      }
      tr:hover .row-actions, tr:focus-within .row-actions { visibility: visible; }
      .empty {
        padding: 24px;
        text-align: center;
        color: var(--vscode-descriptionForeground);
      }
    `

    const script = `
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();
  var rows = [];

  var I = {
    play: '<svg viewBox="0 0 16 16"><path d="M4.5 2.8v10.4L13 8z" fill="currentColor"/></svg>',
    stop: '<svg viewBox="0 0 16 16"><rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="currentColor"/></svg>',
    globe: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="8" cy="8" r="5.8"/><path d="M2.2 8h11.6M8 2.2c-2.2 2-2.2 9.6 0 11.6M8 2.2c2.2 2 2.2 9.6 0 11.6"/></svg>',
    trash: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M2.5 4h11M6.5 2h3M4 4l.7 9h6.6L12 4M6.6 7v3.5M9.4 7v3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    arrowR: '<svg viewBox="0 0 16 16" fill="none"><path d="M2 8h11M9.5 4.5 13 8l-3.5 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    arrowL: '<svg viewBox="0 0 16 16" fill="none"><path d="M14 8H3M6.5 4.5 3 8l3.5 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function dirInfo(row) {
    if (row.direction === 'local') {
      return {
        label: 'Listen Local (-L)',
        cls: 'dir-local',
        icon: I.arrowL,
        title: 'ssh -L — listen on this machine and tunnel to a destination reachable from the remote host (bring a remote service to localhost)'
      };
    }
    return {
      label: 'Listen Remote (-R)',
      cls: 'dir-remote',
      icon: I.arrowR,
      title: 'ssh -R — listen on the remote machine and tunnel back to a destination on this machine (expose a local service remotely)'
    };
  }

  function addrTitles(row) {
    if (row.direction === 'local') {
      return {
        local: 'Bind address on this machine. Click to edit host:port',
        remote: 'Destination on the remote network, resolved on the remote machine. Click to edit host:port'
      };
    }
    return {
      local: 'Destination on this machine. Click to edit host:port',
      remote: 'Bind address on the remote machine (sshd GatewayPorts may restrict this). Click to edit host:port'
    };
  }

  function statusInfo(row) {
    switch (row.status) {
      case 'running': return { cls: 'ok', text: 'Running' };
      case 'starting': return { cls: 'pending', text: 'Starting…' };
      case 'error': {
        var first = (row.message || '').split('\\n')[0] || 'Error';
        return { cls: 'err', text: first.length > 20 ? first.slice(0, 19) + '…' : first };
      }
      default: return { cls: 'off', text: 'Stopped' };
    }
  }

  function rowHtml(row) {
    var d = dirInfo(row);
    var t = addrTitles(row);
    var s = statusInfo(row);
    var active = row.status === 'running' || row.status === 'starting';
    var local = (row.localAddress || 'localhost') + ':' + row.localPort;
    var remote = (row.remoteAddress || 'localhost') + ':' + row.remotePort;
    var actions = [];
    if (row.direction === 'local') {
      actions.push('<button class="icon-btn" data-action="browser" title="Open in Browser">' + I.globe + '</button>');
    }
    actions.push(active
      ? '<button class="icon-btn" data-action="toggle" title="Stop Forwarding">' + I.stop + '</button>'
      : '<button class="icon-btn" data-action="toggle" title="Start Forwarding">' + I.play + '</button>');
    actions.push('<button class="icon-btn" data-action="delete" title="Remove Forward">' + I.trash + '</button>');
    return '<tr data-id="' + esc(row.id) + '" title="' + esc(row.message || d.title) + '">'
      + '<td><button class="cell-btn ' + d.cls + '" data-action="direction" title="' + esc(d.title) + '"><span class="dir-ic">' + d.icon + '</span>' + d.label + '</button></td>'
      + '<td><button class="cell-btn" data-action="host" title="Change the SSH host">' + esc(row.hostName) + '</button></td>'
      + '<td class="editable" data-action="edit" data-field="local" title="' + esc(t.local) + '">' + esc(local) + '</td>'
      + '<td class="editable" data-action="edit" data-field="remote" title="' + esc(t.remote) + '">' + esc(remote) + '</td>'
      + '<td><span class="status ' + s.cls + '" title="' + esc(row.message || s.text) + '"><span class="dot"></span>' + s.text + '</span></td>'
      + '<td><span class="row-actions">' + actions.join('') + '</span></td>'
      + '</tr>';
  }

  function render() {
    document.getElementById('tbody').innerHTML = rows.map(rowHtml).join('');
    document.getElementById('empty').hidden = rows.length > 0;
  }

  function startEdit(td, row, field) {
    if (td.querySelector('input')) {
      return;
    }
    var isLocal = field === 'local';
    var origAddr = isLocal ? (row.localAddress || 'localhost') : (row.remoteAddress || 'localhost');
    var origPort = isLocal ? row.localPort : row.remotePort;
    var orig = origAddr + ':' + origPort;
    var input = document.createElement('input');
    input.className = 'cell-input';
    input.value = orig;
    td.textContent = '';
    td.appendChild(input);
    input.focus();
    input.select();
    var done = false;
    var commit = function () {
      if (done) {
        return;
      }
      done = true;
      var v = input.value.trim();
      var addr = origAddr;
      var port = '';
      var ci = v.lastIndexOf(':');
      if (ci > 0) {
        addr = v.slice(0, ci);
        port = v.slice(ci + 1);
      } else {
        port = v;
      }
      if (v && v !== orig && /^\\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535) {
        vscode.postMessage({ type: 'edit', id: row.id, field: field, address: addr || 'localhost', port: Number(port) });
      } else {
        render();
      }
    };
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        commit();
      } else if (ev.key === 'Escape') {
        done = true;
        render();
      }
    });
    input.addEventListener('blur', commit);
  }

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (msg && msg.type === 'state') {
      rows = msg.rows;
      render();
    }
  });

  document.getElementById('addBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'quickAdd' });
  });

  var portInput = document.getElementById('portInput');
  portInput.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') {
      var v = portInput.value.trim();
      var port = /^\\d+$/.test(v) ? Number(v) : undefined;
      vscode.postMessage({ type: 'quickAdd', port: port });
      portInput.value = '';
    }
  });

  document.getElementById('tbody').addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (!el) {
      return;
    }
    var tr = el.closest('tr');
    if (!tr) {
      return;
    }
    var row = rows.find(function (r) { return r.id === tr.dataset.id; });
    if (!row) {
      return;
    }
    var action = el.dataset.action;
    if (action === 'edit') {
      startEdit(el, row, el.dataset.field);
    } else {
      vscode.postMessage({ type: action, id: row.id });
    }
  });

  // Handshake: ask the extension for the current state once this listener is
  // up. A push sent right after the html is set races the script load and the
  // message gets dropped (e.g. when the webview is re-resolved after being
  // hidden), leaving the panel blank until the next state change.
  vscode.postMessage({ type: 'ready' });
})();
`

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${style}</style>
</head>
<body>
<header>
  <input id="portInput" type="number" min="1" max="65535" placeholder="Port" title="Type a port and press Enter to forward it">
  <button id="addBtn" class="icon-btn" title="Forward a Port">
    <svg viewBox="0 0 16 16" fill="none"><path d="M8 2.5v11M2.5 8h11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
  </button>
</header>
<div id="tableWrap">
  <table>
    <colgroup>
      <col style="width:150px">
      <col>
      <col style="width:170px">
      <col style="width:170px">
      <col style="width:130px">
      <col style="width:92px">
    </colgroup>
    <thead>
      <tr>
        <th>Direction</th>
        <th>Host</th>
        <th>Local Address</th>
        <th>Remote Address</th>
        <th>Status</th>
        <th></th>
      </tr>
    </thead>
    <tbody id="tbody"></tbody>
  </table>
  <div id="empty" class="empty">No port forwards. Use the + button or right-click a host in the SSH Config explorer.</div>
</div>
<script nonce="${nonce}">${script}</script>
</body>
</html>`
  }
}
