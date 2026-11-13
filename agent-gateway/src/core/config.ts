/**
 * 网关配置中心与 Claude Desktop / CLI 用户配置联动管理器。
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

export interface ClaudeProviderModelEntry {
  name: string
  labelOverride?: string
}

/** 判断一条模型展示名称是否属于网关自动注入的 AGY / WB 条目 */
export function isGatewayManagedModelLabel(label?: unknown): boolean {
  return typeof label === 'string' && (label.startsWith('AGY · ') || label.startsWith('WB · '))
}

/**
 * 从用户当前生效的 Claude 桌面端配置直接读取用户自配模型与原上游地址；
 * 若此前版本曾生成隔离备份 (original-provider.json)，顺带将其用户模型与原上游地址迁回并合并。
 */
export function extractUserProviderConfig(): {
  activePath: string | null
  upstreamBaseUrl?: string
  userModels: ClaudeProviderModelEntry[]
} {
  const activePath = getActiveClaudeProviderPath()
  const userModels: ClaudeProviderModelEntry[] = []
  const seen = new Set<string>()
  let upstreamBaseUrl: string | undefined

  const collectFrom = (raw: any) => {
    if (!raw || typeof raw !== 'object') return
    if (!upstreamBaseUrl && typeof raw.inferenceGatewayBaseUrl === 'string' && raw.inferenceGatewayBaseUrl.trim() && !isLocalGatewayUrl(raw.inferenceGatewayBaseUrl)) {
      upstreamBaseUrl = raw.inferenceGatewayBaseUrl.trim()
    }
    if (Array.isArray(raw.inferenceModels)) {
      for (const item of raw.inferenceModels) {
        if (!item || typeof item.name !== 'string' || !item.name.trim()) continue
        if (isGatewayManagedModelLabel(item.labelOverride)) continue
        const name = item.name.trim()
        if (seen.has(name)) continue
        seen.add(name)
        userModels.push({
          name,
          ...(typeof item.labelOverride === 'string' && item.labelOverride.trim()
            ? { labelOverride: item.labelOverride.trim() }
            : {}),
        })
      }
    }
  }

  if (activePath && existsSync(activePath)) {
    try {
      collectFrom(JSON.parse(readFileSync(activePath, 'utf8')))
    } catch {}
  }

  // 兼容迁移：若早期版本隔离出了 original-provider.json，把里面的用户原始模型和地址迁回用户配置
  if (existsSync(ORIGINAL_PROVIDER_BACKUP)) {
    try {
      collectFrom(JSON.parse(readFileSync(ORIGINAL_PROVIDER_BACKUP, 'utf8')))
    } catch {}
  }

  if (!upstreamBaseUrl && userModels.length === 0) {
    const legacy = findLatestLegacyProviderBackup()
    if (legacy) {
      try {
        collectFrom(JSON.parse(readFileSync(legacy, 'utf8')))
      } catch {}
    }
  }

  return { activePath, upstreamBaseUrl, userModels }
}

/**
 * 直接更新用户 Claude 桌面端配置：保留用户所有既有凭据与自配模型，把网关映射写入当前活跃配置
 */
