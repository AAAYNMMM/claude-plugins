/**
 * 网关配置中心与 Claude Desktop / CLI 用户配置联动管理器。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { GatewayConfig, RouteConfig } from './types.ts'

export const DATA_DIR = join(homedir(), '.agent-gateway')
export const CONFIG_FILE = join(DATA_DIR, 'config.json')
export const STATUS_FILE = join(DATA_DIR, 'status.json')
export const LOG_FILE = join(DATA_DIR, 'gateway.log')
export const ORIGINAL_PROVIDER_BACKUP = join(DATA_DIR, 'original-provider.json')
export const ORIGINAL_SETTINGS_ENV_BACKUP = join(DATA_DIR, 'original-settings-env.json')
export const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json')
export const CLAUDE_INSTALLED_PLUGINS_PATH = join(homedir(), '.claude', 'plugins', 'installed_plugins.json')
export const CLAUDE_COMMANDS_DIR = join(homedir(), '.claude', 'commands')
export const CLI_INSTALL_MARKER = join(DATA_DIR, 'cli-installed.json')
const GATEWAY_PLUGIN_PREFIX = 'agent-gateway@'

/** 判断一个 URL 是否指向本机回环网关地址 */
export function isLocalGatewayUrl(url: unknown): boolean {
  return typeof url === 'string' && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(url.trim())
}

function appendGatewayLogOnly(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(LOG_FILE, line, { flag: 'a' })
  } catch {}
}

/** 原子写文件（临时文件 + rename）；失败时清理临时文件、记录日志并抛出异常 */
export function writeFileAtomicSync(targetPath: string, content: string): void {
  const dir = dirname(targetPath)
  mkdirSync(dir, { recursive: true })
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(tmpPath, content, 'utf8')
    renameSync(tmpPath, targetPath)
  } catch (err: any) {
    try {
      rmSync(tmpPath, { force: true })
    } catch {}
    appendGatewayLogOnly(`[Config] 原子写入失败 (${targetPath}): ${err?.message ?? String(err)}`)
    throw err
  }
}

export function createDefaultConfig(): GatewayConfig {
  return {
    port: 43119,
    token: randomBytes(24).toString('hex'),
    authMode: 'loopback',
    defaultModel: 'claude-sonnet-5-5',
    smallModel: 'claude-sonnet-4-6',
    routes: {},
    passthrough: {
      deepseekBaseUrl: 'https://api.deepseek.com/anthropic',
    },
    workbuddy: {
      region: 'auto',
      channelPerturbation: 'failure',
    },
    antigravity: {
      defaultModel: 'gemini-2.5-flash',
    },
    failover: {
      enabled: false,
      crossModuleFailover: false,
    },
  }
}

export const DEFAULT_CONFIG: GatewayConfig = createDefaultConfig()

function mergeLoadedConfig(parsed: Partial<GatewayConfig>): GatewayConfig {
  const base = createDefaultConfig()
  return {
    ...base,
    ...parsed,
    token: typeof parsed.token === 'string' && parsed.token ? parsed.token : base.token,
    routes: parsed.routes && typeof parsed.routes === 'object' ? parsed.routes : {},
    passthrough: { ...base.passthrough, ...(parsed.passthrough ?? {}) },
    workbuddy: { ...base.workbuddy, ...(parsed.workbuddy ?? {}) },
    antigravity: { ...base.antigravity, ...(parsed.antigravity ?? {}) },
    failover: { ...base.failover, ...(parsed.failover ?? {}) },
  }
}

