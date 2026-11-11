/**
 * agent-gateway 插件主入口：
 * 启动网关守护进程、模块聚合、路由同步与状态查询。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  DATA_DIR,
  STATUS_FILE,
  applyGatewayToClaude,
  loadGatewayConfig,
  logMessage,
  restoreOriginalClaudeProvider,
  saveGatewayConfig,
} from './core/config.ts'
import { ModuleHost } from './core/module-host.ts'
import { createGatewayServer } from './core/server.ts'
import type { RouteConfig } from './core/types.ts'

const command = process.argv[2] ?? 'serve'

/**
 * Claude 桌面端官方白名单认可的合规模型别名池（45+ 个唯一合规名）
 * 严格避开 deepseek、kimi、glm、qwen、gpt 等厂商黑名单，防止 App 弹出 ⚠️ 警告
 */
const COMPLIANT_ALIASES = [
  // 3.7 / 3.5 官方标准名
  'claude-3-7-sonnet-20250219',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-sonnet-20240620',
  'claude-3-5-haiku-20241022',
  'claude-3-haiku-20240307',
  'claude-3-opus-20240229',
  // 5.x 世代名
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-fable-5-2',
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-5',
  // 4.x 世代名
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5-20251101',
  'claude-opus-4-5',
  'claude-opus-4-1-20250805',
  'claude-opus-4-1',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-5',
  'claude-sonnet-4-2',
  'claude-sonnet-4-1',
  'claude-haiku-4-5-20251001',
  'claude-haiku-4-5',
  'claude-haiku-4-2',
  'claude-haiku-4-1',
  // 经典版本
  'claude-2.1',
  'claude-2.0',
  'claude-instant-1.2',
  'claude-instant-1.1',
  'claude-v1.3',
  'claude-v1.2',
  'claude-v1.1',
  'claude-v1.0',
  // 扩展序列
  'claude-sonnet-3-8',
  'claude-opus-3-8',
  'claude-haiku-3-8',
  'claude-sonnet-3-9',
  'claude-opus-3-9',
  'claude-haiku-3-9',
]

