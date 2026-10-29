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
        var first = (row.message || '').split('\n')[0] || 'Error';
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
      if (v && v !== orig && /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535) {
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
      var port = /^\d+$/.test(v) ? Number(v) : undefined;
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
  // up. A push sent right after the webview loads races the script load and
  // the message gets dropped (e.g. when the webview is re-resolved after
  // being hidden), leaving the panel blank until the next state change.
  vscode.postMessage({ type: 'ready' });
})();