export function loadGatewayConfig(configPath = CONFIG_FILE): GatewayConfig {
  mkdirSync(dirname(configPath), { recursive: true })
  const backupPath = `${configPath}.bak`

  if (!existsSync(configPath)) {
    if (existsSync(backupPath)) {
      try {
        const rawBak = readFileSync(backupPath, 'utf8')
        const parsedBak = JSON.parse(rawBak) as Partial<GatewayConfig>
        if (parsedBak && typeof parsedBak === 'object' && !Array.isArray(parsedBak)) {
          const recovered = mergeLoadedConfig(parsedBak)
          writeFileAtomicSync(configPath, `${JSON.stringify(recovered, null, 2)}\n`)
          appendGatewayLogOnly(`[Config] 主配置缺失，已从备份恢复: ${backupPath}`)
          return recovered
        }
      } catch {}
    }
    const fresh = createDefaultConfig()
    saveGatewayConfig(fresh, configPath)
    return fresh
  }

  try {
    const raw = readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<GatewayConfig>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('配置文件根节点必须是 JSON 对象')
    }
    return mergeLoadedConfig(parsed)
  } catch (primaryErr: any) {
    appendGatewayLogOnly(`[Config] 主配置解析失败 (${configPath}): ${primaryErr?.message ?? String(primaryErr)}`)
    if (existsSync(backupPath)) {
      try {
        const rawBak = readFileSync(backupPath, 'utf8')
        const parsedBak = JSON.parse(rawBak) as Partial<GatewayConfig>
        if (parsedBak && typeof parsedBak === 'object' && !Array.isArray(parsedBak)) {
          try {
            copyFileSync(configPath, `${configPath}.corrupt-${Date.now()}`)
          } catch {}
          const recovered = mergeLoadedConfig(parsedBak)
          writeFileAtomicSync(configPath, `${JSON.stringify(recovered, null, 2)}\n`)
          appendGatewayLogOnly(`[Config] 已从备份恢复主配置 (${backupPath})`)
          return recovered
        }
      } catch (bakErr: any) {
        appendGatewayLogOnly(`[Config] 备份配置恢复失败 (${backupPath}): ${bakErr?.message ?? String(bakErr)}`)
      }
    }
    try {
      copyFileSync(configPath, `${configPath}.corrupt-${Date.now()}`)
    } catch {}
    throw new Error(`配置文件损坏且无可用备份 (${configPath}): ${primaryErr?.message ?? String(primaryErr)}`)
  }
}

