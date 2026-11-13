/**
 * 网关后台守护服务管理脚本 (start / stop / restart / status)
 */

import { spawn, execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { STATUS_FILE } from '../src/core/config.ts'
import { checkClaudeProcessRunning, parseListeningPidsForPort } from '../src/core/lifecycle.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, '..')
const command = process.argv[2] ?? 'status'

const STARTUP_DIR = join(
  process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'Startup'
)
const VBS_PATH = join(STARTUP_DIR, 'AgentGatewayDaemon.vbs')
const OLD_VBS_PATH = join(STARTUP_DIR, 'ClaudeWorkBuddyGateway.vbs')

function killPort43119() {
  if (process.platform !== 'win32') return
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true })
    const pids = parseListeningPidsForPort(out, 43119, process.pid)
    for (const pid of pids) {
      try {
        execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
          stdio: 'ignore',
          windowsHide: true,
        })
      } catch {}
    }
  } catch {}
}

function killExistingDaemons() {
  if (process.platform === 'win32') {
    try {
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='wscript.exe'\" | Where-Object { $_.CommandLine -like '*Gateway*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
        ],
        { stdio: 'ignore', windowsHide: true }
      )
    } catch {}
    killPort43119()
  }
}

if (command === 'status') {
  try {
    const res = await fetch('http://127.0.0.1:43119/health', { signal: AbortSignal.timeout(1500) })
    if (res.ok) {
      process.stdout.write('✓ 网关服务正在后台稳定运行 (端口 :43119 正常响应)。\n')
      process.exit(0)
    }
  } catch {}
  process.stdout.write('网关服务当前未运行。\n')
} else if (command === 'stop') {
  killExistingDaemons()
  rmSync(VBS_PATH, { force: true })
  rmSync(OLD_VBS_PATH, { force: true })
  rmSync(STATUS_FILE, { force: true })
  process.stdout.write('✓ 已完全停止网关服务并清理后台自启守护进程。\n')
} else if (command === 'start' || command === 'restart') {
  killExistingDaemons()
  rmSync(VBS_PATH, { force: true })
  rmSync(OLD_VBS_PATH, { force: true })

  const claudeRunning = await checkClaudeProcessRunning()
  if (claudeRunning === false) {
    process.stdout.write('未检测到运行中的 Claude 桌面端，网关严格跟随 Claude 桌面端生命周期，暂不启动。\n')
    process.exit(0)
  }

  const serverJs = join(rootDir, 'dist', 'server.js')
  if (process.platform === 'win32') {
    try {
      const nodeEsc = process.execPath.replace(/'/g, "''")
      const srvEsc = serverJs.replace(/'/g, "''")
      const psScript = [
        `$si = New-CimInstance -ClassName Win32_ProcessStartup -Property @{ ShowWindow = [uint16]0 } -ClientOnly`,
        `$cmd = '"' + '${nodeEsc}' + '" "' + '${srvEsc}' + '" serve'`,
        `$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; ProcessStartupInformation = $si }`,
        `if ($null -eq $res -or $res.ReturnValue -ne 0 -or -not $res.ProcessId) { exit 1 }`,
      ].join('; ')
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch {
      spawn(process.execPath, [serverJs, 'serve'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref()
    }
  } else {
    spawn(process.execPath, [serverJs, 'serve'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref()
  }

  process.stdout.write('✓ 网关服务已启动（跟随 Claude 桌面端生命周期）！\n')
}
