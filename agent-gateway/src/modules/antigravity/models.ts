import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ModuleModelInfo } from '../../core/types.ts'

export interface AntigravityModelConfig extends ModuleModelInfo {
  upstreamKey: string
  recommendedAlias?: string
  supportsThinking?: boolean
  supportsImages?: boolean
  tagTitle?: string
  maxOutputTokens?: number
}

export const ANTIGRAVITY_API_HOST = 'https://daily-cloudcode-pa.googleapis.com'
const DEFAULT_PROJECT_ID = 'aicode-consumers'
const DEFAULT_IDE_VERSION = '2.31.2'
const CACHE_TTL_MS = 60_000

const EFFORT_LABEL_RE = /^(.*?)\s*\((low|medium|high|xhigh|max)(?:\s+thinking)?\)\s*$/i

interface RawAvailableModel {
  displayName?: string
  model?: string
  disabled?: boolean
  recommended?: boolean
  isInternal?: boolean
  tagTitle?: string
  supportsImages?: boolean
  supportsThinking?: boolean
  maxTokens?: number
  maxOutputTokens?: number
}

interface RawAvailableModelsResponse {
  models?: Record<string, RawAvailableModel>
  defaultAgentModelId?: string
  agentModelSorts?: Array<{
    displayName?: string
    groups?: Array<{
      modelIds?: string[]
    }>
  }>
}

/**
 * 最后兜底静态列表：仅在完全离线且本地 Language Server 未运行时使用。
 */
export const FALLBACK_ANTIGRAVITY_MODELS: AntigravityModelConfig[] = [
  {
    id: 'gemini-3.8-flash-high',
    upstreamKey: 'gemini-3.8-flash-high',
    name: 'Gemini 3.8 Flash',
    recommendedAlias: 'claude-haiku-5-5',
    labelOverride: 'AGY · Gemini 3.8 Flash',
    description: '日常任务快速响应',
  },
  {
    id: 'claude-opus-5-5-medium',
    upstreamKey: 'claude-opus-5-5-medium',
    name: 'Claude Opus 5.5',
    recommendedAlias: 'claude-opus-5-5',
    labelOverride: 'AGY · Claude Opus 5.5',
    description: '高难度复杂任务主力',
  },
  {
    id: 'claude-sonnet-5-5-medium',
    upstreamKey: 'claude-sonnet-5-5-medium',
    name: 'Claude Sonnet 5.5',
    recommendedAlias: 'claude-sonnet-5-5',
    labelOverride: 'AGY · Claude Sonnet 5.5',
    description: '均衡高效全能模型',
  },
]

let cachedModels: AntigravityModelConfig[] | null = null
let cachedAt = 0
let cachedProjectId: string | null = null
const dynamicUpstreamMap = new Map<string, string>()
const dynamicMaxOutputMap = new Map<string, number>()

/**
 * 读取本地 Antigravity IDE 版本（优先 daemon hub 文件，其次安装包 package.json）。
 */
export function getAntigravityVersion(): string {
  try {
    const daemonDir = join(homedir(), '.gemini', 'antigravity', 'daemon')
    if (existsSync(daemonDir)) {
      const files = readdirSync(daemonDir).filter(f => f.startsWith('hub_') && f.endsWith('.json'))
      for (const file of files) {
        const hub = JSON.parse(readFileSync(join(daemonDir, file), 'utf8'))
        if (typeof hub.lsVersion === 'string' && hub.lsVersion.trim()) {
          return hub.lsVersion.trim()
        }
      }
    }
  } catch {}

  try {
    const pkgPath = process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', 'antigravity', 'resources', 'app', 'package.json')
      : process.platform === 'darwin'
        ? '/Applications/Antigravity.app/Contents/Resources/app/package.json'
        : '/usr/share/antigravity/resources/app/package.json'
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      if (typeof pkg.version === 'string' && pkg.version.trim()) {
        return pkg.version.trim()
      }
    }
  } catch {}

  return DEFAULT_IDE_VERSION
}

/**
 * 构造与 Antigravity Language Server 一致的 User-Agent，用于解锁账户/订阅对应的完整模型目录。
 */
export function getAntigravityUserAgent(): string {
  const version = getAntigravityVersion()
  const osType = process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin'
      ? 'darwin'
      : 'linux'
  const arch = process.arch === 'x64' ? 'amd64' : process.arch
  return `antigravity/hub/${version} (os_type=${osType}; arch=${arch})`
}

function getClientPlatform(): string {
  if (process.platform === 'win32') return 'WINDOWS_AMD64'
  if (process.platform === 'darwin') return 'MACOS'
  return 'LINUX'
}

/**
 * 通过 Cloud Code `loadCodeAssist` 动态获取当前账号的 Project ID 与订阅等级。
 */
