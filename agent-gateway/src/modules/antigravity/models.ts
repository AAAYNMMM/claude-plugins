import type { ModuleModelInfo } from '../../core/types.ts'

export interface AntigravityModelConfig extends ModuleModelInfo {
  upstreamKey: string
}

export const ANTIGRAVITY_MODELS: AntigravityModelConfig[] = [
  {
    id: 'gemini-4-argon',
    name: 'Gemini 4 Argon',
    labelOverride: 'AGY · Gemini 4 Argon',
    description: 'Google 最新 Argon 架构模型',
    upstreamKey: 'gemini-4-argon',
  },
  {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    labelOverride: 'AGY · Gemini 3.8 Flash',
    description: '反重力平台极速推理与上下文模型',
    upstreamKey: 'gemini-3.8-flash-medium',
  },
  {
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    labelOverride: 'AGY · Claude Opus 5.5',
    description: '反重力平台托管的 Claude Opus 5.5 超强推理模型',
    upstreamKey: 'claude-opus-5-5-medium',
  },
  {
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    labelOverride: 'AGY · Claude Sonnet 5.5',
    description: '反重力平台托管的 Claude Sonnet 5.5 主力旗舰模型',
    upstreamKey: 'claude-sonnet-5-5-medium',
  },
  {
    id: 'gpt-oss-120b',
    name: 'GPT-OSS 120B',
    labelOverride: 'AGY · GPT-OSS 120B',
    description: '反重力平台开源权重 120B 大参数模型',
    upstreamKey: 'gpt-oss-120b-medium',
  },
]

export function resolveUpstreamModel(modelId: string): string {
  const hit = ANTIGRAVITY_MODELS.find(
    (m) => m.id === modelId || m.name === modelId || m.upstreamKey === modelId
  )
  if (hit) return hit.upstreamKey
  // 如果以 -medium 结尾或本身就是完整 key
  if (modelId.includes('medium') || modelId.includes('flash') || modelId.includes('sonnet') || modelId.includes('opus')) {
    return modelId
  }
  return 'gemini-3.8-flash-medium'
}
