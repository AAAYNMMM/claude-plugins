/**
 * 把 WorkBuddy 目录里的全部模型同步进网关路由表。
 *
 * 桌面 App 要求每个模型条目的 `name` 是一个 Anthropic 模型 ID，所以这里用一组
 * Anthropic 模型名当“别名”，每个别名绑定一个真实的 WorkBuddy 模型。别名一旦
 * 分配就写进配置保持不变，目录新增模型时只追加、不重排，避免用户的选择错位。
 *
 * 用法：
 *   node scripts/routes.mjs sync        同步路由表（写入 ~/.workbuddy-claude/config.json）
 *   node scripts/routes.mjs list        只读展示当前路由
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_PATH = join(homedir(), '.workbuddy-claude', 'config.json')

/**
 * 可用作别名的 Anthropic 模型名。
 *
 * 前 15 个来自 App 的模型目录（一定有）；末尾几个是 App 代码里仍认得的旧型号，
 * 用来给第 16 个 WorkBuddy 模型腾位置。全部唯一，互不冲突。
 */
const ALIAS_POOL = [
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5-2',
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5-20251101',
  'claude-opus-4-1-20250805',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-1',
]

/** DeepSeek 透传路由固定用的模型名（App 当前就在用它）。 */
const DEEPSEEK_ALIAS = 'claude-sonnet-5.5'

/** 调 CLI 拿目录：每行是 id、倍率、上下文、显示名，用制表符分隔。 */
function readCatalog() {
  const output = execFileSync(process.execPath, [join(ROOT, 'dist', 'server.js'), 'models'], {
    encoding: 'utf8',
    cwd: ROOT,
  })
  return output
    .split(/\r?\n/)
    .map(line => line.split('\t'))
    .filter(parts => parts.length >= 3 && parts[0] !== '')
    .map(([id, multiplier, context, name]) => ({ id, multiplier, context, name: name ?? id }))
}

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
const routes = config.routes ?? {}

if ((process.argv[2] ?? 'list') === 'list') {
  for (const [alias, route] of Object.entries(routes)) {
    process.stdout.write(`${alias}\t${route.provider}\t${route.model ?? ''}\t${route.label ?? ''}\n`)
  }
  process.exit(0)
}

const catalog = readCatalog()

// DeepSeek 透传始终保留一条，保证 App 切换回 DeepSeek 时不缺项。
// 已经有 DeepSeek 路由时不再覆盖：用户可能改过它的显示名或模型名，
// 每次同步都重置会让他的修改凭空消失。
if (!Object.values(routes).some(route => route.provider === 'deepseek')) {
  routes[DEEPSEEK_ALIAS] = { provider: 'deepseek', label: 'DeepSeek · Sonnet' }
}

/** 已经被占用的别名。 */
const used = new Set(Object.keys(routes))
/** 已经绑定过的 WorkBuddy 模型，避免重复分配。 */
const bound = new Set(
  Object.values(routes)
    .filter(route => route.provider === 'workbuddy' && typeof route.model === 'string')
    .map(route => route.model),
)

for (const model of catalog) {
  if (bound.has(model.id)) continue
  const alias = ALIAS_POOL.find(name => !used.has(name))
  if (alias === undefined) {
    process.stderr.write(`no free alias left for ${model.id}\n`)
    continue
  }
  const multiplier = model.multiplier === 'x?' ? '' : ` (${model.multiplier})`
  // 标签用模型 id 而不是显示名：目录里 Hy4、Hy3 各有两条同名不同倍率的模型，
  // 用显示名会出现两个一模一样的选项，分不清选的是哪一个。
  routes[alias] = { provider: 'workbuddy', model: model.id, label: `WB · ${model.id}${multiplier}` }
  used.add(alias)
  bound.add(model.id)
}

// 已有路由的标签也按同一个规则刷新，保证升级后名称一致（别名与绑定关系不动）。
const byModel = new Map(catalog.map(model => [model.id, model]))
for (const route of Object.values(routes)) {
  if (route.provider !== 'workbuddy' || typeof route.model !== 'string') continue
  const model = byModel.get(route.model)
  if (model === undefined) continue
  const multiplier = model.multiplier === 'x?' ? '' : ` (${model.multiplier})`
  route.label = `WB · ${model.id}${multiplier}`
}

config.routes = routes
writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`)

const workbuddy = Object.values(routes).filter(route => route.provider === 'workbuddy').length
process.stdout.write(`synced ${workbuddy} WorkBuddy models + 1 DeepSeek route into ${CONFIG_PATH}\n`)
for (const [alias, route] of Object.entries(routes)) {
  process.stdout.write(`  ${alias}\t${route.label ?? route.model ?? ''}\n`)
}