export async function fetchLiveProjectAndTier(
  accessToken: string,
  forceRefresh = false
): Promise<{ projectId: string; tierName?: string }> {
  if (cachedProjectId && !forceRefresh) {
    return { projectId: cachedProjectId }
  }

  try {
    const version = getAntigravityVersion()
    const res = await fetch(`${ANTIGRAVITY_API_HOST}/v1internal:loadCodeAssist`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': getAntigravityUserAgent(),
      },
      body: JSON.stringify({
        metadata: {
          ideType: 'ANTIGRAVITY',
          platform: getClientPlatform(),
          pluginType: 'GEMINI',
          ideName: 'antigravity',
          ideVersion: version,
        },
      }),
      signal: AbortSignal.timeout(4000),
    })

    if (res.ok) {
      const data = (await res.json()) as any
      const projectId =
        typeof data?.cloudaicompanionProject === 'string' && data.cloudaicompanionProject.trim()
          ? data.cloudaicompanionProject.trim()
          : DEFAULT_PROJECT_ID
      cachedProjectId = projectId
      const tierName = data?.paidTier?.name || data?.currentTier?.name || undefined
      return { projectId, tierName }
    }
  } catch {}

  return { projectId: cachedProjectId || DEFAULT_PROJECT_ID }
}

function inferModelDescription(id: string, name: string, isDefault: boolean, idx: number): string {
  if (isDefault || idx === 0) return '默认首选主力模型'
  const lower = `${id} ${name}`.toLowerCase()
  if (lower.includes('flash') || lower.includes('lite')) return '轻量高速，适合日常高频任务'
  if (lower.includes('opus') || lower.includes('hydrogen')) return '旗舰深度推理与高难度编码'
  if (lower.includes('sonnet')) return '均衡全能，编程与分析兼备'
  if (lower.includes('gpt-oss')) return '开源推理辅助模型'
  return 'Antigravity 动态可用模型'
}

function parseAvailableModelsResponse(data: RawAvailableModelsResponse): AntigravityModelConfig[] {
  const modelsMap = data.models || {}
  dynamicUpstreamMap.clear()
  dynamicMaxOutputMap.clear()

  // 记录全部启用模型的原始 key 映射，保证指定档位 ID 时也能直接透传
  for (const [id, info] of Object.entries(modelsMap)) {
    if (!info || info.disabled || info.tagTitle === 'Unavailable' || info.isInternal) continue
    dynamicUpstreamMap.set(id, id)
    dynamicUpstreamMap.set(id.toLowerCase(), id)
    if (typeof info.maxOutputTokens === 'number' && info.maxOutputTokens > 0) {
      dynamicMaxOutputMap.set(id, info.maxOutputTokens)
    }
  }

  // 按 agentModelSorts 顺序提取展示模型；若缺失则回退 recommended 模型列表
  const orderedIds: string[] = []
  const seenIds = new Set<string>()
  for (const sort of data.agentModelSorts || []) {
    for (const group of sort.groups || []) {
      for (const id of group.modelIds || []) {
        if (!seenIds.has(id)) {
          seenIds.add(id)
          orderedIds.push(id)
        }
      }
    }
  }

  if (orderedIds.length === 0) {
    for (const [id, info] of Object.entries(modelsMap)) {
      if (info && !info.isInternal && !info.disabled && info.recommended && !seenIds.has(id)) {
        seenIds.add(id)
        orderedIds.push(id)
      }
    }
  }

  // 过滤禁用/不可用及仅本地编排占位模型，并按基础模型族分组折叠多档位
  interface CandidateVariant {
    id: string
    rawName: string
    effort?: string
    info: RawAvailableModel
  }
  interface ModelGroup {
    baseName: string
    variants: CandidateVariant[]
  }

  const groups: ModelGroup[] = []
  const groupByKey = new Map<string, ModelGroup>()

  for (const id of orderedIds) {
    const info = modelsMap[id]
    if (!info || info.disabled === true || info.tagTitle === 'Unavailable' || info.isInternal === true) {
      continue
    }
    // 跳过 IDE 本地多 Agent 编排模式（v1internal 非单模型实体）
    if (id.includes('orchestrator')) {
      continue
    }

    const rawName = (info.displayName || id).trim()
    const match = rawName.match(EFFORT_LABEL_RE)
    const baseName = match ? match[1].trim() : rawName
    const effort = match ? match[2].toLowerCase() : undefined
    const groupKey = baseName.toLowerCase()

    let group = groupByKey.get(groupKey)
    if (!group) {
      group = { baseName, variants: [] }
      groupByKey.set(groupKey, group)
      groups.push(group)
    }
    group.variants.push({ id, rawName, effort, info })
  }

  const result: AntigravityModelConfig[] = []
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]
    // 与 Antigravity 前端一致：多档位优先选 medium，否则选排序第一位
    const chosen =
      group.variants.length > 1
        ? group.variants.find(v => v.effort === 'medium') || group.variants[0]
        : group.variants[0]

    const displayName = group.variants.length > 1 ? group.baseName : chosen.rawName
    const isDefault = chosen.id === data.defaultAgentModelId

    result.push({
      id: chosen.id,
      upstreamKey: chosen.id,
      name: displayName,
      labelOverride: `AGY · ${displayName}`,
      description: inferModelDescription(chosen.id, displayName, isDefault, i),
      supportsThinking: chosen.info.supportsThinking,
      supportsImages: chosen.info.supportsImages,
      tagTitle: chosen.info.tagTitle,
      maxOutputTokens: chosen.info.maxOutputTokens,
    })

    // 同时注册显示名和基础族 ID 到动态映射表
    dynamicUpstreamMap.set(chosen.id, chosen.id)
    dynamicUpstreamMap.set(displayName.toLowerCase(), chosen.id)
    const slug = group.baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    if (slug && !dynamicUpstreamMap.has(slug)) {
      dynamicUpstreamMap.set(slug, chosen.id)
    }
  }

  return result
}