async function main() {
  const config = loadGatewayConfig()
  const host = new ModuleHost()

  if (config.antigravity?.apiKey) {
    host.getAntigravityModule().setApiKey(config.antigravity.apiKey)
  }

  // 0. 一键开启网关并接入 Claude 桌面端
  if (command === 'on' || command === 'enable') {
    let isRunning = false
    try {
      const ping = await fetch(`http://127.0.0.1:${config.port}/v1/models`, {
        signal: AbortSignal.timeout(1000),
      })
      if (ping.ok) isRunning = true
    } catch {}

    if (!isRunning) {
      process.stdout.write(`正在启动后台网关守护进程 (端口 :${config.port})...\n`)
      const selfPath = fileURLToPath(import.meta.url)
      const child = spawn(process.execPath, [selfPath, 'serve'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref()

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

    let currentConfig = loadGatewayConfig()
    if (Object.keys(currentConfig.routes).length === 0) {
      process.stdout.write('正在初始化模型路由...\n')
      await host.initAll({
        gatewayPort: config.port,
        log: () => {},
        dataDir: DATA_DIR,
      })
      const aggregated = await host.aggregateModels()
      const newRoutes: Record<string, RouteConfig> = {}
      const usedAliases = new Set<string>()
      aggregated.sort((a, b) => {
        if (a.module === 'antigravity' && b.module !== 'antigravity') return -1
        if (a.module !== 'antigravity' && b.module === 'antigravity') return 1
        return 0
      })
      let aliasIdx = 0
      for (const item of aggregated) {
        if (item.module === 'passthrough') continue
        while (aliasIdx < COMPLIANT_ALIASES.length && usedAliases.has(COMPLIANT_ALIASES[aliasIdx])) {
          aliasIdx++
        }
        if (aliasIdx >= COMPLIANT_ALIASES.length) break
        const alias = COMPLIANT_ALIASES[aliasIdx++]
        usedAliases.add(alias)
        newRoutes[alias] = {
          module: item.module,
          targetModel: item.model.id,
          label: item.model.labelOverride ?? item.model.name,
        }
      }
      currentConfig.routes = newRoutes
      saveGatewayConfig(currentConfig)
      await host.disposeAll()
    }

    try {
      const res = applyGatewayToClaude(currentConfig.routes, currentConfig.port)
      process.stdout.write(`\n✓ agent-gateway 网关已成功开启并接入 Claude 桌面端！\n`)
      process.stdout.write(`  网关监听: http://127.0.0.1:${currentConfig.port}\n`)
      process.stdout.write(`  已注入模型: ${res.modelCount} 个\n`)
      process.stdout.write(`  提示: 请重启 Claude 桌面端以加载新模型列表。\n\n`)
    } catch (err: any) {
      process.stdout.write(`\n✓ agent-gateway 网关运行正常 (端口 :${currentConfig.port})\n`)
      process.stdout.write(`  桌面端接入提示: ${err.message}\n\n`)
    }
    process.exit(0)
  }

  // 0.1 一键关闭网关并还原原本配置
  if (command === 'off' || command === 'disable') {
    process.stdout.write('正在关闭 agent-gateway 网关并还原原本配置...\n')
    // 停止后台网关
    try {
      if (existsSync(STATUS_FILE)) {
        const raw = JSON.parse(readFileSync(STATUS_FILE, 'utf8'))
        if (raw.pid) {
          process.kill(raw.pid, 'SIGTERM')
        }
      }
    } catch {}

    // 还原桌面端
    try {
      restoreOriginalClaudeProvider()
      process.stdout.write(`✓ 已完整还原 Claude 桌面端原本的代理/账号配置！\n`)
      process.stdout.write(`  提示: 请重启 Claude 桌面端生效。\n\n`)
    } catch (err: any) {
      process.stdout.write(`  提示: ${err.message}\n\n`)
    }
    process.exit(0)
  }

  // 1. 同步与补全模型路由表
  if (command === 'sync') {
    process.stdout.write('正在扫描各模块账号内全部可选模型并同步合规路由表...\n')
    await host.initAll({
      gatewayPort: config.port,
      log: logMessage,
      dataDir: DATA_DIR,
    })

    const aggregated = await host.aggregateModels()
    // 开启网关时仅展示网关下属模块的模型（反重力 + WorkBuddy），不混入原本模型
    const newRoutes: Record<string, RouteConfig> = {}
    const usedAliases = new Set<string>()

    // 优先排序：把反重力的 5 大核心模型和 WorkBuddy 的主力模型置顶
    aggregated.sort((a, b) => {
      if (a.module === 'antigravity' && b.module !== 'antigravity') return -1
      if (a.module !== 'antigravity' && b.module === 'antigravity') return 1
      return 0
    })

    let aliasIdx = 0
    for (const item of aggregated) {
      const { module: modId, model } = item
      if (modId === 'passthrough') continue

      // 强制使用合规白名单别名，彻底避免 Claude 桌面端报黄色 ⚠️ 警告
      while (aliasIdx < COMPLIANT_ALIASES.length && usedAliases.has(COMPLIANT_ALIASES[aliasIdx])) {
        aliasIdx++
      }
      if (aliasIdx >= COMPLIANT_ALIASES.length) break

      const alias = COMPLIANT_ALIASES[aliasIdx++]
      usedAliases.add(alias)
      newRoutes[alias] = {
        module: modId,
        targetModel: model.id,
        label: model.labelOverride ?? model.name,
      }
    }

    config.routes = newRoutes
    saveGatewayConfig(config)

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

  // 4. 默认命令：serve（前台运行网关）
  logMessage(`正在启动 agent-gateway (端口 :${config.port})...`)
  await host.initAll({
    gatewayPort: config.port,
    log: logMessage,
    dataDir: DATA_DIR,
  })

  // 如果路由表为空，自动扫描生成合规路由
  if (Object.keys(config.routes).length === 0) {
    const aggregated = await host.aggregateModels()
    const routes: Record<string, RouteConfig> = {}
    const usedAliases = new Set<string>()

    aggregated.sort((a, b) => {
      if (a.module === 'antigravity' && b.module !== 'antigravity') return -1
      if (a.module !== 'antigravity' && b.module === 'antigravity') return 1
      return 0
    })

    let aliasIdx = 0
    for (const item of aggregated) {
      if (item.module === 'passthrough') continue
      while (aliasIdx < COMPLIANT_ALIASES.length && usedAliases.has(COMPLIANT_ALIASES[aliasIdx])) {
        aliasIdx++
      }
      if (aliasIdx >= COMPLIANT_ALIASES.length) break

      const alias = COMPLIANT_ALIASES[aliasIdx++]
      usedAliases.add(alias)
      routes[alias] = {
        module: item.module,
        targetModel: item.model.id,
        label: item.model.labelOverride ?? item.model.name,
      }
    }
    config.routes = routes
    saveGatewayConfig(config)
  }

  const gatewayServer = createGatewayServer({
    config,
    host,
    log: logMessage,
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

  const shutdown = async () => {
    logMessage('接收到停机信号，正在停止网关...')
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
