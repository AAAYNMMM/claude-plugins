import type { ModuleModelInfo } from '../../core/types.ts'

export interface AntigravityModelConfig extends ModuleModelInfo {
  upstreamKey: string
}

/**
 * 当前反重力平台实际可用模型清单（严格对齐 Antigravity 官方客户端当前状态）
 * 1. Gemini 3.8 Flash (High) - 极速主力模型，大上下文与高思考推理
 * 2. Claude Sonnet 4.6 (Thinking) - 深度思考主力模型（上游无缝对接最新 5.5-high 引擎）
 * 3. Claude Opus 4.6 (Thinking) - 顶级思考推理模型（上游无缝对接最新 5.5-high 引擎）
 * 4. GPT-OSS 120B (Medium) - 开源权重 120B 大参数模型
 * 注：Gemini 4 Argon 与 Gemini 4 Carbon 当前处于 Unavailable / 404 状态，坚决不列入合规可用路由。
 */
export const ANTIGRAVITY_MODELS: AntigravityModelConfig[] = [
  {
    id: 'gemini-3.8-flash-high',
    name: 'Gemini 3.8 Flash High',
    labelOverride: 'AGY · Gemini 3.8 Flash (High)',
    description: '反重力平台极速推理与大上下文模型 (High)',
    upstreamKey: 'gemini-3.8-flash-high',
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6 (Thinking)',
    labelOverride: 'AGY · Claude Sonnet 4.6 (Thinking)',
    description: '反重力托管 Claude Sonnet 4.6 深度思考旗舰模型',
    upstreamKey: 'claude-sonnet-5-5-high',
  },
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6 (Thinking)',
    labelOverride: 'AGY · Claude Opus 4.6 (Thinking)',
    description: '反重力托管 Claude Opus 4.6 顶级深度思考模型',
    upstreamKey: 'claude-opus-5-5-high',
  },
  {
    id: 'gpt-oss-120b',
    name: 'GPT-OSS 120B (Medium)',
    labelOverride: 'AGY · GPT-OSS 120B (Medium)',
    description: '反重力开源权重 120B 参数大模型 (Medium)',
    upstreamKey: 'gpt-oss-120b-medium',
  },
]

/**
 * 将任意请求中的模型标识（别名、历史名称、模糊匹配）精准解析为上游 API 实际接受并正常返回的真实 Key
 */
export function resolveUpstreamModel(modelId: string): string {
  const norm = modelId.toLowerCase().trim()

  // 1. 精确匹配预设列表
  const hit = ANTIGRAVITY_MODELS.find(
    (m) =>
      m.id.toLowerCase() === norm ||
      m.name.toLowerCase() === norm ||
      m.upstreamKey.toLowerCase() === norm ||
      m.labelOverride.toLowerCase() === norm
  )
  if (hit) return hit.upstreamKey

  // 2. 语义别名与模糊匹配兜底
  if (norm.includes('opus')) {
    return 'claude-opus-5-5-high'
  }
  if (norm.includes('sonnet')) {
    return 'claude-sonnet-5-5-high'
  }
  if (norm.includes('120b') || norm.includes('gpt-oss')) {
    return 'gpt-oss-120b-medium'
  }
  if (norm.includes('argon')) {
    return 'gemini-4-argon-high'
  }
  if (norm.includes('flash') || norm.includes('gemini')) {
    return 'gemini-3.8-flash-high'
  }

  return 'gemini-3.8-flash-high'
}
