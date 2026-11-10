/**
 * 管理发往 DeepSeek 的路由（可以有多条）。
 *
 * DeepSeek 的 Anthropic 兼容端点按**模型名前缀**决定用哪个模型：
 *   claude-opus*                 → deepseek-v4-pro（按 V4 Pro 计费）
 *   claude-sonnet* / claude-haiku* → deepseek-flash
 * 所以“用 DeepSeek 的哪个模型”这件事，完全由这里的别名前缀决定。
 *
 * 本脚本把增删改成一条命令，避免手工编辑 routes 时改坏别的条目。
 *
 * 用法：
 *   node scripts/deepseek-route.mjs show
 *   node scripts/deepseek-route.mjs set --alias claude-opus-5.5 --label "DeepSeek · V4 Pro"
 *   node scripts/deepseek-route.mjs set --alias claude-sonnet-5.5 --label "DeepSeek · Flash" --apply
 *   node scripts/deepseek-route.mjs remove --alias claude-sonnet-5.5 --apply
 *
 * 参数：
 *   --alias <模型名> 发给 DeepSeek 的模型名；前缀决定上游用哪个模型
 *   --label <文字>   模型选择器里显示的名字
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

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
config.routes = config.routes ?? {}

/** 当前所有 DeepSeek 路由。 */
function deepSeekRoutes() {
  return Object.entries(config.routes).filter(([, route]) => route.provider === 'deepseek')
}

if (command === 'show') {
  const entries = deepSeekRoutes()
  if (entries.length === 0) {
    process.stdout.write('当前没有 DeepSeek 路由：所有请求都走 WorkBuddy\n')
  } else {
    process.stdout.write(`DeepSeek 地址：${config.deepseekBaseUrl}\n`)
    for (const [alias, route] of entries) {
      const prefix = alias.toLowerCase()
      const upstream = prefix.startsWith('claude-opus')
        ? 'deepseek-v4-pro'
        : 'deepseek-flash'
      process.stdout.write(`  ${alias.padEnd(26)} → ${upstream.padEnd(16)} 显示为「${route.label ?? alias}」\n`)
    }
  }
  process.exit(0)
}

if (command === 'set') {
  const alias = option('alias')
  if (alias === undefined || alias.trim() === '') throw new Error('--alias is required')
  const label = option('label') ?? alias
  const existing = config.routes[alias]
  if (existing !== undefined && existing.provider !== 'deepseek') {
    throw new Error(`${alias} is already a ${existing.provider} route; pick another alias`)
  }
  config.routes[alias] = { provider: 'deepseek', label }
  process.stdout.write(`DeepSeek 路由：${alias}  →  显示为「${label}」\n`)
} else if (command === 'remove') {
  const alias = option('alias')
  if (alias === undefined) throw new Error('--alias is required')
  if (config.routes[alias]?.provider !== 'deepseek') throw new Error(`${alias} is not a deepseek route`)
  delete config.routes[alias]
  process.stdout.write(`已删除 DeepSeek 路由：${alias}\n`)
} else {
  console.error('usage: node scripts/deepseek-route.mjs show | set --alias <模型名> [--label <文字>] | remove --alias <模型名>  [--apply]')
  process.exit(1)
}

// DeepSeek 路由统一放在最前面：App 的模型列表就是这个对象的键顺序。
// 新增的条目落在现有 DeepSeek 条目之后，所以“Flash、V4 Pro、其余”这个顺序保持不变。
const ordered = Object.entries(config.routes)
config.routes = Object.fromEntries([
  ...ordered.filter(([, route]) => route.provider === 'deepseek'),
  ...ordered.filter(([, route]) => route.provider !== 'deepseek'),
])

writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`)

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
