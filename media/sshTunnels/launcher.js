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
// Printed by ssh's LocalCommand once the connection and forward are up.
const READY_MARKER = 'ssh-tunnels:ready'

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

// Lifecycle notes share the tunnel's log file (prefixed) so any failure —
// including the launcher dying before ssh starts — leaves a trace.
function note(message) {
  try {
    fs.appendFileSync(logPath, `[launcher ${new Date().toISOString()}] ${message}\n`)
  }
  catch {}
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

// Stamps the record once ssh reports (via LocalCommand on stdout) that the
// connection and the forward are established — the definitive ready signal.
function markReady() {
  try {
    if (!recordExists())
      return
    const rec = JSON.parse(fs.readFileSync(recordPath, 'utf8'))
    if (!rec.ready) {
      rec.ready = true
      fs.writeFileSync(recordPath, JSON.stringify(rec))
    }
    note('tunnel ready (connection and forward established)')
  }
  catch {}
}

function run(attempt) {
  let fd = 'ignore'
  try {
    fd = fs.openSync(logPath, 'a')
  }
  catch {}

  const child = spawn('ssh', sshArgs, {
    // stdout carries the LocalCommand ready marker; stderr goes to the log.
    stdio: ['ignore', 'pipe', fd],
    detached: true,
  })
  if (typeof fd === 'number') {
    try {
      fs.closeSync(fd)
    }
    catch {}
  }
  child.unref()

  child.stdout.on('data', (chunk) => {
    if (String(chunk).indexOf(READY_MARKER) !== -1)
      markReady()
  })

  if (child.pid) {
    note(`attempt ${attempt}: ssh pid ${child.pid}, args: ssh ${sshArgs.join(' ')}`)
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
    note('spawn failed: ssh returned no pid')
    writeRecord({ pid: 0, dead: true })
  }

  child.on('exit', (code, signal) => {
    note(`ssh exited code=${code} signal=${signal}`)
    // Stopped from a panel (record removed) or a clean exit — stay stopped.
    if (!recordExists() || code === 0) {
      note('record removed or clean exit — staying stopped')
      removeRecord()
      process.exit(0)
    }
    if (attempt + 1 > MAX_ATTEMPTS) {
      note(`giving up after ${MAX_ATTEMPTS} attempts`)
      writeRecord({ pid: 0, dead: true })
      process.exit(0)
    }
    note(`retrying in ${RETRY_DELAY_MS}ms (attempt ${attempt + 1})`)
    setTimeout(() => {
      if (recordExists())
        run(attempt + 1)
      else
        process.exit(0)
    }, RETRY_DELAY_MS)
  })
}

// Truncate the previous run's leftovers, then leave the startup trace —
// if the launcher dies before ssh starts, this line is the only evidence.
try {
  fs.closeSync(fs.openSync(logPath, 'w'))
}
catch {}
note(`launcher pid ${process.pid} starting: ssh ${sshArgs.join(' ')}`)
run(0)
