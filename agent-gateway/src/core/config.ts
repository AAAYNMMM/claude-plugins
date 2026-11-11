/**
 * 网关配置中心与 Claude Desktop / CLI 隔离切换管理器。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { GatewayConfig, RouteConfig } from './types.ts'

export const DATA_DIR = join(homedir(), '.agent-gateway')
export const CONFIG_FILE = join(DATA_DIR, 'config.json')
export const STATUS_FILE = join(DATA_DIR, 'status.json')
export const LOG_FILE = join(DATA_DIR, 'gateway.log')
export const ORIGINAL_PROVIDER_BACKUP = join(DATA_DIR, 'original-provider.json')
export const CLI_INSTALL_MARKER = join(DATA_DIR, 'cli-installed.json')

export const DEFAULT_CONFIG: GatewayConfig = {
  port: 43119,
  token: randomBytes(24).toString('hex'),
  authMode: 'loopback',
  defaultModel: 'claude-sonnet-5.5',
  smallModel: 'claude-haiku-5-5',
  routes: {},
  passthrough: {
    deepseekBaseUrl: 'https://api.deepseek.com/anthropic',
  },
  workbuddy: {
    region: 'auto',
    channelPerturbation: 'off',
  },
  antigravity: {
    defaultModel: 'gemini-2.5-flash',
  },
}

export function loadGatewayConfig(): GatewayConfig {
  mkdirSync(DATA_DIR, { recursive: true })
  if (!existsSync(CONFIG_FILE)) {
    saveGatewayConfig(DEFAULT_CONFIG)
    return { ...DEFAULT_CONFIG }
  }
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<GatewayConfig>
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      routes: parsed.routes ?? {},
      passthrough: { ...DEFAULT_CONFIG.passthrough, ...parsed.passthrough },
      workbuddy: { ...DEFAULT_CONFIG.workbuddy, ...parsed.workbuddy },
      antigravity: { ...DEFAULT_CONFIG.antigravity, ...parsed.antigravity },
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveGatewayConfig(config: GatewayConfig): void {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

/** 获取 Claude 桌面端 configLibrary 路径 */
export function getClaudeLibraryDir(): string {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  return join(local, 'Claude-3p', 'configLibrary')
}

/** 当前生效的 Claude 桌面端配置条目路径 */
export function getActiveClaudeProviderPath(): string | null {
  const libDir = getClaudeLibraryDir()
  const metaPath = join(libDir, '_meta.json')
  if (!existsSync(metaPath)) return null
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    const id = meta.appliedId
    if (typeof id === 'string' && id) {
      const target = join(libDir, `${id}.json`)
      if (existsSync(target)) return target
    }
  } catch {}
  return null
}

/**
 * 备份原本的 Claude 桌面端配置（仅在尚未备份过时创建，确保原始配置绝对不丢失）
 */
export function backupOriginalClaudeProvider(): boolean {
  const activePath = getActiveClaudeProviderPath()
  if (!activePath) return false

  mkdirSync(DATA_DIR, { recursive: true })
  // 如果原本备份不存在，才保存当前配置作为"原始代理配置"
  if (!existsSync(ORIGINAL_PROVIDER_BACKUP)) {
    copyFileSync(activePath, ORIGINAL_PROVIDER_BACKUP)
    return true
  }
  return false
}

/**
 * 将网关接入 Claude 桌面端：只动端点和模型列表，保留应用私有加密密钥
 */
export function applyGatewayToClaude(routes: Record<string, RouteConfig>, port: number): {
  activePath: string
  modelCount: number
} {
  const activePath = getActiveClaudeProviderPath()
  if (!activePath) {
    throw new Error('未找到 Claude 桌面端的配置库 (_meta.json)，请确保已安装并启动过 Claude 桌面端。')
  }

  // 1. 确保原始配置已安全备份
  backupOriginalClaudeProvider()

  // 2. 读取当前活跃配置
  const providerConfig = JSON.parse(readFileSync(activePath, 'utf8'))

  // 3. 构建模型映射条目
  const models = Object.entries(routes).map(([alias, r]) => ({
    name: alias,
    labelOverride: r.label ?? alias,
  }))

  providerConfig.inferenceGatewayBaseUrl = `http://127.0.0.1:${port}`
  providerConfig.inferenceModels = models
  providerConfig.inferenceProvider = 'gateway'

  writeFileSync(activePath, `${JSON.stringify(providerConfig, null, 2)}\n`, 'utf8')

  return { activePath, modelCount: models.length }
}

/**
 * 关闭网关，完整恢复用户原本的 Claude 桌面端代理/账号配置
 */
export function restoreOriginalClaudeProvider(): { activePath: string; restored: boolean } {
  const activePath = getActiveClaudeProviderPath()
  if (!activePath) {
    throw new Error('未找到 Claude 桌面端配置库。')
  }

  if (!existsSync(ORIGINAL_PROVIDER_BACKUP)) {
    // 检查历史备份
    const legacyBackup = join(homedir(), '.workbuddy-claude', 'app-provider-backups')
    if (existsSync(legacyBackup)) {
      const fs = readFileSync(join(legacyBackup, 'provider.1794329074570.json'), 'utf8')
      writeFileSync(activePath, fs, 'utf8')
      return { activePath, restored: true }
    }
    throw new Error(`未找到原始代理配置文件备份 (${ORIGINAL_PROVIDER_BACKUP})，无法恢复。`)
  }

  copyFileSync(ORIGINAL_PROVIDER_BACKUP, activePath)
  // 恢复后移除网关备份，以便用户下次修改原本代理后再启动时捕获最新配置
  rmSync(ORIGINAL_PROVIDER_BACKUP, { force: true })

  return { activePath, restored: true }
}

export function logMessage(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(LOG_FILE, line, { flag: 'a' })
  } catch {}
  process.stdout.write(line)
}
