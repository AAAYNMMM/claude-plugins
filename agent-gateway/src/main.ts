/**
 * agent-gateway 插件主入口：
 * 启动网关守护进程、模块聚合、路由同步与状态查询。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execSync, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DATA_DIR,
  ORIGINAL_PROVIDER_BACKUP,
  STATUS_FILE,
  applyGatewayToClaude,
  applyGatewayToSettings,
  loadGatewayConfig,
  logMessage,
  restoreOriginalClaudeProvider,
  restoreOriginalSettings,
  saveGatewayConfig,
} from './core/config.ts'
import { ModuleHost } from './core/module-host.ts'
import { createGatewayServer } from './core/server.ts'
import type { RouteConfig } from './core/types.ts'

const command = process.argv[2] ?? 'serve'

/**
 * Claude 桌面端（published.json）官方认可的合规模型别名池（全量认证，支持 Thinking Effort、1M 上下文与图片输入）
 * 严格避开厂商敏感字，并且坚决不虚构不存在的型号名
 */
const COMPLIANT_ALIASES = [
  // 官方 main section（支持 5 档 Thinking Effort、多模态图片/PDF、950K 上下文）
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-fable-5-2',
  'claude-haiku-5-5',
  // 官方 overflow section（全部存在于桌面端 published.json 目录中）
  'claude-fable-5-1',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-1-20250805',
  'claude-opus-4-5-20251101',
  // 官方兼容兜底旧代别名
  'claude-opus-4-1',
  'claude-sonnet-4-5-20250929',
  'claude-3-7-sonnet-20250219',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-sonnet-20240620',
  'claude-3-5-haiku-20241022',
  'claude-3-opus-20240229',
  'claude-3-haiku-20240307',
]

/**
 * 彻底停止所有后台网关和自启 VBS 循环，避免死灰复燃
 */
function stopGatewayDaemons(port: number): void {
  const startupDir = join(
    process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup'
  )
  for (const name of ['AgentGatewayDaemon.vbs', 'ClaudeWorkBuddyGateway.vbs']) {
    rmSync(join(startupDir, name), { force: true })
  }

  if (process.platform === 'win32') {
    try {
      execSync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'wscript.exe\'\\" | Where-Object { $_.CommandLine -like \'*Gateway*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"',
        { stdio: 'ignore' }
      )
    } catch {}
    try {
      const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' })
      for (const line of out.trim().split('\n')) {
        if (!line.includes('LISTENING')) continue
        const parts = line.trim().split(/\s+/)
        const pid = Number(parts[parts.length - 1])
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
          try {
            execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' })
          } catch {}
        }
      }
    } catch {}
  }

  try {
    if (existsSync(STATUS_FILE)) {
      const raw = JSON.parse(readFileSync(STATUS_FILE, 'utf8'))
      if (raw.pid && raw.pid !== process.pid) {
        try {
          process.kill(raw.pid, 'SIGTERM')
        } catch {}
      }
      rmSync(STATUS_FILE, { force: true })
    }
  } catch {}
}

/**
 * 启动脱离父 shell 与 Job Object 的后台独立守护进程（防止一次性 CLI/插件命令退出时连带杀死网关）
 */