export function saveGatewayConfig(config: GatewayConfig, configPath = CONFIG_FILE): void {
  mkdirSync(dirname(configPath), { recursive: true })
  const backupPath = `${configPath}.bak`
  let wrotePrevBackup = false
  if (existsSync(configPath)) {
    try {
      const existingRaw = readFileSync(configPath, 'utf8')
      const parsed = JSON.parse(existingRaw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        writeFileAtomicSync(backupPath, existingRaw)
        wrotePrevBackup = true
      }
    } catch {}
  }
  const serialized = `${JSON.stringify(config, null, 2)}\n`
  writeFileAtomicSync(configPath, serialized)
  if (!wrotePrevBackup && !existsSync(backupPath)) {
    try {
      writeFileAtomicSync(backupPath, serialized)
    } catch {}
  }
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

/** 判断一条模型展示名称是否属于网关自动注入的 AGY / WB / DeepSeek 透传条目 */
export function isGatewayManagedModelLabel(label?: unknown): boolean {
  if (typeof label !== 'string') return false
  return (
    label.startsWith('AGY · ') ||
    label.startsWith('WB · ') ||
    label === 'DeepSeek · Sonnet (透传)' ||
    (label.startsWith('DeepSeek · ') && label.endsWith('(透传)'))
  )
}

/**
 * 从用户当前生效的 Claude 桌面端配置直接读取用户自配模型与原上游地址；
 * 若此前版本曾生成隔离备份 (original-provider.json)，顺带将其用户模型与原上游地址迁回并合并。
 */
export function extractUserProviderConfig(
  activePathOverride?: string | null,
  backupPath = ORIGINAL_PROVIDER_BACKUP
): {
  activePath: string | null
  upstreamBaseUrl?: string
  userModels: ClaudeProviderModelEntry[]
} {
  const activePath = activePathOverride === undefined ? getActiveClaudeProviderPath() : activePathOverride
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
  if (backupPath && existsSync(backupPath)) {
    try {
      collectFrom(JSON.parse(readFileSync(backupPath, 'utf8')))
    } catch {}
  }

  if (!upstreamBaseUrl && userModels.length === 0 && activePathOverride === undefined) {
    const legacy = findLatestLegacyProviderBackup()
    if (legacy) {
      try {
        collectFrom(JSON.parse(readFileSync(legacy, 'utf8')))
      } catch {}
    }
  }

  return { activePath, upstreamBaseUrl, userModels }
}

interface ClaudeProviderBackup {
  hadInferenceProvider?: boolean
  inferenceProvider?: unknown
  hadInferenceGatewayBaseUrl?: boolean
  inferenceGatewayBaseUrl?: unknown
  inferenceModels?: ClaudeProviderModelEntry[]
}

/**
 * 直接更新用户 Claude 桌面端配置：保留用户所有既有凭据与自配模型，把网关映射写入当前活跃配置
 */
export function applyGatewayToClaude(
  routes: Record<string, RouteConfig>,
  port: number,
  activePathOverride?: string | null,
  backupPath = ORIGINAL_PROVIDER_BACKUP
): {
  activePath: string
  modelCount: number
  previousBaseUrl?: string
} {
  const activePath = activePathOverride === undefined ? getActiveClaudeProviderPath() : activePathOverride
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

  // 仅当尚未切换为 gateway（或尚无备份）时备份原始 inferenceProvider / inferenceGatewayBaseUrl / 非托管模型
  const alreadyGateway =
    providerConfig.inferenceProvider === 'gateway' &&
    isLocalGatewayUrl(providerConfig.inferenceGatewayBaseUrl)
  if (!alreadyGateway || !existsSync(backupPath)) {
    const userModels = Array.isArray(providerConfig.inferenceModels)
      ? providerConfig.inferenceModels.filter(
          (m: any) => m && typeof m.name === 'string' && !isGatewayManagedModelLabel(m.labelOverride)
        )
      : []
    const backup: ClaudeProviderBackup = {
      hadInferenceProvider: 'inferenceProvider' in providerConfig,
      inferenceProvider: providerConfig.inferenceProvider,
      hadInferenceGatewayBaseUrl: 'inferenceGatewayBaseUrl' in providerConfig,
      inferenceGatewayBaseUrl: providerConfig.inferenceGatewayBaseUrl,
      inferenceModels: userModels,
    }
    writeFileAtomicSync(backupPath, `${JSON.stringify(backup, null, 2)}\n`)
  }

  // 构建模型映射条目（其中已前置保留用户原本的自配模型）
  const models = Object.entries(routes).map(([alias, r]) => ({
    name: alias,
    labelOverride: r.label ?? alias,
  }))

  providerConfig.inferenceGatewayBaseUrl = `http://127.0.0.1:${port}`
  providerConfig.inferenceModels = models
  providerConfig.inferenceProvider = 'gateway'

  writeFileAtomicSync(activePath, `${JSON.stringify(providerConfig, null, 2)}\n`)

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
 * 关闭网关时直接编辑用户 Claude 桌面端配置：仅移除网关注入的托管条目并恢复原提供方与原上游地址，完整保留用户自配模型
 */
export function restoreOriginalClaudeProvider(
  fallbackBaseUrl?: string,
  activePathOverride?: string | null,
  backupPath = ORIGINAL_PROVIDER_BACKUP
): { activePath: string; restored: boolean } {
  const activePath = activePathOverride === undefined ? getActiveClaudeProviderPath() : activePathOverride
  if (!activePath) {
    throw new Error('未找到 Claude 桌面端配置库。')
  }

  let backup: ClaudeProviderBackup | null = null
  if (existsSync(backupPath)) {
    try {
      const raw = JSON.parse(readFileSync(backupPath, 'utf8'))
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        backup = raw as ClaudeProviderBackup
      }
    } catch {}
  }

  const { upstreamBaseUrl, userModels } = extractUserProviderConfig(activePath, backupPath)
  const providerConfig = JSON.parse(readFileSync(activePath, 'utf8'))

  // 1. 恢复 inferenceProvider（避免残留 'gateway' 导致桌面端失效）
  if (backup && 'hadInferenceProvider' in backup) {
    if (backup.hadInferenceProvider) {
      providerConfig.inferenceProvider = backup.inferenceProvider
    } else {
      delete providerConfig.inferenceProvider
    }
  } else if (providerConfig.inferenceProvider === 'gateway') {
    delete providerConfig.inferenceProvider
  }

  // 2. 恢复 inferenceGatewayBaseUrl：优先按备份原样恢复（无自定义 URL 时删除而非硬编码 DeepSeek）
  const backupBaseUrl =
    typeof backup?.inferenceGatewayBaseUrl === 'string' &&
    backup.inferenceGatewayBaseUrl.trim() &&
    !isLocalGatewayUrl(backup.inferenceGatewayBaseUrl)
      ? backup.inferenceGatewayBaseUrl.trim()
      : undefined

  if (backup && backup.hadInferenceGatewayBaseUrl === false) {
    delete providerConfig.inferenceGatewayBaseUrl
  } else {
    const targetBaseUrl =
      backupBaseUrl ??
      (fallbackBaseUrl && !isLocalGatewayUrl(fallbackBaseUrl) ? fallbackBaseUrl : undefined) ??
      upstreamBaseUrl

    if (targetBaseUrl) {
      providerConfig.inferenceGatewayBaseUrl = targetBaseUrl
    } else if (isLocalGatewayUrl(providerConfig.inferenceGatewayBaseUrl)) {
      delete providerConfig.inferenceGatewayBaseUrl
    }
  }

  // 3. 仅移除网关注入模型，保留用户自配模型
  const backupModels = Array.isArray(backup?.inferenceModels) ? backup.inferenceModels : []
  if (Array.isArray(providerConfig.inferenceModels)) {
    const kept = providerConfig.inferenceModels.filter(
      (m: any) => m && !isGatewayManagedModelLabel(m.labelOverride)
    )
    providerConfig.inferenceModels = kept.length > 0 ? kept : (backupModels.length > 0 ? backupModels : userModels)
  } else if (backupModels.length > 0) {
    providerConfig.inferenceModels = backupModels
  } else if (userModels.length > 0) {
    providerConfig.inferenceModels = userModels
  }

  writeFileAtomicSync(activePath, `${JSON.stringify(providerConfig, null, 2)}\n`)

  if (existsSync(backupPath)) {
    try {
      rmSync(backupPath, { force: true })
    } catch {}
  }

  return { activePath, restored: true }
}

/**
 * 同步更新 ~/.claude/settings.json 的环境变量，实现 CLI 与 Code 标签页与网关联动隔离切换
 */
export function applyGatewayToSettings(
  port: number,
  token: string,
  primaryModel = 'claude-sonnet-5-5',
  smallModel = 'claude-sonnet-4-6',
  settingsPath = CLAUDE_SETTINGS_PATH,
  backupPath = ORIGINAL_SETTINGS_ENV_BACKUP
): void {
  if (!existsSync(settingsPath)) return
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, any>
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error(`无效的 settings.json 格式: ${settingsPath}`)
    }
    const currentEnv = settings.env && typeof settings.env === 'object' ? { ...settings.env } : {}

    // 仅在尚未备份且原本不是指向本地网关时备份原 env（防止覆盖原始配置）
    if (!existsSync(backupPath) && !isLocalGatewayUrl(currentEnv.ANTHROPIC_BASE_URL)) {
      const snapshot = settings.env && typeof settings.env === 'object' ? settings.env : { __empty: true }
      writeFileAtomicSync(backupPath, `${JSON.stringify(snapshot, null, 2)}\n`)
    }

    settings.env = {
      ...currentEnv,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_AUTH_TOKEN: token,
      ANTHROPIC_MODEL: primaryModel,
      ANTHROPIC_SMALL_FAST_MODEL: smallModel,
    }

    writeFileAtomicSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
  } catch (err: any) {
    appendGatewayLogOnly(`[Config] 更新 settings.json 失败 (${settingsPath}): ${err?.message ?? String(err)}`)
    throw err
  }
}

