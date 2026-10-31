(function () {
  'use strict';
  var vscode = acquireVsCodeApi();
  var rows = [];

  // Host filter. Follows the window's current SSH remote automatically;
  // a manual pick is kept until the remote context changes again.
  var saved = vscode.getState() || {};
  var filterHost = typeof saved.filterHost === 'string' ? saved.filterHost : '';
  var pinned = !!saved.pinned && !!filterHost;
  var lastAuto = typeof saved.currentHost === 'string' ? saved.currentHost : null;
  var currentHost = '';

  // Direction / running filters and one-column-at-a-time sorting.
  var dirFilter = saved.dirFilter === 'local' || saved.dirFilter === 'remote' ? saved.dirFilter : 'all';
  var runFilter = saved.runFilter === 'running' || saved.runFilter === 'stopped' ? saved.runFilter : 'all';
  var sortKey = typeof saved.sortKey === 'string' ? saved.sortKey : '';
  var sortDir = saved.sortDir === -1 ? -1 : 1;

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

  var statusRank = { running: 0, starting: 1, error: 2, stopped: 3 };

  var comparators = {
    direction: function (a, b) { return (a.direction === 'local' ? 0 : 1) - (b.direction === 'local' ? 0 : 1); },
    host: function (a, b) { return a.hostName.localeCompare(b.hostName); },
    local: function (a, b) { return a.localPort - b.localPort || (a.localAddress || '').localeCompare(b.localAddress || ''); },
    remote: function (a, b) { return a.remotePort - b.remotePort || (a.remoteAddress || '').localeCompare(b.remoteAddress || ''); },
    status: function (a, b) { return (statusRank[a.status] ?? 3) - (statusRank[b.status] ?? 3); },
  };

  function visibleRows() {
    var out = rows;
    if (filterHost)
      out = out.filter(function (r) { return r.hostName === filterHost; });
    if (dirFilter !== 'all')
      out = out.filter(function (r) { return r.direction === dirFilter; });
    if (runFilter !== 'all')
      out = out.filter(function (r) { return runFilter === 'running' ? r.status === 'running' : r.status !== 'running'; });
    if (sortKey && comparators[sortKey]) {
      var cmp = comparators[sortKey];
      out = out.slice().sort(function (a, b) { return sortDir * cmp(a, b); });
    }
    return out;
  }

  function anyFilterActive() {
    return !!filterHost || dirFilter !== 'all' || runFilter !== 'all';
  }

  function rebuildFilterOptions() {
    var seen = {};
    var hosts = [];
    rows.forEach(function (r) {
      if (!seen[r.hostName]) { seen[r.hostName] = true; hosts.push(r.hostName); }
    });
    if (currentHost && !seen[currentHost])
      hosts.push(currentHost);
    hosts.sort();
    var select = document.getElementById('hostFilter');
    var options = ['<option value="">All Hosts</option>'].concat(hosts.map(function (h) {
      return '<option value="' + esc(h) + '">' + esc(h) + '</option>';
    }));
    select.innerHTML = options.join('');
    if (!filterHost || seen[filterHost] || filterHost === currentHost)
      select.value = filterHost;
    else {
      filterHost = '';
      pinned = false;
      select.value = '';
    }
  }

  function persist() {
    vscode.setState({
      filterHost: filterHost,
      pinned: pinned,
      currentHost: currentHost,
      dirFilter: dirFilter,
      runFilter: runFilter,
      sortKey: sortKey,
      sortDir: sortDir,
    });
  }

  function updateSortIndicators() {
    var inds = document.querySelectorAll('th[data-sort] .sort-ind');
    for (var i = 0; i < inds.length; i++) {
      var th = inds[i].closest('th');
      inds[i].textContent = th && th.dataset.sort === sortKey ? (sortDir === 1 ? '↑' : '↓') : '';
    }
  }

  function updateFilterButtons() {
    var dirBtn = document.getElementById('dirFilter');
    if (dirFilter === 'local')
      dirBtn.innerHTML = '<span class="dir-ic">' + I.arrowL + '</span>-L';
    else if (dirFilter === 'remote')
      dirBtn.innerHTML = '<span class="dir-ic">' + I.arrowR + '</span>-R';
    else
      dirBtn.textContent = 'Direction: All';

    var runBtn = document.getElementById('runFilter');
    if (runFilter === 'running')
      runBtn.textContent = 'Running';
    else if (runFilter === 'stopped')
      runBtn.textContent = 'Not Running';
    else
      runBtn.textContent = 'Status: All';
  }

  function render() {
    document.getElementById('tbody').innerHTML = visibleRows().map(rowHtml).join('');
    var empty = document.getElementById('empty');
    var shown = visibleRows();
    empty.hidden = shown.length > 0;
    if (rows.length > 0 && anyFilterActive())
      empty.textContent = 'No tunnels match the current filters.';
    else if (filterHost)
      empty.textContent = 'No port forwards for ' + filterHost + '. Use the + button to add one.';
    else
      empty.textContent = 'No port forwards. Use the + button or right-click a host in the SSH Config explorer.';
    updateSortIndicators();
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
      currentHost = msg.currentHost || '';
      // A changed remote context (connect/disconnect) re-enables auto-follow.
      if (currentHost !== lastAuto) {
        lastAuto = currentHost;
        pinned = false;
      }
      if (!pinned)
        filterHost = currentHost;
      rebuildFilterOptions();
      persist();
      render();
    }
  });

  document.getElementById('addBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'quickAdd', host: filterHost || undefined });
  });

  document.getElementById('hostFilter').addEventListener('change', function () {
    pinned = true;
    filterHost = document.getElementById('hostFilter').value;
    persist();
    render();
  });

  document.getElementById('dirFilter').addEventListener('click', function () {
    dirFilter = dirFilter === 'all' ? 'local' : dirFilter === 'local' ? 'remote' : 'all';
    updateFilterButtons();
    persist();
    render();
  });

  document.getElementById('runFilter').addEventListener('click', function () {
    runFilter = runFilter === 'all' ? 'running' : runFilter === 'running' ? 'stopped' : 'all';
    updateFilterButtons();
    persist();
    render();
  });

  // Click a header to cycle: ascending → descending → off. Only one column
  // is sorted at a time — enabling one resets the others.
  document.querySelector('thead').addEventListener('click', function (e) {
    var th = e.target.closest('th[data-sort]');
    if (!th)
      return;
    var key = th.dataset.sort;
    if (sortKey !== key) {
      sortKey = key;
      sortDir = 1;
    }
    else if (sortDir === 1) {
      sortDir = -1;
    }
    else {
      sortKey = '';
      sortDir = 1;
    }
    persist();
    render();
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

  updateFilterButtons();

  // Handshake: ask the extension for the current state once this listener is
  // up. A push sent right after the webview loads races the script load and
  // the message gets dropped (e.g. when the webview is re-resolved after
  // being hidden), leaving the panel blank until the next state change.
  vscode.postMessage({ type: 'ready' });
})();
