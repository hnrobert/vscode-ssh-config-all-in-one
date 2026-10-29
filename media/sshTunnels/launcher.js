#!/usr/bin/env node
// Tunnel launcher for SSH Config All In One.
//
// Spawned detached by the extension host. It daemonizes the ssh process
// (double detach) so the tunnel escapes the extension host's process tree —
// VS Code kills that tree on Reload Window, which would take a directly
// spawned ssh down with it. The launcher keeps the tunnel's record file up
// to date (pid, retry attempts) so every window can see and control it,
// retries crashed tunnels, and marks the record dead after giving up.
//
// Usage: node launcher.js <tunnelsDir> <safeName> <id> <logPath> <sshArgs...>

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const tunnelsDir = process.argv[2]
const safe = process.argv[3]
const id = process.argv[4]
const logPath = process.argv[5]
const sshArgs = process.argv.slice(6)
const recordPath = path.join(tunnelsDir, `${safe}.json`)

const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 4000
// Once a tunnel stays up this long, clear the retry flag in its record so
// panels show plain "Running" instead of "retrying".
const STABLE_MS = 10000

if (!tunnelsDir || !safe || !id || !logPath || sshArgs.length === 0)
  process.exit(1)

function recordExists() {
  try {
    fs.accessSync(recordPath)
    return true
  }
  catch {
    return false
  }
}

function writeRecord(fields) {
  try {
    fs.writeFileSync(recordPath, JSON.stringify(Object.assign({ id, startedAt: Date.now(), launcherPid: process.pid }, fields)))
  }
  catch {}
}

function removeRecord() {
  try {
    fs.rmSync(recordPath, { force: true })
  }
  catch {}
}

function run(attempt) {
  let fd = 'ignore'
  try {
    fd = fs.openSync(logPath, attempt === 0 ? 'w' : 'a')
  }
  catch {}

  const child = spawn('ssh', sshArgs, {
    stdio: ['ignore', 'ignore', fd],
    detached: true,
  })
  if (typeof fd === 'number') {
    try {
      fs.closeSync(fd)
    }
    catch {}
  }
  child.unref()

  if (child.pid) {
    writeRecord({ pid: child.pid, attempts: attempt })
    if (attempt > 0) {
      const pid = child.pid
      setTimeout(() => {
        try {
          if (!recordExists())
            return
          const rec = JSON.parse(fs.readFileSync(recordPath, 'utf8'))
          if (rec.pid === pid && !rec.dead) {
            rec.attempts = 0
            fs.writeFileSync(recordPath, JSON.stringify(rec))
          }
        }
        catch {}
      }, STABLE_MS)
    }
  }
  else {
    writeRecord({ pid: 0, dead: true })
  }

  child.on('exit', (code) => {
    // Stopped from a panel (record removed) or a clean exit — stay stopped.
    if (!recordExists() || code === 0) {
      removeRecord()
      process.exit(0)
    }
    if (attempt + 1 > MAX_ATTEMPTS) {
      writeRecord({ pid: 0, dead: true })
      process.exit(0)
    }
    setTimeout(() => {
      if (recordExists())
        run(attempt + 1)
      else
        process.exit(0)
    }, RETRY_DELAY_MS)
  })
}

run(0)