export function applyGatewayToClaude(routes: Record<string, RouteConfig>, port: number): {
  activePath: string
  modelCount: number
  previousBaseUrl?: string
} {
  const activePath = getActiveClaudeProviderPath()
  if (!activePath) {
    throw new Error('未找到 Claude 桌面端的配置库 (_meta.json)，请确保已安装并启动过 Claude 桌面端。')
  }

  const providerConfig = JSON.parse(readFileSync(activePath, 'utf8'))
  const previousBaseUrl =
    typeof providerConfig.inferenceGatewayBaseUrl === 'string' &&
    providerConfig.inferenceGatewayBaseUrl.trim() &&
    !isLocalGatewayUrl(providerConfig.inferenceGatewayBaseUrl)
      ? providerConfig.inferenceGatewayBaseUrl.trim()
      : undefined

  // 构建模型映射条目（其中已前置保留用户原本的自配模型）
  const models = Object.entries(routes).map(([alias, r]) => ({
    name: alias,
    labelOverride: r.label ?? alias,
  }))

  providerConfig.inferenceGatewayBaseUrl = `http://127.0.0.1:${port}`
  providerConfig.inferenceModels = models
  providerConfig.inferenceProvider = 'gateway'

  writeFileSync(activePath, `${JSON.stringify(providerConfig, null, 2)}\n`, 'utf8')

  // 用户配置已直接包含原模型与上游，不再保留旧隔离备份文件
  if (existsSync(ORIGINAL_PROVIDER_BACKUP)) {
    rmSync(ORIGINAL_PROVIDER_BACKUP, { force: true })
  }

  return { activePath, modelCount: models.length, previousBaseUrl }
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
 * 关闭网关时直接编辑用户 Claude 桌面端配置：仅移除网关注入的 AGY / WB 条目并恢复原上游地址，完整保留用户自配模型
 */
export function restoreOriginalClaudeProvider(fallbackBaseUrl?: string): { activePath: string; restored: boolean } {
  const activePath = getActiveClaudeProviderPath()
  if (!activePath) {
    throw new Error('未找到 Claude 桌面端配置库。')
  }

  const { upstreamBaseUrl, userModels } = extractUserProviderConfig()
  const providerConfig = JSON.parse(readFileSync(activePath, 'utf8'))

  const targetBaseUrl =
    (fallbackBaseUrl && !isLocalGatewayUrl(fallbackBaseUrl) ? fallbackBaseUrl : undefined) ??
    upstreamBaseUrl ??
    'https://api.deepseek.com/anthropic'

  providerConfig.inferenceGatewayBaseUrl = targetBaseUrl

  if (Array.isArray(providerConfig.inferenceModels)) {
    const kept = providerConfig.inferenceModels.filter(
      (m: any) => m && !isGatewayManagedModelLabel(m.labelOverride)
    )
    providerConfig.inferenceModels = kept.length > 0 ? kept : userModels
  } else if (userModels.length > 0) {
    providerConfig.inferenceModels = userModels
  }

  writeFileSync(activePath, `${JSON.stringify(providerConfig, null, 2)}\n`, 'utf8')

  if (existsSync(ORIGINAL_PROVIDER_BACKUP)) {
    rmSync(ORIGINAL_PROVIDER_BACKUP, { force: true })
  }

  return { activePath, restored: true }
}

/**
 * 同步更新 ~/.claude/settings.json 的环境变量：只设置网关连接地址与缺省令牌，不覆盖用户的模型设置，不搞隔离备份
 */
export function applyGatewayToSettings(
  port: number,
  token: string,
  config?: GatewayConfig
): void {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) return
  try {
    const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8')) as Record<string, any>
    const currentEnv = (settings.env && typeof settings.env === 'object') ? { ...settings.env } : {}

    // 若早期版本生成过隔离备份 original-settings-env.json，清理当时强行写入的模型覆盖键，仅保留用户原本自配项
    if (existsSync(ORIGINAL_SETTINGS_ENV_BACKUP)) {
      try {
        const orig = JSON.parse(readFileSync(ORIGINAL_SETTINGS_ENV_BACKUP, 'utf8')) as Record<string, any>
        if (!('ANTHROPIC_MODEL' in orig) && currentEnv.ANTHROPIC_MODEL) {
          delete currentEnv.ANTHROPIC_MODEL
        }
        if (!('ANTHROPIC_SMALL_FAST_MODEL' in orig) && currentEnv.ANTHROPIC_SMALL_FAST_MODEL) {
          delete currentEnv.ANTHROPIC_SMALL_FAST_MODEL
        }
      } catch {}
      rmSync(ORIGINAL_SETTINGS_ENV_BACKUP, { force: true })
    }

    if (
      config &&
      typeof currentEnv.ANTHROPIC_BASE_URL === 'string' &&
      currentEnv.ANTHROPIC_BASE_URL.trim() &&
      !isLocalGatewayUrl(currentEnv.ANTHROPIC_BASE_URL)
    ) {
      config.passthrough = {
        ...config.passthrough,
        settingsBaseUrl: currentEnv.ANTHROPIC_BASE_URL.trim(),
      }
      saveGatewayConfig(config)
    }

    settings.env = {
      ...currentEnv,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_AUTH_TOKEN: currentEnv.ANTHROPIC_AUTH_TOKEN || token,
    }

    writeFileSync(CLAUDE_SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  } catch {}
}

/**
 * 停止网关时直接还原 ~/.claude/settings.json 中的本地网关连接字段，保留用户自己的全部配置
 */
export function restoreOriginalSettings(gatewayToken?: string, previousBaseUrl?: string): boolean {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) return false
  try {
    const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8')) as Record<string, any>
    let changed = false

    if (existsSync(ORIGINAL_SETTINGS_ENV_BACKUP)) {
      try {
        const orig = JSON.parse(readFileSync(ORIGINAL_SETTINGS_ENV_BACKUP, 'utf8')) as Record<string, any>
        if (settings.env && typeof settings.env === 'object') {
          if (!('ANTHROPIC_MODEL' in orig) && 'ANTHROPIC_MODEL' in settings.env) {
            delete settings.env.ANTHROPIC_MODEL
            changed = true
          }
          if (!('ANTHROPIC_SMALL_FAST_MODEL' in orig) && 'ANTHROPIC_SMALL_FAST_MODEL' in settings.env) {
            delete settings.env.ANTHROPIC_SMALL_FAST_MODEL
            changed = true
          }
        }
      } catch {}
      rmSync(ORIGINAL_SETTINGS_ENV_BACKUP, { force: true })
    }

    if (settings.env && typeof settings.env === 'object' && isLocalGatewayUrl(settings.env.ANTHROPIC_BASE_URL)) {
      if (previousBaseUrl && !isLocalGatewayUrl(previousBaseUrl)) {
        settings.env.ANTHROPIC_BASE_URL = previousBaseUrl
      } else {
        delete settings.env.ANTHROPIC_BASE_URL
      }
      if (gatewayToken && settings.env.ANTHROPIC_AUTH_TOKEN === gatewayToken) {
        delete settings.env.ANTHROPIC_AUTH_TOKEN
      }
      if (Object.keys(settings.env).length === 0) {
        delete settings.env
      }
      changed = true
    }

    if (changed) {
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
