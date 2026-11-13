/**
 * 进程生命周期与跨进程互斥锁工具：
 * - 精准解析 netstat LISTENING 端口占用 PID（避免前缀误匹配与误杀连接端/自身进程）；
 * - 异步检测 Claude 桌面端进程存活状态（不阻塞事件循环，区分未运行与查询异常）；
 * - 跟随 Claude 桌面端生命周期：桌面端彻底退出或插件被禁用时立即通知网关停机；
 * - 跨进程文件互斥锁，防止多个 SessionStart Hook 并发冲突。
 */

import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import type { GatewayPluginState } from './config.ts'

const execFileAsync = promisify(execFile)

/**
 * 精准解析 `netstat -ano` 输出，仅返回在指定端口处于 TCP LISTENING 状态的外部 PID。
 */
export function parseListeningPidsForPort(
  netstatOutput: string,
  port: number,
  selfPid = process.pid
): number[] {
  const pids = new Set<number>()
  for (const rawLine of netstatOutput.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const parts = line.split(/\s+/)
    if (parts.length < 5) continue
    const [proto, localAddr, , state, pidStr] = parts
    if (proto.toUpperCase() !== 'TCP') continue
    if (state.toUpperCase() !== 'LISTENING') continue

    const colonIdx = localAddr.lastIndexOf(':')
    if (colonIdx === -1) continue
    const localPort = Number(localAddr.slice(colonIdx + 1))
    if (!Number.isInteger(localPort) || localPort !== port) continue

    const pid = Number(pidStr)
    if (Number.isInteger(pid) && pid > 0 && pid !== selfPid) {
      pids.add(pid)
    }
  }
  return Array.from(pids)
}

/**
 * 解析 `tasklist /FI "IMAGENAME eq claude.exe" /FO CSV /NH` 输出，判断是否包含 Claude 桌面端/CLI 进程。
 */
export function parseWindowsTasklistHasClaude(output: string): boolean {
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^"?claude\.exe"?(,|\s|$)/i.test(line)) {
      return true
    }
  }
  return false
}

/**
 * 异步非阻塞检测 Claude 桌面端（Claude.exe / claude.exe / Claude）是否正在运行。
 * 返回值：
 * - true: 确认正在运行
 * - false: 确认未运行
 * - null: 检测命令异常/超时（不确定态，不可据此触发停机）
 */
export async function checkClaudeProcessRunning(): Promise<boolean | null> {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync(
        'tasklist',
        ['/FI', 'IMAGENAME eq claude.exe', '/FO', 'CSV', '/NH'],
        { encoding: 'utf8', timeout: 3000, windowsHide: true }
      )
      return parseWindowsTasklistHasClaude(stdout)
    } catch {
      return null
    }
  }

  try {
    const { stdout } = await execFileAsync('pgrep', ['-ix', 'claude'], {
      encoding: 'utf8',
      timeout: 3000,
    })
    return stdout.trim().length > 0
  } catch (err: any) {
    if (err?.code === 1) return false
    return null
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === 'EPERM'
  }
}

/**
 * 跨进程文件互斥锁（支持陈旧锁自动清理），用于串行化 `on` / `off` 等启停操作。
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number; staleMs?: number } = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const staleMs = options.staleMs ?? 30_000
  const deadline = Date.now() + timeoutMs
  mkdirSync(dirname(lockPath), { recursive: true })

  let acquired = false
  while (!acquired) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx', encoding: 'utf8' })
      acquired = true
      break
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err
      // 检查是否为崩溃遗留的陈旧锁
      let isStale = false
      try {
        const st = statSync(lockPath)
        const content = readFileSync(lockPath, 'utf8').trim()
        const holderPid = Number(content)
        const ageMs = Date.now() - st.mtimeMs
        if (ageMs > staleMs || (Number.isInteger(holderPid) && holderPid > 0 && !isPidAlive(holderPid))) {
          isStale = true
        }
      } catch {
        isStale = true
      }

      if (isStale) {
        try {
          rmSync(lockPath, { force: true })
          continue
        } catch {}
      }

      if (Date.now() >= deadline) {
        throw new Error(`等待网关操作锁超时 (${lockPath})`)
      }
      await new Promise((r) => setTimeout(r, 80))
    }
  }

  try {
    return await fn()
  } finally {
    if (acquired) {
      try {
        rmSync(lockPath, { force: true })
      } catch {}
    }
  }
}

export interface ClaudeLifecycleMonitorOptions {
  pollIntervalMs?: number
  exitConfirmPolls?: number
  disabledConfirmPolls?: number
  initialRunning?: boolean
  checkProcess?: () => Promise<boolean | null>
  checkPluginState: () => GatewayPluginState
  onClaudeStart?: () => void
  onClaudeExit: () => void
  onPluginDisabled: () => void
  log?: (msg: string) => void
}

/**
 * 跟随 Claude 桌面端生命周期的非重叠异步监控器：
 * - 使用递归 setTimeout 确保上一次异步进程检查未结束时不会重叠堆积；
 * - 检测到插件被禁用/卸载（连续确认 disabledConfirmPolls 次，防止读写瞬态误杀）时触发 onPluginDisabled；
 * - 检测到 Claude 桌面端彻底退出（连续确认 exitConfirmPolls 次未运行）时触发 onClaudeExit；
 * - 检测到 Claude 桌面端重新打开时触发 onClaudeStart。
 */
export function createClaudeLifecycleMonitor(options: ClaudeLifecycleMonitorOptions): () => void {
  const pollIntervalMs = options.pollIntervalMs ?? 2000
  const exitConfirmPolls = Math.max(1, options.exitConfirmPolls ?? 2)
  const disabledConfirmPolls = Math.max(1, options.disabledConfirmPolls ?? exitConfirmPolls)
  const checkProcess = options.checkProcess ?? checkClaudeProcessRunning

  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let wasRunning = options.initialRunning ?? true
  let consecutiveMissing = 0
  let consecutiveDisabled = 0
  let inTick = false

  const scheduleNext = () => {
    if (stopped) return
    timer = setTimeout(() => {
      void tick()
    }, pollIntervalMs)
    timer.unref?.()
  }

  const tick = async () => {
    if (stopped || inTick) return
    inTick = true
    try {
      const pluginState = options.checkPluginState()
      if (!pluginState.indeterminate) {
        if (pluginState.disabled) {
          consecutiveDisabled += 1
          if (consecutiveDisabled >= disabledConfirmPolls) {
            stopped = true
            options.log?.('检测到 Claude 桌面端已禁用或卸载 agent-gateway 插件，正在自动还原配置并停止网关...')
            options.onPluginDisabled()
            return
          }
        } else {
          consecutiveDisabled = 0
        }
      }

      const running = await checkProcess()
      if (stopped) return

      if (running === true) {
        consecutiveMissing = 0
        if (!wasRunning) {
          wasRunning = true
          options.log?.('检测到 Claude 桌面端启动，自动刷新模型与配额路由...')
          options.onClaudeStart?.()
        }
      } else if (running === false) {
        wasRunning = false
        consecutiveMissing += 1
        if (consecutiveMissing >= exitConfirmPolls) {
          stopped = true
          options.log?.('检测到 Claude 桌面端已彻底退出，网关跟随自动关闭...')
          options.onClaudeExit()
          return
        }
      }
      // running === null（OS 工具瞬态报错/超时）：保持当前状态，不误触发停机
    } finally {
      inTick = false
      if (!stopped) {
        scheduleNext()
      }
    }
  }

  scheduleNext()

  return () => {
    stopped = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
}
