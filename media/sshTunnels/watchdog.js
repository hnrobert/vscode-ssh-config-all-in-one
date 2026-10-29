#!/usr/bin/env node
// Watchdog for SSH Config All In One port-forward tunnels.
//
// Tunnel ssh processes are spawned detached so they survive extension-host
// restarts (Reload Window, closing a window). This watchdog watches the VS
// Code main process: when it exits, every recorded tunnel is killed, so
// tunnels follow the application process instead of any single window.
//
// Usage: node watchdog.js <tunnelsDir> <vscodeMainPid>

const fs = require('fs')
const path = require('path')

const tunnelsDir = process.argv[2]
const mainPid = Number(process.argv[3])

if (!tunnelsDir || !mainPid)
  process.exit(1)

const timer = setInterval(() => {
  let alive = true
  try {
    process.kill(mainPid, 0)
  }
  catch {
    alive = false
  }
  if (alive)
    return

  clearInterval(timer)
  try {
    for (const f of fs.readdirSync(tunnelsDir)) {
      if (!f.endsWith('.json'))
        continue
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(tunnelsDir, f), 'utf8'))
        if (rec.pid) {
          try {
            process.kill(rec.pid)
          }
          catch {}
        }
      }
      catch {}
      try {
        fs.rmSync(path.join(tunnelsDir, f), { force: true })
      }
      catch {}
    }
  }
  catch {}
  process.exit(0)
}, 5000)