async function fetchFromCloud(accessToken: string): Promise<RawAvailableModelsResponse | null> {
  const res = await fetch(`${ANTIGRAVITY_API_HOST}/v1internal:fetchAvailableModels`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': getAntigravityUserAgent(),
    },
    body: '{}',
    signal: AbortSignal.timeout(6000),
  })
  if (!res.ok) return null
  return (await res.json()) as RawAvailableModelsResponse
}

async function fetchFromLocalLanguageServer(): Promise<RawAvailableModelsResponse | null> {
  try {
    const daemonDir = join(homedir(), '.gemini', 'antigravity', 'daemon')
    if (!existsSync(daemonDir)) return null
    const files = readdirSync(daemonDir).filter(f => f.startsWith('hub_') && f.endsWith('.json'))
    for (const file of files) {
      const hub = JSON.parse(readFileSync(join(daemonDir, file), 'utf8'))
      if (!hub.httpPort || !hub.csrfToken) continue
      const res = await fetch(
        `http://127.0.0.1:${hub.httpPort}/exa.language_server_pb.LanguageServerService/GetAvailableModels`,
        {
          method: 'POST',
          headers: {
            'x-codeium-csrf-token': hub.csrfToken,
            'Content-Type': 'application/json',
          },
          body: '{}',
          signal: AbortSignal.timeout(2500),
        }
      )
      if (!res.ok) continue
      const data = (await res.json()) as { response?: RawAvailableModelsResponse }
      if (data.response?.models) return data.response
    }
  } catch {}
  return null
}

/**
 * 动态获取当前 Antigravity 账号的实际可用模型列表：
 * 1) 优先直连 Google Cloud Code `fetchAvailableModels`（无论 Antigravity 是否运行均可实时拉取订阅变更后的模型）；
 * 2) 若离线或无直连令牌，尝试本地 Antigravity Language Server `GetAvailableModels`；
 * 3) 完全离线时退回兜底列表。
 */
export async function getDynamicAntigravityModels(
  accessToken: string | null,
  options: { forceRefresh?: boolean } = {}
): Promise<AntigravityModelConfig[]> {
  if (!options.forceRefresh && cachedModels && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedModels
  }

  let raw: RawAvailableModelsResponse | null = null
  if (accessToken) {
    try {
      raw = await fetchFromCloud(accessToken)
    } catch {}
  }

  if (!raw) {
    raw = await fetchFromLocalLanguageServer()
  }

  if (raw) {
    const parsed = parseAvailableModelsResponse(raw)
    if (parsed.length > 0) {
      cachedModels = parsed
      cachedAt = Date.now()
      return parsed
    }
  }

  if (cachedModels && cachedModels.length > 0) {
    return cachedModels
  }

  for (const m of FALLBACK_ANTIGRAVITY_MODELS) {
    dynamicUpstreamMap.set(m.id, m.upstreamKey)
  }
  return FALLBACK_ANTIGRAVITY_MODELS
}

/**
 * 将请求中的模型别名或 ID 解析为上游 `v1internal` 真实模型 ID。
 */
export function resolveUpstreamModel(modelId: string): string {
  const clean = modelId.trim()
  if (!clean) {
    return cachedModels?.[0]?.upstreamKey || FALLBACK_ANTIGRAVITY_MODELS[0].upstreamKey
  }

  const exact = dynamicUpstreamMap.get(clean) || dynamicUpstreamMap.get(clean.toLowerCase())
  if (exact) return exact

  // 兼容旧静态别名模糊匹配当前动态模型（如旧 claude-opus-4-6-thinking -> 当前 opus 模型）
  const active = cachedModels || FALLBACK_ANTIGRAVITY_MODELS
  const lower = clean.toLowerCase()
  for (const family of ['opus', 'sonnet', 'flash', 'argon', 'hydrogen', 'gpt-oss']) {
    if (lower.includes(family)) {
      const hit = active.find(
        m => m.id.toLowerCase().includes(family) || m.name.toLowerCase().includes(family)
      )
      if (hit) return hit.upstreamKey
    }
  }

  return clean
}

/**
 * 获取指定上游模型声明的最大输出 Token 数（用于抑制超大 maxOutputTokens 导致的 TPM 限流预扣）。
 */
export function getModelMaxOutputTokens(upstreamModelId: string): number | undefined {
  return dynamicMaxOutputMap.get(upstreamModelId)
}