function spawnDetachedGateway(serverPath: string): void {
  if (process.platform === 'win32') {
    try {
      const nodeEsc = process.execPath.replace(/'/g, "''")
      const srvEsc = serverPath.replace(/'/g, "''")
      const psScript = [
        `$si = New-CimInstance -ClassName Win32_ProcessStartup -Property @{ ShowWindow = [uint16]0 } -ClientOnly`,
        `$cmd = '"' + '${nodeEsc}' + '" "' + '${srvEsc}' + '" serve'`,
        `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; ProcessStartupInformation = $si } | Out-Null`,
      ].join('; ')
      execSync(`powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`, { stdio: 'ignore' })
      return
    } catch {}
  }

  const child = spawn(process.execPath, [serverPath, 'serve'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

/**
 * 检测 Claude 桌面端主进程是否正在运行
 */
function isClaudeProcessRunning(): boolean {
  if (process.platform !== 'win32') {
    try {
      const out = execSync('pgrep -i claude', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      return out.trim().length > 0
    } catch {
      return false
    }
  }
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq claude.exe" /NH', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.toLowerCase().includes('claude.exe')
  } catch {
    return false
  }
}

let activeSyncPromise: Promise<Record<string, RouteConfig>> | null = null

/**
 * 核心模型同步方法：并发加锁、安全扫描上游全部模型、映射到合规别名池并应用至桌面端与配置
 */
async function syncGatewayRoutes(
  host: ModuleHost,
  config: GatewayConfig,
  options: { silent?: boolean; updateClaude?: boolean } = {}
): Promise<Record<string, RouteConfig>> {
  if (activeSyncPromise) {
    return activeSyncPromise
  }
  activeSyncPromise = (async () => {
    try {
      return await doSyncGatewayRoutes(host, config, options)
    } finally {
      activeSyncPromise = null
    }
  })()
  return activeSyncPromise
}

async function doSyncGatewayRoutes(
  host: ModuleHost,
  config: GatewayConfig,
  options: { silent?: boolean; updateClaude?: boolean } = {}
): Promise<Record<string, RouteConfig>> {
  const log = options.silent ? () => {} : logMessage
  await host.initAll({
    gatewayPort: config.port,
    log,
    dataDir: DATA_DIR,
  })

  const aggregated = await host.aggregateModels()
  if (!aggregated || aggregated.length === 0) {
    return config.routes
  }

  const newRoutes: Record<string, RouteConfig> = {}
  const usedAliases = new Set<string>()

  // 优先排序：反重力模型置顶，随后 WorkBuddy 主力模型
  aggregated.sort((a, b) => {
    if (a.module === 'antigravity' && b.module !== 'antigravity') return -1
    if (a.module !== 'antigravity' && b.module === 'antigravity') return 1
    return 0
  })

  // 动态合规别名两阶段分配：
  // 1) 按模型语义与能力特征（opus / sonnet / flash / flagship）优先匹配 Claude 原生 Thinking 别名，
  //    避免后续模型抢占 Opus/Sonnet/Flash 专属槽位；
  // 2) 为其余动态新增模型顺位分配未使用的合规别名，并严格保持上游展示顺序。
  const getPreferredCandidates = (modId: string, model: { id: string; name: string; recommendedAlias?: string }): string[] => {
    const candidates: string[] = []
    if (model.recommendedAlias && COMPLIANT_ALIASES.includes(model.recommendedAlias)) {
      candidates.push(model.recommendedAlias)
    }
    const lower = `${model.id} ${model.name}`.toLowerCase()
    if (lower.includes('opus')) {
      candidates.push('claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6')
    } else if (lower.includes('sonnet')) {
      candidates.push('claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6')
    } else if (lower.includes('flash') || lower.includes('lite') || lower.includes('haiku')) {
      candidates.push('claude-haiku-5-5', 'claude-haiku-4-5-20251001', 'claude-3-5-haiku-20241022')
    } else if (
      modId === 'antigravity' &&
      (lower.includes('argon') || lower.includes('hydrogen') || lower.includes('carbon') || lower.includes('pro'))
    ) {
      candidates.push('claude-fable-5-2', 'claude-fable-5-1', 'claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7')
    }
    return candidates
  }

  const eligibleItems = aggregated.filter((item) => item.module !== 'passthrough')
  const assignedAliases = new Array<string | undefined>(eligibleItems.length)

  for (let i = 0; i < eligibleItems.length; i++) {
    const { module: modId, model } = eligibleItems[i]
    for (const candidate of getPreferredCandidates(modId, model)) {
      if (COMPLIANT_ALIASES.includes(candidate) && !usedAliases.has(candidate)) {
        assignedAliases[i] = candidate
        usedAliases.add(candidate)
        break
      }
    }
  }

  let aliasIdx = 0
  for (let i = 0; i < eligibleItems.length; i++) {
    if (!assignedAliases[i]) {
      while (aliasIdx < COMPLIANT_ALIASES.length && usedAliases.has(COMPLIANT_ALIASES[aliasIdx])) {
        aliasIdx++
      }
      if (aliasIdx >= COMPLIANT_ALIASES.length) continue
      const alias = COMPLIANT_ALIASES[aliasIdx++]
      assignedAliases[i] = alias
      usedAliases.add(alias)
    }

    const { module: modId, model } = eligibleItems[i]
    newRoutes[assignedAliases[i]!] = {
      module: modId,
      targetModel: model.id,
      label: model.labelOverride ?? model.name,
    }
  }

  if (Object.keys(newRoutes).length > 0) {
    config.routes = newRoutes
    saveGatewayConfig(config)

    if (options.updateClaude !== false && existsSync(ORIGINAL_PROVIDER_BACKUP)) {
      try {
        applyGatewayToClaude(newRoutes, config.port)
        if (!options.silent) {
          logMessage(`✓ 已同步更新 Claude 桌面端模型列表（共 ${Object.keys(newRoutes).length} 个模型）`)
        }
      } catch (err: any) {
        if (!options.silent) {
          logMessage(`提示: 更新桌面端配置失败: ${err.message}`)
        }
      }
    }
  }

  return newRoutes
}

/**
 * 监听 Claude 进程状态：只要 Claude 已完全关闭，网关立即自动退出，绝不常驻后台
 */
function startClaudeExitWatcher(log: (msg: string) => void): () => void {
  let claudeSeen = isClaudeProcessRunning()
  let graceCount = 0

  const timer = setInterval(() => {
    const isRunning = isClaudeProcessRunning()
    if (isRunning) {
      claudeSeen = true
      graceCount = 0
    } else {
      if (claudeSeen) {
        log('检测到 Claude 桌面端已关闭，网关自动退出。')
        clearInterval(timer)
        try {
          if (existsSync(STATUS_FILE)) rmSync(STATUS_FILE, { force: true })
        } catch {}
        process.exit(0)
      } else {
        // 刚启动时，给 45 秒宽限期等待 Claude 窗口就绪
        graceCount++
        if (graceCount >= 15) { // 15 * 3s = 45s
          log('未检测到 Claude 进程运行，网关自动退出。')
          clearInterval(timer)
          try {
            if (existsSync(STATUS_FILE)) rmSync(STATUS_FILE, { force: true })
          } catch {}
          process.exit(0)
        }
      }
    }
  }, 3000)

  return () => clearInterval(timer)
}

async function main() {
  const config = loadGatewayConfig()
  const host = new ModuleHost()

  if (config.antigravity?.apiKey) {
    host.getAntigravityModule().setApiKey(config.antigravity.apiKey)
  }

  // 0. 一键开启网关并接入 Claude 桌面端
  if (command === 'on' || command === 'enable') {
    const isSilent = process.argv.includes('--silent')
    let isRunning = false
    try {
      const ping = await fetch(`http://127.0.0.1:${config.port}/v1/models`, {
        signal: AbortSignal.timeout(1000),
      })
      if (ping.ok) isRunning = true
    } catch {}

    const selfPath = fileURLToPath(import.meta.url)

    if (!isRunning) {
      if (!isSilent) {
        process.stdout.write(`正在启动后台网关进程 (端口 :${config.port})...\n`)
      }
      spawnDetachedGateway(selfPath)

      // 等待服务端口就绪
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 200))
        try {
          const ping = await fetch(`http://127.0.0.1:${config.port}/v1/models`, {
            signal: AbortSignal.timeout(500),
          })
          if (ping.ok) {
            isRunning = true
            break
          }
        } catch {}
      }
    }

    if (!isSilent) {
      process.stdout.write('正在同步各模块最新可用模型并构建合规路由...\n')
    }
    let currentConfig = loadGatewayConfig()
    const freshRoutes = await syncGatewayRoutes(host, currentConfig, { silent: isSilent })

    // 同步切换 CLI 与 Code 标签页环境至本地网关
    const routeAliases = Object.keys(freshRoutes)
    const primaryAlias = routeAliases[1] ?? routeAliases[0] ?? 'claude-sonnet-5-5'
    const smallAlias =
      routeAliases.find((a) => freshRoutes[a]?.targetModel?.includes('flash')) ??
      routeAliases[0] ??
      'claude-haiku-5-5'
    applyGatewayToSettings(currentConfig.port, currentConfig.token, primaryAlias, smallAlias)

    try {
      const res = applyGatewayToClaude(freshRoutes, currentConfig.port)
      if (!isSilent) {
        process.stdout.write(`\n✓ agent-gateway 网关已成功开启并接入 Claude 桌面端与 CLI！\n`)
        process.stdout.write(`  网关监听: http://127.0.0.1:${currentConfig.port}\n`)
        process.stdout.write(`  已注入模型: ${res.modelCount} 个\n`)
        process.stdout.write(`  提示: 若当前 Claude 桌面端正在运行，重启桌面端即可生效最新模型。\n\n`)
      }
    } catch (err: any) {
      if (!isSilent) {
        process.stdout.write(`\n✓ agent-gateway 网关运行正常 (端口 :${currentConfig.port})\n`)
        process.stdout.write(`  桌面端接入提示: ${err.message}\n\n`)
      }
    }

    if (isSilent) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart' } }))
    }

    await host.disposeAll()
    process.exit(0)
  }

  // 0.1 一键关闭网关并还原原本配置
  if (command === 'off' || command === 'disable') {
    process.stdout.write('正在关闭 agent-gateway 网关并还原原本配置...\n')
    // 1. 彻底停止所有后台守护与自启 VBS 循环
    stopGatewayDaemons(config.port)

    // 2. 联动还原 CLI / Code 标签页环境（~/.claude/settings.json）
    const settingsRestored = restoreOriginalSettings()

    // 3. 还原桌面端 Provider 配置
    try {
      restoreOriginalClaudeProvider()
      process.stdout.write(`✓ 已完整还原 Claude 桌面端原本的代理/账号配置${settingsRestored ? '（及 CLI 环境）' : ''}！\n`)
      process.stdout.write(`  提示: 若当前正在桌面端中使用网关，请开启新会话或重启 Claude 桌面端使其生效。\n\n`)
    } catch (err: any) {
      process.stdout.write(`  提示: ${err.message}\n\n`)
    }
    process.exit(0)
  }

  // 1. 同步与补全模型路由表
  if (command === 'sync') {
    process.stdout.write('正在扫描各模块账号内全部可选模型并同步合规路由表...\n')
    const newRoutes = await syncGatewayRoutes(host, config, { silent: false })

    process.stdout.write(`\n✓ 同步完成！共登记 ${Object.keys(newRoutes).length} 个全量模型路由（无任何第三方警告）：\n`)
    for (const [alias, r] of Object.entries(newRoutes)) {
      process.stdout.write(`  - [${r.module}] ${alias.padEnd(28)} -> ${r.label}\n`)
    }
    await host.disposeAll()
    process.exit(0)
  }

  // 2. 状态查询
  if (command === 'status') {
    await host.initAll({
      gatewayPort: config.port,
      log: () => {},
      dataDir: DATA_DIR,
    })
    const statuses = await host.collectStatuses()
    process.stdout.write('\n=== 各模块运行与余额状态 ===\n')
    for (const [id, s] of Object.entries(statuses)) {
      if (id === 'passthrough') continue
      const mod = host.getModule(id)
      const name = mod?.name ?? id
      process.stdout.write(`\n【${name}】\n`)
      process.stdout.write(`  在线状态: ${s.online ? '✓ 在线' : '✗ 离线'}\n`)
      if (s.account) process.stdout.write(`  账号信息: ${s.account}\n`)
      if (s.balance !== undefined) process.stdout.write(`  额度/余额: ${s.balance}\n`)
      if (s.details) {
        for (const [k, v] of Object.entries(s.details)) {
          if (v && typeof v !== 'object') process.stdout.write(`  ${k}: ${v}\n`)
        }
      }
    }
    process.stdout.write('\n')
    await host.disposeAll()
    process.exit(0)
  }

  // statusline 命令：供 wb-credits 模组快速读取状态
  if (command === 'statusline') {
    const compact = process.argv.includes('--compact')
    let text = compact ? '离线' : 'WB · 离线'
    try {
      const res = await fetch(`http://127.0.0.1:${config.port}/status`, {
        signal: AbortSignal.timeout(600),
      })
      if (res.ok) {
        const data = await res.json() as any
        const wbStatus = data.modules?.workbuddy
        if (wbStatus) {
          if (wbStatus.online) {
            text = compact ? String(wbStatus.balance ?? '在线') : `WB · ${wbStatus.balance}`
          } else {
            text = compact ? '未登录' : 'WB 未登录'
          }
        }
      }
    } catch {}
    process.stdout.write(`${text}\n`)
    process.exit(0)
  }

  // 3. 模型列表展示
  if (command === 'models') {
    process.stdout.write('\n当前配置的模型路由列表：\n')
    for (const [alias, r] of Object.entries(config.routes)) {
      process.stdout.write(`  ${alias.padEnd(30)} => [${r.module}] ${r.label}\n`)
    }
    process.stdout.write('\n')
    process.exit(0)
  }

  // 4. 默认命令：serve（伴随 Claude 运行，Claude 关闭即随之退出）
  logMessage(`正在启动 agent-gateway (端口 :${config.port})...`)
  await host.initAll({
    gatewayPort: config.port,
    log: logMessage,
    dataDir: DATA_DIR,
  })

  // 启动时自动执行一次全量模型同步与配置更新（网关启动就自动更新一次模型）
  await syncGatewayRoutes(host, config, { silent: true })

  const gatewayServer = createGatewayServer({
    config,
    host,
    log: logMessage,
    onSyncRequest: () => syncGatewayRoutes(host, config, { silent: true }),
  })

  await gatewayServer.start()

  writeFileSync(
    STATUS_FILE,
    JSON.stringify(
      {
        pid: process.pid,
        port: config.port,
        startTime: new Date().toISOString(),
      },
      null,
      2
    )
  )

  // 监听 Claude 进程：Claude 一旦退出，网关立即退出，绝不常驻后台
  const stopClaudeWatcher = startClaudeExitWatcher(logMessage)

  const shutdown = async () => {
    logMessage('接收到停机信号，正在停止网关...')
    stopClaudeWatcher()
    await gatewayServer.close()
    await host.disposeAll()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('启动失败:', err)
  process.exit(1)
})
