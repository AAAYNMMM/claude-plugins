/**
 * agent-gateway 插件主入口：
 * 启动网关守护进程、模块聚合、路由同步与状态查询。
 */

import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DATA_DIR,
  ORIGINAL_PROVIDER_BACKUP,
  STATUS_FILE,
  applyGatewayToClaude,
  applyGatewayToSettings,
  cleanupLegacyClaudeCommands,
  getGatewayPluginState,
  loadGatewayConfig,
  logMessage,
  restoreOriginalClaudeProvider,
  restoreOriginalSettings,
  saveGatewayConfig,
  setGatewayPluginEnabled,
  writeFileAtomicSync,
} from './core/config.ts'
import {
  checkClaudeProcessRunning,
  createClaudeLifecycleMonitor,
  parseListeningPidsForPort,
  withFileLock,
} from './core/lifecycle.ts'
import { ModuleHost } from './core/module-host.ts'
import { createGatewayServer } from './core/server.ts'
import type { GatewayConfig, RouteConfig } from './core/types.ts'

const GATEWAY_OP_LOCK = join(DATA_DIR, 'gateway-op.lock')

const command = process.argv[2] ?? 'serve'

/**
 * 全量使用 Claude Sonnet 槽位别名池：
 * 优先占用官方目录及 CLI 零警告 Sonnet 槽位（claude-sonnet-5-5 / 5 / 4-6 / 4-5-20250929），
 * 其余模型顺位分配 2 位数版本号槽位（claude-sonnet-5-6 .. 5-99、6-0 .. 6-99），
 * 完全符合桌面端校验正则且彻底避开特定系列配额与拦截限制。
 */
const COMPLIANT_ALIASES: string[] = [
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5-20250929',
  ...Array.from({ length: 94 }, (_, i) => `claude-sonnet-5-${i + 6}`),
  ...Array.from({ length: 100 }, (_, i) => `claude-sonnet-6-${i}`),
]

/**
 * 清理 Windows 开机后台静默守护脚本（仅在 off 或插件禁用时调用）
 */
function removeWindowsStartupScripts(): void {
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
}

/**
 * 彻底停止所有后台网关和残留 VBS 守护进程
 */
function stopGatewayDaemons(port: number): void {
  removeWindowsStartupScripts()

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
    try {
      const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true })
      const pids = parseListeningPidsForPort(out, port, process.pid)
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
        `$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; ProcessStartupInformation = $si }`,
        `if ($null -eq $res -or $res.ReturnValue -ne 0 -or -not $res.ProcessId) { exit 1 }`,
      ].join('; ')
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
        stdio: 'ignore',
        windowsHide: true,
      })
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

let activeSyncPromise: Promise<Record<string, RouteConfig>> | null = null

/**
 * 核心模型同步方法：并发加锁、安全扫描上游全部模型、映射到合规别名池并应用至桌面端与配置
 */