/**
 * 停止网关时同步恢复 ~/.claude/settings.json 的原始 env 配置，避免 Code 标签页继续指向已关闭的端口
 */
export function restoreOriginalSettings(
  gatewayToken?: string,
  previousBaseUrl?: string,
  settingsPath = CLAUDE_SETTINGS_PATH,
  backupPath = ORIGINAL_SETTINGS_ENV_BACKUP
): boolean {
  if (!existsSync(settingsPath)) return false
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, any>
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error(`无效的 settings.json 格式: ${settingsPath}`)
    }

    if (existsSync(backupPath)) {
      const saved = JSON.parse(readFileSync(backupPath, 'utf8'))
      if (saved && saved.__empty) {
        delete settings.env
      } else {
        settings.env = saved
      }
      writeFileAtomicSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
      rmSync(backupPath, { force: true })
      return true
    }

    if (settings.env && typeof settings.env === 'object' && isLocalGatewayUrl(settings.env.ANTHROPIC_BASE_URL)) {
      if (previousBaseUrl && !isLocalGatewayUrl(previousBaseUrl)) {
        settings.env.ANTHROPIC_BASE_URL = previousBaseUrl
      } else {
        delete settings.env.ANTHROPIC_BASE_URL
      }
      if (!gatewayToken || settings.env.ANTHROPIC_AUTH_TOKEN === gatewayToken) {
        delete settings.env.ANTHROPIC_AUTH_TOKEN
      }
      delete settings.env.ANTHROPIC_MODEL
      delete settings.env.ANTHROPIC_SMALL_FAST_MODEL
      if (Object.keys(settings.env).length === 0) {
        delete settings.env
      }
      writeFileAtomicSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
      return true
    }
    return false
  } catch (err: any) {
    appendGatewayLogOnly(`[Config] 还原 settings.json 失败 (${settingsPath}): ${err?.message ?? String(err)}`)
    throw err
  }
}

