/**
 * 把网关接进 Claude Code 的设置文件，并保证可以完整撤销。
 *
 * 用法：
 *   node scripts/settings.mjs enable           把网关写进用户级设置（默认）
 *   node scripts/settings.mjs enable --project 写进当前项目的 .claude/settings.local.json
 *   node scripts/settings.mjs disable          只移除本程序写入的键，保留网关本身
 *   node scripts/settings.mjs uninstall        移除键并清掉安装记录
 *
 * 撤销机制：安装时把每个键的“原来的值”记进 ~/.workbuddy-claude/installed.json，
 * 卸载时按记录逐键还原（原来没有这个键就删掉它）。这样不会误删用户自己配的
 * 其它环境变量，也不会把用户的设置文件整份覆盖掉。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { dirname as dirnameOf, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = join(homedir(), '.workbuddy-claude')
const CONFIG_PATH = join(HOME, 'config.json')
const MARKER_PATH = join(HOME, 'installed.json')
const ROOT = resolvePath(dirnameOf(fileURLToPath(import.meta.url)), '..')
const SERVER_PATH = join(ROOT, 'dist', 'server.js')

/** Claude Code 读取的上下文窗口上限：模型标称 1000k，留一截给工具输出和压缩余量。 */
const AUTO_COMPACT_WINDOW = '800000'

/** 本程序会写入的全部环境变量名。 */
const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
]

/** 读 JSON 文件；不存在或损坏时返回 null。 */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** 原子地写 JSON 文件。 */
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** 解析命令行参数。 */
function parseArgs(argv) {
  const command = argv[2] ?? 'enable'
  const projectIndex = argv.indexOf('--project')
  return {
    command,
    scope: projectIndex === -1 ? 'user' : 'project',
    projectDir: projectIndex === -1 ? undefined : resolve(argv[projectIndex + 1] ?? process.cwd()),
  }
}

/** 目标设置文件路径。 */
function settingsPath(scope, projectDir) {
  return scope === 'project'
    ? join(projectDir, '.claude', 'settings.local.json')
    : join(homedir(), '.claude', 'settings.json')
}

/** 组装要写入的环境变量。 */
function desiredEnv(config) {
  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${config.port}`,
    ANTHROPIC_AUTH_TOKEN: config.token,
    ANTHROPIC_MODEL: config.defaultModel,
    ANTHROPIC_SMALL_FAST_MODEL: config.smallModel || config.defaultModel,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: AUTO_COMPACT_WINDOW,
  }
}

/** enable：写入环境变量，并把原来的值记进安装记录。 */
function enable(scope, projectDir) {
  const config = readJson(CONFIG_PATH)
  if (config === null) throw new Error(`missing ${CONFIG_PATH}; run the gateway once (node dist/server.js models) first`)
  if (typeof config.defaultModel !== 'string' || config.defaultModel === '') {
    throw new Error('config.defaultModel is empty; run: node dist/server.js set defaultModel <model-id>')
  }

  const target = settingsPath(scope, projectDir)
  const settings = readJson(target) ?? {}
  const env = typeof settings.env === 'object' && settings.env !== null ? { ...settings.env } : {}

  // 安装记录按“设置文件 + 绝对路径的目标”分别保存，用户级和项目级互不覆盖。
  const marker = readJson(MARKER_PATH) ?? { installs: [] }
  const existing = marker.installs.find(entry => entry.path === target)
  const previous = existing?.previous ?? {}
  for (const key of ENV_KEYS) {
    if (!(key in previous)) previous[key] = key in env ? env[key] : null
  }

  const desired = desiredEnv(config)
  for (const key of ENV_KEYS) env[key] = desired[key]
  settings.env = env

  // 状态栏：显示当前模型、WB 账号与积分。它和执行环境变量是两件事，
  // 所以单独记录原值，disable 时按记录还原（旧记录没有这个字段就不碰）。
  const previousStatusLine = existing !== undefined && 'previousStatusLine' in existing
    ? existing.previousStatusLine
    : ('statusLine' in settings ? settings.statusLine : null)
  settings.statusLine = {
    type: 'command',
    command: `"${process.execPath}" "${SERVER_PATH}" statusline`,
  }

  // 备份一次原文件，给“整份还原”留后路。
  if (existsSync(target) && existing === undefined) {
    const backup = join(HOME, `settings.backup.${Date.now()}.json`)
    copyFileSync(target, backup)
    if (existing === undefined) marker.lastBackup = backup
  }

  marker.installs = [
    ...marker.installs.filter(entry => entry.path !== target),
    { path: target, scope, previous, previousStatusLine },
  ]
  writeJson(target, settings)
  writeJson(MARKER_PATH, marker)

  process.stdout.write(`installed env into ${target}\n`)
  process.stdout.write(`  ANTHROPIC_BASE_URL=${desired.ANTHROPIC_BASE_URL}\n`)
  process.stdout.write(`  ANTHROPIC_MODEL=${desired.ANTHROPIC_MODEL}\n`)
  process.stdout.write(`  ANTHROPIC_SMALL_FAST_MODEL=${desired.ANTHROPIC_SMALL_FAST_MODEL}\n`)
  process.stdout.write(`  statusLine=${SERVER_PATH} statusline\n`)
}

/** disable：按安装记录逐键还原，不碰其它键。 */
function disable(scope, projectDir, removeMarker) {
  const marker = readJson(MARKER_PATH)
  if (marker === null || !Array.isArray(marker.installs) || marker.installs.length === 0) {
    process.stdout.write('nothing recorded as installed; no env keys were removed\n')
    return
  }
  const target = settingsPath(scope, projectDir)
  const entries = removeMarker
    ? marker.installs
    : marker.installs.filter(entry => entry.path === target)

  for (const entry of entries) {
    const settings = readJson(entry.path)
    if (settings === null) continue
    const env = typeof settings.env === 'object' && settings.env !== null ? { ...settings.env } : {}
    for (const key of ENV_KEYS) {
      const original = entry.previous?.[key]
      if (original === null || original === undefined) delete env[key]
      else env[key] = original
    }
    if (Object.keys(env).length === 0) delete settings.env
    else settings.env = env
    // 只有本版本写入过 statusLine 的安装记录才还原它；旧记录没有这个字段，
    // 说明用户自己的状态栏不该被动过。
    if ('previousStatusLine' in entry) {
      if (entry.previousStatusLine === null || entry.previousStatusLine === undefined) delete settings.statusLine
      else settings.statusLine = entry.previousStatusLine
    }
    writeJson(entry.path, settings)
    process.stdout.write(`restored ${entry.path}\n`)
  }

  if (removeMarker) {
    try {
      rmSync(MARKER_PATH)
    } catch {
      // 文件已经不在，无需处理。
    }
  } else {
    marker.installs = marker.installs.filter(entry => entry.path !== target)
    writeJson(MARKER_PATH, marker)
  }
}

const { command, scope, projectDir } = parseArgs(process.argv)

if (command === 'enable') enable(scope, projectDir)
else if (command === 'disable') disable(scope, projectDir, false)
else if (command === 'uninstall') disable(scope, projectDir, true)
else {
  console.error('usage: node scripts/settings.mjs enable|disable|uninstall [--project <dir>]')
  process.exit(1)
}
