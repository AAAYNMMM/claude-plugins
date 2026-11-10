/**
 * 管理发往 DeepSeek 的那条路由（显示名、以及发给 DeepSeek 的模型名）。
 *
 * 为什么需要它：接上本网关后，桌面 App 的“推理配置”里只剩一个 Base URL 和一份
 * 模型列表，真正决定某个模型走 DeepSeek 还是走 WorkBuddy 的是
 * ~/.workbuddy-claude/config.json 里的 routes。这个脚本把那条 DeepSeek 路由的
 * 修改收敛成一条命令，避免手工改 JSON 时改坏别的条目。
 *
 * 用法：
 *   node scripts/deepseek-route.mjs show
 *   node scripts/deepseek-route.mjs set --label "DeepSeek V4 Flash"
 *   node scripts/deepseek-route.mjs set --alias claude-opus-4-8 --label "DeepSeek V4 Pro" --apply
 *
 * 参数：
 *   --label <文字>   模型选择器里显示的名字
 *   --alias <模型名> 发给 DeepSeek 的模型名（原名是 claude-sonnet-5.5）
 *   --apply          改完立刻同步到桌面 App，并重启网关
 */

import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_PATH = join(homedir(), '.workbuddy-claude', 'config.json')
const STATUS_PATH = join(homedir(), '.workbuddy-claude', 'status.json')

const argv = process.argv.slice(2)
const command = argv[0] ?? 'show'

/** 取 `--name value` 形式的参数。 */
function option(name) {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}

/** 找到当前唯一那条 DeepSeek 路由。 */
function findDeepSeek(routes) {
  return Object.entries(routes).find(([, route]) => route.provider === 'deepseek')
}

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
config.routes = config.routes ?? {}

if (command === 'show') {
  const entry = findDeepSeek(config.routes)
  if (entry === undefined) {
    process.stdout.write('当前没有 DeepSeek 路由：所有请求都走 WorkBuddy\n')
  } else {
    const [alias, route] = entry
    process.stdout.write(`发给 DeepSeek 的模型名：${alias}\n`)
    process.stdout.write(`模型选择器显示名    ：${route.label ?? alias}\n`)
    process.stdout.write(`DeepSeek 地址       ：${config.deepseekBaseUrl}\n`)
  }
  process.exit(0)
}

if (command !== 'set') {
  console.error('usage: node scripts/deepseek-route.mjs show | set --label <文字> [--alias <模型名>] [--apply]')
  process.exit(1)
}

const entry = findDeepSeek(config.routes)
if (entry === undefined) throw new Error('config.json has no deepseek route; run scripts/routes.mjs sync first')
const [currentAlias, currentRoute] = entry
const nextAlias = option('alias') ?? currentAlias
const nextLabel = option('label') ?? currentRoute.label ?? currentAlias

if (nextAlias !== currentAlias) {
  if (config.routes[nextAlias] !== undefined) {
    throw new Error(`alias ${nextAlias} is already used by ${config.routes[nextAlias].provider} route; pick another`)
  }
  delete config.routes[currentAlias]
}
config.routes[nextAlias] = { provider: 'deepseek', label: nextLabel }
writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`)

process.stdout.write(`DeepSeek 路由已更新：${nextAlias}  →  显示为「${nextLabel}」\n`)

if (!argv.includes('--apply')) {
  process.stdout.write('要让它生效：node scripts/app-provider.mjs apply，然后重启 Claude App\n')
  process.exit(0)
}

// 同步到 App
execFileSync(process.execPath, [join(ROOT, 'scripts', 'app-provider.mjs'), 'apply'], { stdio: 'inherit' })

// 重启网关：结束当前进程，让看护脚本拉起；看护不在时自己拉起一个。
let pid = 0
try {
  pid = JSON.parse(readFileSync(STATUS_PATH, 'utf8')).pid ?? 0
} catch {
  pid = 0
}
if (pid !== 0) {
  try {
    process.kill(pid)
  } catch {
    // 进程可能已经不在了。
  }
}

/** 轮询健康检查，确认网关回来了。 */
async function waitForGateway(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return true
    } catch {
      // 还没起来，继续等。
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  return false
}

if (!(await waitForGateway(12_000))) {
  const child = spawn(process.execPath, [join(ROOT, 'dist', 'server.js'), 'serve'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: ROOT,
  })
  child.unref()
  if (!(await waitForGateway(15_000))) {
    throw new Error('gateway did not come back; start it with: node dist/server.js serve')
  }
}
process.stdout.write('网关已重启。重启 Claude App 后生效。\n')