export function logMessage(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(LOG_FILE, line, { flag: 'a' })
  } catch {}
  process.stdout.write(line)
}

export interface GatewayPluginState {
  keys: string[]
  registered: boolean
  enabled: boolean
  disabled: boolean
  indeterminate?: boolean
  readError?: string
}

function inspectGatewayPluginFiles(
  settingsPath = CLAUDE_SETTINGS_PATH,
  installedPluginsPath = CLAUDE_INSTALLED_PLUGINS_PATH
): {
  keys: string[]
  enabled: boolean
  explicitlyDisabled: boolean
  readErrors: string[]
} {
  const keys = new Set<string>()
  const readErrors: string[] = []
  let enabled = false
  let explicitlyDisabled = false

  if (existsSync(installedPluginsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(installedPluginsPath, 'utf8')) as {
        plugins?: Record<string, unknown>
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        readErrors.push(`installed_plugins.json 格式异常`)
      } else if (parsed.plugins && typeof parsed.plugins === 'object') {
        for (const k of Object.keys(parsed.plugins)) {
          if (k.startsWith(GATEWAY_PLUGIN_PREFIX)) keys.add(k)
        }
      }
    } catch (err: any) {
      readErrors.push(`installed_plugins.json 读取失败: ${err?.message ?? String(err)}`)
    }
  }

  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        enabledPlugins?: Record<string, unknown>
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        readErrors.push(`settings.json 格式异常`)
      } else if (parsed.enabledPlugins && typeof parsed.enabledPlugins === 'object') {
        const ep = parsed.enabledPlugins
        for (const k of Object.keys(ep)) {
          if (!k.startsWith(GATEWAY_PLUGIN_PREFIX)) continue
          keys.add(k)
          if (ep[k] === true) enabled = true
          if (ep[k] === false) explicitlyDisabled = true
        }
      }
    } catch (err: any) {
      readErrors.push(`settings.json 读取失败: ${err?.message ?? String(err)}`)
    }
  }

  return {
    keys: Array.from(keys),
    enabled,
    explicitlyDisabled,
    readErrors,
  }
}