async function syncGatewayRoutes(
  host: ModuleHost,
  config: GatewayConfig,
  options: { silent?: boolean; updateClaude?: boolean; skipInit?: boolean } = {}
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
  options: { silent?: boolean; updateClaude?: boolean; skipInit?: boolean } = {}
): Promise<Record<string, RouteConfig>> {
  if (!options.skipInit) {
    const log = options.silent ? () => {} : logMessage
    await host.initAll({
      gatewayPort: config.port,
      log,
      dataDir: DATA_DIR,
    })
  }

  const aggregated = await host.aggregateModels()
  const eligibleItems = aggregated.filter((item) => item.module !== 'passthrough')
  if (eligibleItems.length === 0) {
    return config.routes
  }

  const newRoutes: Record<string, RouteConfig> = {}
  const usedAliases = new Set<string>()

  // 优先排序网关扩展模型：反重力模型在前，随后 WorkBuddy 主力模型
  eligibleItems.sort((a, b) => {
    if (a.module === 'antigravity' && b.module !== 'antigravity') return -1
    if (a.module !== 'antigravity' && b.module === 'antigravity') return 1
    return 0
  })

  // 动态合规 Sonnet 槽位两阶段分配：
  // 1) 为高优先级/旗舰/快模型优先绑定官方目录 Sonnet 槽位 (claude-sonnet-5-5 / 5 / 4-6 / 4-5-20250929)；
  // 2) 为其余所有动态模型顺位分配 claude-sonnet-5-6, claude-sonnet-5-7, ... 槽位。
  const getPreferredCandidates = (modId: string, model: { id: string; name: string; recommendedAlias?: string }): string[] => {
    const candidates: string[] = []
    if (model.recommendedAlias && COMPLIANT_ALIASES.includes(model.recommendedAlias)) {
      candidates.push(model.recommendedAlias)
    }
    const lower = `${model.id} ${model.name}`.toLowerCase()
    if (lower.includes('flash') || lower.includes('lite') || lower.includes('haiku')) {
      candidates.push('claude-sonnet-5-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', 'claude-sonnet-5')
    } else if (lower.includes('opus') || (modId === 'antigravity' && (lower.includes('argon') || lower.includes('hydrogen') || lower.includes('carbon') || lower.includes('pro')))) {
      candidates.push('claude-sonnet-5', 'claude-sonnet-5-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5-20250929')
    } else if (lower.includes('sonnet')) {
      candidates.push('claude-sonnet-4-6', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-5-20250929')
    }
    return candidates
  }

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
    // 合并磁盘上可能由 `on` 写入的 passthrough 字段（如 settingsBaseUrl），防止长驻内存对象覆盖掉它们
    let diskPassthrough: GatewayConfig['passthrough'] | undefined
    try {
      diskPassthrough = loadGatewayConfig().passthrough
    } catch {}
    config.passthrough = {
      ...diskPassthrough,
      ...config.passthrough,
    }
    config.routes = newRoutes
    saveGatewayConfig(config)

    if (options.updateClaude !== false && existsSync(ORIGINAL_PROVIDER_BACKUP)) {
      try {
        const res = applyGatewayToClaude(newRoutes, config.port)
        if (!options.silent) {
          logMessage(`✓ 已同步更新 Claude 桌面端模型列表（共 ${res.modelCount} 个模型）`)
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

function getSelfBuildStamp(selfPath: string): string {
  try {
    const st = statSync(selfPath)
    return `${st.size}:${Math.trunc(st.mtimeMs)}`
  } catch {
    return 'unknown'
  }
}

function safeLoadConfigForCleanup(): GatewayConfig {
  try {
    return loadGatewayConfig()
  } catch {
    return {
      port: 43119,
      token: '',
      authMode: 'loopback',
      defaultModel: 'claude-sonnet-5-5',
      smallModel: 'claude-sonnet-4-6',
      routes: {},
      passthrough: {},
    }
  }
}

async function main() {
  // 0.1 一键关闭网关并还原用户配置里的原本上游地址（保留用户自配模型），优先执行避免损坏 config 阻塞关闭
  if (command === 'off' || command === 'disable') {
    await withFileLock(GATEWAY_OP_LOCK, async () => {
      const cfg = safeLoadConfigForCleanup()
      process.stdout.write('正在关闭 agent-gateway 网关并还原用户配置...\n')
      stopGatewayDaemons(cfg.port)
      cleanupLegacyClaudeCommands()

      let pluginDisabled = false
      let settingsRestored = false
      try {
        pluginDisabled = setGatewayPluginEnabled(false)
      } catch (err: any) {
        process.stdout.write(`  警告: 关闭插件状态失败: ${err?.message ?? String(err)}\n`)
      }
      try {
        settingsRestored = restoreOriginalSettings(cfg.token, cfg.passthrough?.settingsBaseUrl)
      } catch (err: any) {
        process.stdout.write(`  警告: 还原 CLI settings.json 失败: ${err?.message ?? String(err)}\n`)
      }

      try {
        restoreOriginalClaudeProvider(cfg.passthrough?.deepseekBaseUrl)
        const extras = [settingsRestored ? 'CLI settings.json' : '', pluginDisabled ? '插件状态已关闭' : ''].filter(Boolean)
        process.stdout.write(`✓ 已移除网关注入条目并还原用户配置${extras.length ? `（${extras.join('，')}）` : ''}！\n`)
        process.stdout.write(`  提示: 若当前正在桌面端中使用网关，请开启新会话或重启 Claude 桌面端使其生效。\n\n`)
      } catch (err: any) {
        process.stdout.write(`  提示: ${err?.message ?? String(err)}\n\n`)
      }
    })
    process.exit(0)
  }

  const config = loadGatewayConfig()
  const host = new ModuleHost()

  if (config.antigravity?.apiKey) {
    host.getAntigravityModule().setApiKey(config.antigravity.apiKey)
  }
  if (config.passthrough?.deepseekBaseUrl) {
    host.getPassthroughModule().setBaseUrl(config.passthrough.deepseekBaseUrl)
  }
  if (config.workbuddy) {
    host.getWorkBuddyModule().setRegion(config.workbuddy.region)
    host.getWorkBuddyModule().setChannelPerturbation(config.workbuddy.channelPerturbation)
  }

  // 0. 一键开启网关并接入 Claude 桌面端（受跨进程互斥锁保护，且严格跟随 Claude 桌面端生命周期）
  if (command === 'on' || command === 'enable') {
    const isSilent = process.argv.includes('--silent')

    await withFileLock(
      GATEWAY_OP_LOCK,
      async () => {
        cleanupLegacyClaudeCommands()
        removeWindowsStartupScripts()
      try {
        setGatewayPluginEnabled(true)
      } catch (err: any) {
        if (!isSilent) {
          process.stdout.write(`  警告: 启用插件状态失败: ${err?.message ?? String(err)}\n`)
        }
      }

      const claudeRunning = await checkClaudeProcessRunning()
      if (claudeRunning === false) {
        stopGatewayDaemons(config.port)
        if (!isSilent) {
          process.stdout.write(
            '✓ 已启用 agent-gateway 插件。未检测到运行中的 Claude 桌面端，网关将在打开 Claude 桌面端时自动启动。\n'
          )
        }
        return
      }

      const selfPath = fileURLToPath(import.meta.url)
      const expectedStamp = getSelfBuildStamp(selfPath)
      let isRunning = false
      let needsRestart = false
      try {
        const ping = await fetch(`http://127.0.0.1:${config.port}/health`, {
          signal: AbortSignal.timeout(1000),
        })
        if (ping.ok) {
          const health = (await ping.json().catch(() => ({}))) as { buildStamp?: string }
          if (health.buildStamp === expectedStamp) {
            isRunning = true
          } else {
            needsRestart = true
          }
        }
      } catch {}

      if (needsRestart) {
        if (!isSilent) {
          process.stdout.write('检测到旧版本网关正在运行，正在重启至最新版本...\n')
        }
        stopGatewayDaemons(config.port)
        for (let i = 0; i < 15; i++) {
          await new Promise((r) => setTimeout(r, 150))
          try {
            await fetch(`http://127.0.0.1:${config.port}/health`, {
              signal: AbortSignal.timeout(250),
            })
          } catch {
            break
          }
        }
      }

      if (!isRunning) {
        if (!isSilent) {
          process.stdout.write(`正在启动后台网关进程 (端口 :${config.port})...\n`)
        }
        spawnDetachedGateway(selfPath)

        // 等待服务端口就绪（服务端先绑定端口再初始化模块，正常在几百毫秒内就绪）
        for (let i = 0; i < 35; i++) {
          await new Promise((r) => setTimeout(r, 200))
          try {
            const ping = await fetch(`http://127.0.0.1:${config.port}/health`, {
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

      let freshRoutes: Record<string, RouteConfig> | null = null
      if (isRunning) {
        try {
          const syncRes = await fetch(`http://127.0.0.1:${config.port}/v1/gateway/sync`, {
            method: 'POST',
            signal: AbortSignal.timeout(12000),
          })
          if (syncRes.ok) {
            const syncJson = (await syncRes.json()) as { ok?: boolean; routes?: Record<string, RouteConfig> }
            if (syncJson.ok && syncJson.routes && Object.keys(syncJson.routes).length > 0) {
              freshRoutes = syncJson.routes
            }
          }
        } catch {}
      }
      // 仅非静默手动执行且守护未就绪时才在本地进程内执行兜底初始化，避免 SessionStart 超时后短命进程重拉完整模块
      if (!freshRoutes && !isSilent) {
        freshRoutes = await syncGatewayRoutes(host, config, { silent: false })
      }

      // 必须在 sync 之后重新加载磁盘配置，避免旧内存对象覆盖刚同步的 routes
      const latestConfig = loadGatewayConfig()
      const routesToApply = freshRoutes && Object.keys(freshRoutes).length > 0 ? freshRoutes : latestConfig.routes
      const routeAliases = Object.keys(routesToApply)
      const primaryAlias = routeAliases[0] ?? 'claude-sonnet-5-5'
      const smallAlias =
        routeAliases.find((a) => routesToApply[a]?.targetModel?.toLowerCase().includes('flash')) ??
        routeAliases[1] ??
        routeAliases[0] ??
        'claude-sonnet-4-6'

      try {
        applyGatewayToSettings(latestConfig.port, latestConfig.token, primaryAlias, smallAlias)
      } catch (err: any) {
        if (!isSilent) {
          process.stdout.write(`  警告: 更新 CLI settings.json 失败: ${err?.message ?? String(err)}\n`)
        }
      }

      try {
        const res = applyGatewayToClaude(routesToApply, latestConfig.port)
        if (!isSilent) {
          process.stdout.write(`\n✓ agent-gateway 网关已成功开启并隔离切换用户配置！\n`)
          process.stdout.write(`  网关监听: http://127.0.0.1:${latestConfig.port}\n`)
          process.stdout.write(`  已写入模型: ${res.modelCount} 个（原始配置已隔离备份）\n`)
          process.stdout.write(`  提示: 若当前 Claude 桌面端正在运行，重启桌面端即可生效最新模型。\n\n`)
        }
      } catch (err: any) {
        if (!isSilent) {
          process.stdout.write(`\n✓ agent-gateway 网关运行正常 (端口 :${latestConfig.port})\n`)
          process.stdout.write(`  桌面端接入提示: ${err?.message ?? String(err)}\n\n`)
        }
      }
      },
      { timeoutMs: 30_000 }
    )

    if (isSilent) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart' } }))
    }

    await host.disposeAll()
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

  // 4. 默认命令：serve（严格跟随 Claude 桌面端生命周期：桌面端打开时运行，彻底退出或插件禁用时彻底关闭）
  removeWindowsStartupScripts()
  const initialPluginState = getGatewayPluginState()
  if (!initialPluginState.indeterminate && initialPluginState.disabled) {
    logMessage('检测到 Claude 桌面端已禁用 agent-gateway 插件，正在还原配置并退出网关...')
    try {
      restoreOriginalSettings(config.token, config.passthrough?.settingsBaseUrl)
    } catch {}
    try {
      restoreOriginalClaudeProvider(config.passthrough?.deepseekBaseUrl)
    } catch {}
    rmSync(STATUS_FILE, { force: true })
    process.exit(0)
  }

  const initialClaudeRunning = await checkClaudeProcessRunning()
  if (initialClaudeRunning === false) {
    logMessage('未检测到运行中的 Claude 桌面端，网关跟随桌面端生命周期退出。')
    rmSync(STATUS_FILE, { force: true })
    process.exit(0)
  }

  logMessage(`正在启动 agent-gateway (端口 :${config.port})...`)
  const initPromise = host.initAll({
    gatewayPort: config.port,
    log: logMessage,
    dataDir: DATA_DIR,
  })

  const gatewayServer = createGatewayServer({
    config,
    host,
    log: logMessage,
    buildStamp: getSelfBuildStamp(fileURLToPath(import.meta.url)),
    readyPromise: initPromise,
    onSyncRequest: () => syncGatewayRoutes(host, config, { silent: true, skipInit: true }),
  })

  try {
    await gatewayServer.start()
  } catch (err: any) {
    if (err?.code === 'EADDRINUSE') {
      logMessage(`端口 :${config.port} 已有运行中的网关实例，当前重复进程安全退出。`)
      await initPromise.catch(() => {})
      await host.disposeAll()
      process.exit(0)
    }
    throw err
  }

  // 端口就绪后等待模块初始化完成即执行一次全量模型同步
  void initPromise
    .then(() => syncGatewayRoutes(host, config, { silent: true, skipInit: true }))
    .catch(() => {})

  writeFileAtomicSync(
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

  let shuttingDown = false
  const shutdown = async (restoreOnDisable = false) => {
    if (shuttingDown) return
    shuttingDown = true
    const forceExitTimer = setTimeout(() => {
      process.exit(0)
    }, 3000)
    forceExitTimer.unref?.()

    stopClaudeWatcher()
    removeWindowsStartupScripts()
    rmSync(STATUS_FILE, { force: true })

    if (restoreOnDisable) {
      let latestCfg = config
      try {
        latestCfg = loadGatewayConfig()
      } catch {}
      try {
        restoreOriginalSettings(latestCfg.token || config.token, latestCfg.passthrough?.settingsBaseUrl ?? config.passthrough?.settingsBaseUrl)
      } catch {}
      try {
        restoreOriginalClaudeProvider(latestCfg.passthrough?.deepseekBaseUrl ?? config.passthrough?.deepseekBaseUrl)
      } catch {}
    } else {
      logMessage('接收到停机信号，正在彻底停止网关...')
    }
    await gatewayServer.close()
    await host.disposeAll()
    process.exit(0)
  }

  const stopClaudeWatcher = createClaudeLifecycleMonitor({
    pollIntervalMs: 2000,
    exitConfirmPolls: 2,
    initialRunning: initialClaudeRunning ?? true,
    checkPluginState: () => getGatewayPluginState(initialPluginState.registered),
    onClaudeStart: () => {
      const st = getGatewayPluginState(initialPluginState.registered)
      if (!st.indeterminate && !st.disabled) {
        syncGatewayRoutes(host, config, { silent: true, skipInit: true }).catch(() => {})
      }
    },
    onClaudeExit: () => {
      void shutdown(false)
    },
    onPluginDisabled: () => {
      void shutdown(true)
    },
    log: logMessage,
  })

  process.on('SIGINT', () => void shutdown(false))
  process.on('SIGTERM', () => void shutdown(false))
}

main().catch((err) => {
  console.error('启动失败:', err)
  process.exit(1)
})
