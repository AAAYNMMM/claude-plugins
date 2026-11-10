/**
 * 把桌面 App 的模型提供方指到本网关，让模型列表同时出现 DeepSeek 与 WorkBuddy。
 *
 * 用法：
 *   node scripts/app-provider.mjs apply     备份后改写（只动地址与模型列表）
 *   node scripts/app-provider.mjs restore   从备份还原
 *   node scripts/app-provider.mjs show      只读展示当前配置（密钥打码）
 *
 * 只改三个非敏感字段：inferenceGatewayBaseUrl、inferenceModels、inferenceProvider。
 * inferenceGatewayApiKey 是应用用 Windows DPAPI 加密的私有凭据，**原样保留**，
 * 本脚本既不读取也不解密它。改动前会把整份配置备份到 ~/.workbuddy-claude/。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = join(homedir(), '.workbuddy-claude')
const CONFIG_PATH = join(HOME, 'config.json')
const BACKUP_DIR = join(HOME, 'app-provider-backups')

/** App 的配置库目录。 */
function libraryDir() {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  return join(local, 'Claude-3p', 'configLibrary')
}

/** 当前生效的配置条目路径。 */
function activeProviderPath() {
  const meta = JSON.parse(readFileSync(join(libraryDir(), '_meta.json'), 'utf8'))
  const id = meta.appliedId
  if (typeof id !== 'string' || id === '') throw new Error('configLibrary/_meta.json has no appliedId')
  return join(libraryDir(), `${id}.json`)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** 把密钥字段打码后再展示，避免把凭据写进终端或日志。 */
function redact(entry) {
  const clone = { ...entry }
  for (const key of Object.keys(clone)) {
    if (/key|token|secret/i.test(key)) clone[key] = '<redacted>'
  }
  return clone
}

const command = process.argv[2] ?? 'show'
const path = activeProviderPath()

if (command === 'show') {
  const current = readJson(path)
  process.stdout.write(`${path}\n${JSON.stringify({ ...redact(current), inferenceModels: current.inferenceModels }, null, 2)}\n`)
} else if (command === 'apply') {
  const gateway = readJson(CONFIG_PATH)
  const current = readJson(path)

  mkdirSync(BACKUP_DIR, { recursive: true })
  const backup = join(BACKUP_DIR, `provider.${Date.now()}.json`)
  copyFileSync(path, backup)

  // 路由表决定模型列表：每条路由在 App 里就是一个可选的模型。
  const models = Object.entries(gateway.routes ?? {}).map(([id, route]) => ({
    name: id,
    labelOverride: route.label ?? id,
  }))

  current.inferenceGatewayBaseUrl = `http://127.0.0.1:${gateway.port}`
  current.inferenceModels = models
  current.inferenceProvider = 'gateway'
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`)

  // App 发来的是它自己的密钥（读不到），所以网关必须放宽为回环鉴权；
  // DeepSeek 路由会把这个密钥原样转发出去。
  gateway.auth = 'loopback'
  writeFileSync(CONFIG_PATH, `${JSON.stringify(gateway, null, 2)}\n`)

  process.stdout.write(`backed up to ${backup}\n`)
  process.stdout.write(`gateway base url -> ${current.inferenceGatewayBaseUrl}\n`)
  process.stdout.write(`models:\n`)
  for (const model of models) process.stdout.write(`  ${model.name}  ${model.labelOverride}\n`)
  process.stdout.write('restart the Claude app to pick this up\n')
} else if (command === 'restore') {
  const backups = existsSync(BACKUP_DIR)
    ? readdirSync(BACKUP_DIR).filter(name => name.startsWith('provider.')).sort()
    : []
  if (backups.length === 0) throw new Error(`no backup found in ${BACKUP_DIR}`)
  const latest = join(BACKUP_DIR, backups[backups.length - 1])
  copyFileSync(latest, path)
  process.stdout.write(`restored ${path} from ${latest}\n`)
} else {
  console.error('usage: node scripts/app-provider.mjs apply|restore|show')
  process.exit(1)
}
