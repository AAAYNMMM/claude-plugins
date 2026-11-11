/**
 * 网关配置中心与 Claude Desktop / CLI 隔离切换管理器。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { GatewayConfig, RouteConfig } from './types.ts'

export const DATA_DIR = join(homedir(), '.agent-gateway')
export const CONFIG_FILE = join(DATA_DIR, 'config.json')
export const STATUS_FILE = join(DATA_DIR, 'status.json')
export const LOG_FILE = join(DATA_DIR, 'gateway.log')
export const ORIGINAL_PROVIDER_BACKUP = join(DATA_DIR, 'original-provider.json')
export const ORIGINAL_SETTINGS_ENV_BACKUP = join(DATA_DIR, 'original-settings-env.json')
export const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json')
export const CLI_INSTALL_MARKER = join(DATA_DIR, 'cli-installed.json')

/** 判断一个 URL 是否指向本机回环网关地址 */
export function isLocalGatewayUrl(url: unknown): boolean {
  return typeof url === 'string' && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(url.trim())
}

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
 * 备份原本的 Claude 桌面端配置（仅在尚未备份过、且当前不是网关本身时创建，确保原始配置不被污染）
 */
export function backupOriginalClaudeProvider(): boolean {
  const activePath = getActiveClaudeProviderPath()
  if (!activePath) return false

  mkdirSync(DATA_DIR, { recursive: true })
  if (existsSync(ORIGINAL_PROVIDER_BACKUP)) return false

  try {
    const raw = JSON.parse(readFileSync(activePath, 'utf8'))
    if (isLocalGatewayUrl(raw.inferenceGatewayBaseUrl)) {
      // 当前活跃配置已是本地网关，不能覆盖为“原始配置”
      return false
    }
  } catch {
    return false
  }

  copyFileSync(activePath, ORIGINAL_PROVIDER_BACKUP)
  return true
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
 * 动态寻找历史备份目录下的最新 JSON 备份
 */
function findLatestLegacyProviderBackup(): string | null {
  const legacyDir = join(homedir(), '.workbuddy-claude', 'app-provider-backups')
  if (!existsSync(legacyDir)) return null
  try {
    const files = readdirSync(legacyDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const full = join(legacyDir, f)
        return { full, mtime: statSync(full).mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)

    for (const item of files) {
      const content = readFileSync(item.full, 'utf8')
      const parsed = JSON.parse(content)
      if (!isLocalGatewayUrl(parsed.inferenceGatewayBaseUrl)) {
        return item.full
      }
    }
  } catch {}
  return null
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
    const legacy = findLatestLegacyProviderBackup()
    if (legacy) {
      copyFileSync(legacy, activePath)
      return { activePath, restored: true }
    }
    throw new Error(`未找到原始代理配置文件备份 (${ORIGINAL_PROVIDER_BACKUP})，无法自动恢复。`)
  }

  copyFileSync(ORIGINAL_PROVIDER_BACKUP, activePath)
  // 恢复后移除网关备份，以便用户下次修改原本代理后再启动时捕获最新配置
  rmSync(ORIGINAL_PROVIDER_BACKUP, { force: true })

  return { activePath, restored: true }
}

/**
 * 同步更新 ~/.claude/settings.json 的环境变量，实现 CLI 与 Code 标签页与网关联动开关
 */
export function applyGatewayToSettings(
  port: number,
  token: string,
  primaryModel = 'claude-sonnet-5-5',
  smallModel = 'claude-haiku-5-5'
): void {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) return
  try {
    const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8')) as Record<string, any>
    const currentEnv = (settings.env && typeof settings.env === 'object') ? settings.env : {}

    // 仅在尚未备份且原本不是指向本地网关时备份原 env
    if (!existsSync(ORIGINAL_SETTINGS_ENV_BACKUP) && !isLocalGatewayUrl(currentEnv.ANTHROPIC_BASE_URL)) {
      mkdirSync(DATA_DIR, { recursive: true })
      const snapshot = settings.env ? settings.env : { __empty: true }
      writeFileSync(ORIGINAL_SETTINGS_ENV_BACKUP, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    }

    settings.env = {
      ...currentEnv,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_AUTH_TOKEN: currentEnv.ANTHROPIC_AUTH_TOKEN || token,
      ANTHROPIC_MODEL: primaryModel,
      ANTHROPIC_SMALL_FAST_MODEL: smallModel,
    }

    writeFileSync(CLAUDE_SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  } catch {}
}

/**
 * 停止网关时同步恢复 ~/.claude/settings.json 的原始 env 配置，避免 Code 标签页继续指向已关闭的端口
 */
export function restoreOriginalSettings(): boolean {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) return false
  try {
    const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8')) as Record<string, any>

    if (existsSync(ORIGINAL_SETTINGS_ENV_BACKUP)) {
      const saved = JSON.parse(readFileSync(ORIGINAL_SETTINGS_ENV_BACKUP, 'utf8'))
      if (saved.__empty) {
        delete settings.env
      } else {
        settings.env = saved
      }
      writeFileSync(CLAUDE_SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
      rmSync(ORIGINAL_SETTINGS_ENV_BACKUP, { force: true })
      return true
    }

    // 即使没有备份文件，如果 settings.env 指向本机网关，也必须安全清理掉网关链接字段避免断连
    if (settings.env && typeof settings.env === 'object' && isLocalGatewayUrl(settings.env.ANTHROPIC_BASE_URL)) {
      delete settings.env.ANTHROPIC_BASE_URL
      delete settings.env.ANTHROPIC_AUTH_TOKEN
      delete settings.env.ANTHROPIC_MODEL
      delete settings.env.ANTHROPIC_SMALL_FAST_MODEL
      if (Object.keys(settings.env).length === 0) {
        delete settings.env
      }
      writeFileSync(CLAUDE_SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
      return true
    }
  } catch {}
  return false
}

export function logMessage(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(LOG_FILE, line, { flag: 'a' })
  } catch {}
  process.stdout.write(line)
}