/** 查询 ~/.claude/settings.json 与 installed_plugins.json 中已登记的 agent-gateway 插件键 */
export function findGatewayPluginKeys(
  settingsPath = CLAUDE_SETTINGS_PATH,
  installedPluginsPath = CLAUDE_INSTALLED_PLUGINS_PATH
): string[] {
  return inspectGatewayPluginFiles(settingsPath, installedPluginsPath).keys
}

/** 读取 Claude 桌面端 / CLI 中 agent-gateway 插件的启用或禁用状态 */
export function getGatewayPluginState(
  wasRegistered = false,
  settingsPath = CLAUDE_SETTINGS_PATH,
  installedPluginsPath = CLAUDE_INSTALLED_PLUGINS_PATH
): GatewayPluginState {
  const { keys, enabled, explicitlyDisabled, readErrors } = inspectGatewayPluginFiles(
    settingsPath,
    installedPluginsPath
  )
  const registered = keys.length > 0
  const indeterminate = readErrors.length > 0

  // IO/JSON 瞬态失败时严禁将插件误判为已卸载
  const uninstalledAfterStart = wasRegistered && !registered && !indeterminate
  const disabled = explicitlyDisabled || uninstalledAfterStart

  return {
    keys,
    registered,
    enabled,
    disabled,
    ...(indeterminate ? { indeterminate: true, readError: readErrors.join('; ') } : {}),
  }
}

/** 同步设置 ~/.claude/settings.json 中的插件启用状态（与开关网关联动） */
export function setGatewayPluginEnabled(
  enabled: boolean,
  settingsPath = CLAUDE_SETTINGS_PATH,
  installedPluginsPath = CLAUDE_INSTALLED_PLUGINS_PATH
): boolean {
  if (!existsSync(settingsPath)) return false
  const inspected = inspectGatewayPluginFiles(settingsPath, installedPluginsPath)
  const keys = inspected.keys
  if (keys.length === 0) return false

  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, any>
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error(`无效的 settings.json 格式: ${settingsPath}`)
    }
    const ep =
      settings.enabledPlugins && typeof settings.enabledPlugins === 'object'
        ? { ...settings.enabledPlugins }
        : {}
    let changed = false
    for (const key of keys) {
      if (ep[key] !== enabled) {
        ep[key] = enabled
        changed = true
      }
    }
    if (!changed) return false
    settings.enabledPlugins = ep
    writeFileAtomicSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
    return true
  } catch (err: any) {
    appendGatewayLogOnly(`[Config] 设置插件状态失败 (${settingsPath}): ${err?.message ?? String(err)}`)
    throw err
  }
}

/** 清理早期版本残留在 ~/.claude/commands 下的旧版 skill 文件 */
export function cleanupLegacyClaudeCommands(commandsDir = CLAUDE_COMMANDS_DIR): string[] {
  const removed: string[] = []
  for (const name of ['workbuddy-models.md', 'workbuddy-status.md']) {
    const target = join(commandsDir, name)
    if (existsSync(target)) {
      try {
        rmSync(target, { force: true })
        removed.push(target)
      } catch {}
    }
  }
  return removed
}
