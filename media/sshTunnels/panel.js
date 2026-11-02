(function () {
  'use strict'
  // eslint-disable-next-line no-undef
  let vscode = acquireVsCodeApi()
  let rows = []

  // Host filter. Follows the window's current SSH remote automatically;
  // a manual pick is kept until the remote context changes again.
  let saved = vscode.getState() || {}
  let filterHost = typeof saved.filterHost === 'string' ? saved.filterHost : ''
  let pinned = !!saved.pinned && !!filterHost
  let lastAuto =
    typeof saved.currentHost === 'string' ? saved.currentHost : null
  let currentHost = ''

  // Direction / running filters and one-column-at-a-time sorting.
  let dirFilter =
    saved.dirFilter === 'local' || saved.dirFilter === 'remote'
      ? saved.dirFilter
      : 'all'
  let runFilter =
    saved.runFilter === 'running' || saved.runFilter === 'stopped'
      ? saved.runFilter
      : 'all'
  let sortKey = typeof saved.sortKey === 'string' ? saved.sortKey : ''
  let sortDir = saved.sortDir === -1 ? -1 : 1

  // Free-text search over host / addresses / ports. Transient — not persisted.
  let searchQuery = ''

  let I = {
    play: '<svg viewBox="0 0 16 16"><path d="M4.5 2.8v10.4L13 8z" fill="currentColor"/></svg>',
    stop: '<svg viewBox="0 0 16 16"><rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="currentColor"/></svg>',
    globe:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="8" cy="8" r="5.8"/><path d="M2.2 8h11.6M8 2.2c-2.2 2-2.2 9.6 0 11.6M8 2.2c2.2 2 2.2 9.6 0 11.6"/></svg>',
    trash:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M2.5 4h11M6.5 2h3M4 4l.7 9h6.6L12 4M6.6 7v3.5M9.4 7v3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    arrowR:
      '<svg viewBox="0 0 16 16" fill="none"><path d="M2 8h11M9.5 4.5 13 8l-3.5 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    arrowL:
      '<svg viewBox="0 0 16 16" fill="none"><path d="M14 8H3M6.5 4.5 3 8l3.5 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        '\'': '&#39;',
      }[c]
    })
  }

  function dirInfo(row) {
    if (row.direction === 'local') {
      return {
        label: 'Listen Local (-L)',
        cls: 'dir-local',
        icon: I.arrowL,
        title:
          'ssh -L — listen on this machine and tunnel to a destination reachable from the remote host (bring a remote service to localhost)',
      }
    }
    return {
      label: 'Listen Remote (-R)',
      cls: 'dir-remote',
      icon: I.arrowR,
      title:
        'ssh -R — listen on the remote machine and tunnel back to a destination on this machine (expose a local service remotely)',
    }
  }

  // A tunnel listens on one side (just a port — ssh binds loopback; bind
  // addresses were dropped from the rule model) and delivers to a full
  // destination host:port resolved on the other machine.
  function listenDisplay(row) {
    return String(row.listenPort)
  }

  function destDisplay(row) {
    return `${row.destHost || 'localhost'}:${row.destPort}`
  }

  function cellTitles(row) {
    if (row.direction === 'local') {
      return {
        listen: 'Port to listen on, on this machine. Click to edit the port',
        dest: 'Destination resolved on the remote machine — full host:port. Click to edit',
      }
    }
    return {
      listen:
        'Port to listen on, on the remote machine (exposing it beyond loopback needs sshd GatewayPorts). Click to edit the port',
      dest: 'Destination on this machine — full host:port. Click to edit',
    }
  }

  function statusInfo(row) {
    switch (row.status) {
      case 'running':
        return { cls: 'ok', text: 'Running' }
      case 'starting':
        return { cls: 'pending', text: 'Starting…' }
      case 'error': {
        let first = (row.message || '').split('\n')[0] || 'Error'
        return {
          cls: 'err',
          text: first.length > 20 ? `${first.slice(0, 19)}…` : first,
        }
      }
      default:
        return { cls: 'off', text: 'Stopped' }
    }
  }

  function rowHtml(row) {
    let d = dirInfo(row)
    let t = cellTitles(row)
    let s = statusInfo(row)
    let active = row.status === 'running' || row.status === 'starting'
    let listen = listenDisplay(row)
    let dest = destDisplay(row)
    let actions = []
    if (row.direction === 'local') {
      actions.push(
        `<button class="icon-btn" data-action="browser" title="Open in Browser">${I.globe
        }</button>`,
      )
    }
    actions.push(
      active
        ? `<button class="icon-btn" data-action="toggle" title="Stop Forwarding">${I.stop
        }</button>`
        : `<button class="icon-btn" data-action="toggle" title="Start Forwarding">${I.play
        }</button>`,
    )
    actions.push(
      `<button class="icon-btn" data-action="delete" title="Remove Forward">${I.trash
      }</button>`,
    )
    return (
      `<tr data-id="${esc(row.id)}" title="${esc(row.message || d.title)}">` +
      `<td><button class="cell-btn ${d.cls
      }" data-action="direction" title="${esc(d.title)}"><span class="dir-ic">${d.icon
      }</span>${d.label}</button></td>` +
      `<td><button class="cell-btn" data-action="host" title="Change the SSH host">${esc(
        row.hostName,
      )}</button></td>` +
      `<td class="editable" data-action="edit" data-field="listen" title="${esc(
        t.listen,
      )}">${esc(listen)}</td>` +
      `<td class="editable" data-action="edit" data-field="dest" title="${esc(
        t.dest,
      )}">${esc(dest)}</td>` +
      `<td><span class="status ${s.cls}" title="${esc(
        row.message || s.text,
      )}"><span class="dot"></span>${s.text}</span></td>` +
      `<td><span class="row-actions">${actions.join('')}</span></td>` +
      `</tr>`
    )
  }

  let statusRank = { running: 0, starting: 1, error: 2, stopped: 3 }

  let comparators = {
    direction(a, b) {
      return (
        (a.direction === 'local' ? 0 : 1) - (b.direction === 'local' ? 0 : 1)
      )
    },
    host(a, b) {
      return a.hostName.localeCompare(b.hostName)
    },
    listen(a, b) {
      return a.listenPort - b.listenPort
    },
    destination(a, b) {
      return (
        a.destPort - b.destPort ||
        (a.destHost || '').localeCompare(b.destHost || '')
      )
    },
    status(a, b) {
      return (statusRank[a.status] ?? 3) - (statusRank[b.status] ?? 3)
    },
  }

  function matchesSearch(row) {
    if (!searchQuery) return true
    let q = searchQuery.toLowerCase()
    return (
      row.hostName.toLowerCase().includes(q) ||
      listenDisplay(row).includes(q) ||
      destDisplay(row).toLowerCase().includes(q)
    )
  }

  function visibleRows() {
    let out = rows
    if (filterHost) {
      out = out.filter((r) => {
        return r.hostName === filterHost
      })
    }
    if (dirFilter !== 'all') {
      out = out.filter((r) => {
        return r.direction === dirFilter
      })
    }
    if (runFilter !== 'all') {
      out = out.filter((r) => {
        return runFilter === 'running'
          ? r.status === 'running'
          : r.status !== 'running'
      })
    }
    if (searchQuery) out = out.filter(matchesSearch)
    if (sortKey && comparators[sortKey]) {
      let cmp = comparators[sortKey]
      out = out.slice().sort((a, b) => {
        return sortDir * cmp(a, b)
      })
    }
    return out
  }

  function anyFilterActive() {
    return (
      !!filterHost ||
      dirFilter !== 'all' ||
      runFilter !== 'all' ||
      !!searchQuery
    )
  }

  function rebuildFilterOptions() {
    let seen = {}
    let hosts = []
    rows.forEach((r) => {
      if (!seen[r.hostName]) {
        seen[r.hostName] = true
        hosts.push(r.hostName)
      }
    })
    if (currentHost && !seen[currentHost]) hosts.push(currentHost)
    hosts.sort()
    let select = document.getElementById('hostFilter')
    let options = ['<option value="">All Hosts</option>'].concat(
      hosts.map((h) => {
        return `<option value="${esc(h)}">${esc(h)}</option>`
      }),
    )
    select.innerHTML = options.join('')
    if (!filterHost || seen[filterHost] || filterHost === currentHost) {
      select.value = filterHost
    }
    else {
      filterHost = ''
      pinned = false
      select.value = ''
    }
  }

  function persist() {
    vscode.setState({
      filterHost,
      pinned,
      currentHost,
      dirFilter,
      runFilter,
      sortKey,
      sortDir,
    })
  }

  function updateSortIndicators() {
    let inds = document.querySelectorAll('th[data-sort] .sort-ind')
    for (let i = 0; i < inds.length; i++) {
      let th = inds[i].closest('th')
      inds[i].textContent =
        th && th.dataset.sort === sortKey ? (sortDir === 1 ? '↑' : '↓') : ''
    }
  }

  function updateFilterButtons() {
    let dirBtn = document.getElementById('dirFilter')
    if (dirFilter === 'local')
      dirBtn.innerHTML = `<span class="dir-ic">${I.arrowL}</span>-L`
    else if (dirFilter === 'remote')
      dirBtn.innerHTML = `<span class="dir-ic">${I.arrowR}</span>-R`
    else dirBtn.textContent = 'Direction: All'

    let runBtn = document.getElementById('runFilter')
    if (runFilter === 'running') runBtn.textContent = 'Running'
    else if (runFilter === 'stopped') runBtn.textContent = 'Not Running'
    else runBtn.textContent = 'Status: All'
  }

  function render() {
    document.getElementById('tbody').innerHTML = visibleRows()
      .map(rowHtml)
      .join('')
    let empty = document.getElementById('empty')
    let shown = visibleRows()
    empty.hidden = shown.length > 0
    if (rows.length > 0 && anyFilterActive()) {
      empty.textContent = 'No tunnels match the current filters.'
    }
    else if (filterHost) {
      empty.textContent = `No port forwards for ${filterHost}. Use the + button to add one.`
    }
    else {
      empty.textContent =
        'No port forwards. Use the + button or right-click a host in the SSH Config explorer.'
    }
    updateSortIndicators()
  }

  function startEdit(td, row, field) {
    if (td.querySelector('input')) {
      return
    }
    let isListen = field === 'listen'
    let origAddr = row.destHost || 'localhost'
    let orig = isListen
      ? String(row.listenPort)
      : `${origAddr}:${row.destPort}`
    let input = document.createElement('input')
    input.className = 'cell-input'
    input.value = orig
    td.textContent = ''
    td.appendChild(input)
    input.focus()
    input.select()
    let done = false
    let commit = function () {
      if (done) {
        return
      }
      done = true
      let v = input.value.trim()
      if (isListen) {
        // The Listen side is just a port number.
        if (
          v &&
          v !== orig &&
          /^\d+$/.test(v) &&
          Number(v) >= 1 &&
          Number(v) <= 65535
        ) {
          vscode.postMessage({
            type: 'edit',
            id: row.id,
            field: 'listen',
            port: Number(v),
          })
        }
        else {
          render()
        }
        return
      }
      let addr = origAddr
      let port = ''
      let ci = v.lastIndexOf(':')
      if (ci > 0) {
        addr = v.slice(0, ci)
        port = v.slice(ci + 1)
      } else {
        port = v
      }
      if (
        v &&
        v !== orig &&
        /^\d+$/.test(port) &&
        Number(port) >= 1 &&
        Number(port) <= 65535
      ) {
        vscode.postMessage({
          type: 'edit',
          id: row.id,
          field: 'dest',
          host: addr || 'localhost',
          port: Number(port),
        })
      } else {
        render()
      }
    }
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        commit()
      } else if (ev.key === 'Escape') {
        done = true
        render()
      }
    })
    input.addEventListener('blur', commit)
  }

  window.addEventListener('message', (event) => {
    let msg = event.data
    if (msg && msg.type === 'state') {
      rows = msg.rows
      currentHost = msg.currentHost || ''
      // A changed remote context (connect/disconnect) re-enables auto-follow.
      if (currentHost !== lastAuto) {
        lastAuto = currentHost
        pinned = false
      }
      if (!pinned) filterHost = currentHost
      rebuildFilterOptions()
      persist()
      render()
    }
  })

  document.getElementById('addBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'quickAdd', host: filterHost || undefined })
  })

  document.getElementById('searchInput').addEventListener('input', () => {
    searchQuery = document.getElementById('searchInput').value.trim()
    render()
  })

  document.getElementById('hostFilter').addEventListener('change', () => {
    pinned = true
    filterHost = document.getElementById('hostFilter').value
    persist()
    render()
  })

  document.getElementById('dirFilter').addEventListener('click', () => {
    dirFilter =
      dirFilter === 'all' ? 'local' : dirFilter === 'local' ? 'remote' : 'all'
    updateFilterButtons()
    persist()
    render()
  })

  document.getElementById('runFilter').addEventListener('click', () => {
    runFilter =
      runFilter === 'all'
        ? 'running'
        : runFilter === 'running'
          ? 'stopped'
          : 'all'
    updateFilterButtons()
    persist()
    render()
  })

  // Click a header to cycle: ascending → descending → off. Only one column
  // is sorted at a time — enabling one resets the others.
  document.querySelector('thead').addEventListener('click', (e) => {
    let th = e.target.closest('th[data-sort]')
    if (!th) return
    let key = th.dataset.sort
    if (sortKey !== key) {
      sortKey = key
      sortDir = 1
    } else if (sortDir === 1) {
      sortDir = -1
    } else {
      sortKey = ''
      sortDir = 1
    }
    persist()
    render()
  })

  document.getElementById('tbody').addEventListener('click', (e) => {
    let el = e.target.closest('[data-action]')
    if (!el) {
      return
    }
    let tr = el.closest('tr')
    if (!tr) {
      return
    }
    let row = rows.find((r) => {
      return r.id === tr.dataset.id
    })
    if (!row) {
      return
    }
    let action = el.dataset.action
    if (action === 'edit') {
      startEdit(el, row, el.dataset.field)
    } else {
      // data-action names match the extension's message types, except the
      // globe button, whose handler is registered as 'openBrowser'.
      vscode.postMessage({
        type: action === 'browser' ? 'openBrowser' : action,
        id: row.id,
      })
    }
  })

  updateFilterButtons()

  // Handshake: ask the extension for the current state once this listener is
  // up. A push sent right after the webview loads races the script load and
  // the message gets dropped (e.g. when the webview is re-resolved after
  // being hidden), leaving the panel blank until the next state change.
  vscode.postMessage({ type: 'ready' })
})()
