/**
 * WorkBuddy 代理子模块：接入 WorkBuddy 模型并提供余额/积分附属小模块。
 */

import type { ServerResponse } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  GatewayModule,
  ModuleContext,
  ModuleModelInfo,
  ModuleStatus,
  RequestContext,
  AnthropicRequest,
} from '../../core/types.ts'
import {
  collectAnthropic,
  errorPayload,
  streamAnthropic,
  toOpenAIRequest,
} from '../../core/protocol/anthropic.ts'
import { WorkBuddyCredentialStore } from './vendor/src/auth.ts'
import {
  WorkBuddyCatalog,
  FALLBACK_WORKBUDDY_MODELS,
  FALLBACK_WORKBUDDY_MODELS_GLOBAL,
  type WorkBuddyModelInfo,
} from './vendor/src/catalog.ts'
import { createWorkBuddyShim, type WorkBuddyShim } from './vendor/src/shim.ts'
import { WorkBuddyUpstreamClient } from './vendor/src/upstream.ts'

/**
 * 常用真实 WorkBuddy 模型基准倍率表（涵盖原版桌面端实测倍率及免费标识）
 */
const KNOWN_WB_MODELS: Array<{ id: string; name?: string; rate?: string | number; free?: boolean }> = [
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', rate: '0.51' },
  { id: 'kimi-k3-1', name: 'Kimi K3.1', rate: '1.62' },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek Flash', rate: '0.11' },
  { id: 'glm-5.3', name: 'GLM-5.3', rate: '0.69' },
  { id: 'hy4free', name: 'Hy4 Free', rate: 0, free: true },
  { id: 'hy4std', name: 'Hy4 Standard', rate: '0.29' },
  { id: 'hy3', name: 'Hy3', rate: 0, free: true },
  { id: 'hy3-x', name: 'Hy3-X', rate: '0.05' },
  { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', rate: '0.08' },
  { id: 'glm-5.2', name: 'GLM-5.2', rate: '0.79' },
  { id: 'space-bunny', name: 'Space Bunny', rate: '0.08' },
  { id: 'minimax-m3.1-flash', name: 'MiniMax M3.1 Flash', rate: '0.08' },
  { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', rate: '0.97' },
  { id: 'kimi-k2.8-preview', name: 'Kimi K2.8 Preview', rate: '0.77' },
  { id: 'step-5-preview', name: 'Step 5 Preview', rate: '0.33' },
  { id: 'mimo-v2.6-pro', name: 'Mimo V2.6 Pro', rate: '0.13' },
]

/**
 * 已知型号的静态倍率与免费属性字典（用于快速匹配与 fallback 补齐）
 */
const KNOWN_WB_RATES: Record<string, { rate?: string | number; free?: boolean }> = {
  'hy4free': { rate: 0, free: true },
  'hy3': { rate: 0, free: true },
  'deepseek-v4-flash': { rate: 0, free: true },
  'fast-model': { rate: 0, free: true },
  'hy3-x': { rate: '0.05' },
  'glm-5.3-flash': { rate: '0.08' },
  'space-bunny': { rate: '0.08' },
  'minimax-m3.1-flash': { rate: '0.08' },
  'deepseek-v4.1-flash': { rate: '0.11' },
  'mimo-v2.6-pro': { rate: '0.13' },
  'glm-5.1': { rate: '0.20' },
  'gpt-5.6-luna': { rate: '0.20' },
  'gemini-3.5-flash': { rate: '0.20' },
  'hy4std': { rate: '0.29' },
  'hy4-preview': { rate: '0.29' },
  'step-5-preview': { rate: '0.33' },
  'kimi-k2.6': { rate: '0.39' },
  'balanced-model': { rate: '0.39' },
  'gpt-5.6-terra': { rate: '0.39' },
  'gpt-5.4': { rate: '0.39' },
  'deepseek-v4-pro': { rate: '0.51' },
  'glm-5.3': { rate: '0.69' },
  'glm-5v-turbo': { rate: '0.69' },
  'kimi-k2.7': { rate: '0.69' },
  'gpt-5.6-sol': { rate: '0.69' },
  'gpt-5.5': { rate: '0.69' },
  'gpt-5.3-codex': { rate: '0.69' },
  'kimi-k2.8-preview': { rate: '0.77' },
  'glm-5.2': { rate: '0.79' },
  'kimi-k3.1-pro': { rate: '0.97' },
  'minimax-m3': { rate: '1.00' },
  'kimi-k3-1': { rate: '1.62' },
  'kimi-k3': { rate: '1.00' },
  'primary-model': { rate: '1.00' },
  'deep-model': { rate: '1.00' },
  'gpt-6-astra': { rate: '1.00' },
}

/**
 * 格式化 WorkBuddy 标签，完整保留倍率（如 x0.69, x1.00）和 free 免费标识
 */
function formatWorkBuddyLabel(id: string, rate?: string | number, isFree?: boolean): string {
  let rateStr = ''
  if (typeof rate === 'number') {
    rateStr = `x${Number.isInteger(rate) ? rate.toFixed(2) : rate}`
  } else if (typeof rate === 'string') {
    const raw = rate.trim()
    const n = Number(raw.replace(/^x/, ''))
    if (!isNaN(n)) {
      if (Number.isInteger(n)) {
        rateStr = `x${n.toFixed(2)}`
      } else {
        rateStr = raw.startsWith('x') ? raw : `x${raw}`
      }
    } else {
      rateStr = raw.startsWith('x') ? raw : `x${raw}`
    }
  }

  const freeFlag = isFree || rate === 0 || rateStr === 'x0' || rateStr === 'x0.00' || id.toLowerCase().includes('free')

  let suffix = ''
  if (freeFlag) {
    suffix = ' (free)'
  } else if (rateStr) {
    suffix = ` (${rateStr})`
  }

  return `WB · ${id}${suffix}`
}

export class WorkBuddyModule implements GatewayModule {
  readonly id = 'workbuddy'
  readonly name = 'WorkBuddy'
  readonly description = 'WorkBuddy 桌面端模型桥接与额度池'

  private ctx!: ModuleContext
  private creds!: WorkBuddyCredentialStore
  private catalog!: WorkBuddyCatalog
  private upstream!: WorkBuddyUpstreamClient
  private shimInstance: WorkBuddyShim | null = null

  async init(context: ModuleContext): Promise<void> {
    this.ctx = context
    const region = 'auto'
    this.creds = new WorkBuddyCredentialStore({ region })
    this.catalog = new WorkBuddyCatalog(this.creds)
    this.upstream = new WorkBuddyUpstreamClient(this.creds, {
      channelPerturbation: 'off',
    })

    // 尝试拉取上游实时模型目录
    const cred = await this.creds.current().catch(() => undefined)
    if (cred) {
      try {
        const roster = await this.upstream.fetchModels(cred)
        if (roster && roster.length > 0) {
          this.catalog.replace(roster)
        }
      } catch {}
    }

    // 启动本地回环 OpenAI shim
    this.shimInstance = createWorkBuddyShim({
      store: this.creds,
      client: this.upstream,
      catalog: this.catalog,
      logger: {
        warn: (...args: unknown[]) => this.ctx.log(`shim warn: ${args.map(String).join(' ')}`),
        error: (...args: unknown[]) => this.ctx.log(`shim error: ${args.map(String).join(' ')}`),
      },
      channelPerturbation: 'off',
    })

    await this.shimInstance.ready
    this.ctx.log(`WorkBuddy shim 已就绪，内部端点 :${this.shimInstance.baseUrl()}`)
  }

  async listModels(): Promise<ModuleModelInfo[]> {
    // 1. 尝试读取此前配置中已有的真实 WorkBuddy 标签（保留原汁原味的历史倍率与选项）
    const savedLabels: Record<string, string> = {}
    try {
      const oldConfigPath = join(homedir(), '.workbuddy-claude', 'config.json')
      if (existsSync(oldConfigPath)) {
        const parsed = JSON.parse(readFileSync(oldConfigPath, 'utf8'))
        if (parsed.routes && typeof parsed.routes === 'object') {
          for (const r of Object.values(parsed.routes) as any[]) {
            if (r && r.model && r.label) {
              savedLabels[r.model] = r.label
            }
          }
        }
      }
    } catch {}

    // 2. 收集与合并全部可用模型（常用实测模型 -> 实时 catalog -> 静态 fallback）
    const live = this.catalog.current()
    const seen = new Set<string>()
    const allModels: Array<{
      id: string
      name?: string
      creditMultiplier?: number
      free?: boolean
    }> = []

    // 首先置顶用户最常用的 16 个真实模型
    for (const km of KNOWN_WB_MODELS) {
      if (!seen.has(km.id)) {
        seen.add(km.id)
        allModels.push({
          id: km.id,
          name: km.name ?? km.id,
          creditMultiplier: typeof km.rate === 'number' ? km.rate : km.rate !== undefined ? Number(km.rate) : undefined,
          free: km.free,
        })
      }
    }

    // 补充实时从上游拉取到的模型目录
    for (const m of live) {
      if (!seen.has(m.id)) {
        seen.add(m.id)
        allModels.push({
          id: m.id,
          name: m.name ?? m.id,
          creditMultiplier: m.creditMultiplier,
          free: m.creditMultiplier === 0 || m.id.toLowerCase().includes('free'),
        })
      } else {
        // 如果已存在，但实时上游有具体的 creditMultiplier，更新倍率
        const existing = allModels.find(item => item.id === m.id)
        if (existing && typeof m.creditMultiplier === 'number') {
          existing.creditMultiplier = m.creditMultiplier
          existing.free = m.creditMultiplier === 0 || m.id.toLowerCase().includes('free')
        }
      }
    }

    // 补充 fallback 静态清单以防遗漏
    for (const m of [...FALLBACK_WORKBUDDY_MODELS, ...FALLBACK_WORKBUDDY_MODELS_GLOBAL]) {
      if (!seen.has(m.id)) {
        seen.add(m.id)
        const known = KNOWN_WB_RATES[m.id]
        allModels.push({
          id: m.id,
          name: m.name ?? m.id,
          creditMultiplier: known && typeof known.rate === 'number' ? known.rate : known?.rate !== undefined ? Number(known.rate) : undefined,
          free: known?.free || m.id.toLowerCase().includes('free'),
        })
      }
    }

    return allModels.map(m => {
      // 优先查看历史记录中保存的 label
      const saved = savedLabels[m.id]
      let label: string
      if (saved) {
        // 将旧的 (x0) 转为更易读直观的 (free)
        label = saved.replace(/\(x0\)/g, '(free)')
      } else {
        const known = KNOWN_WB_RATES[m.id]
        const rate = m.creditMultiplier !== undefined ? m.creditMultiplier : known?.rate
        const isFree = m.free || known?.free
        label = formatWorkBuddyLabel(m.id, rate, isFree)
      }

      return {
        id: m.id,
        name: m.name ?? m.id,
        labelOverride: label,
        description: `WorkBuddy ${m.name ?? m.id}`,
      }
    })
  }

  async handleRequest(
    request: AnthropicRequest,
    res: ServerResponse,
    _context: RequestContext,
    targetModel?: string
  ): Promise<void> {
    if (!this.shimInstance) {
      throw new Error('WorkBuddy shim 未初始化')
    }

    const actualModel = targetModel || request.model
    const shimUrl = `${this.shimInstance.baseUrl()}/v1/chat/completions`
    const openAiBody = toOpenAIRequest({
      ...request,
      model: actualModel,
    } as any)

    let upstreamRes: Response
    try {
      upstreamRes = await fetch(shimUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.shimInstance.token()}`,
        },
        body: JSON.stringify(openAiBody),
      })
    } catch (err: any) {
      res.statusCode = 502
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(errorPayload('api_error', `无法连接 WorkBuddy shim: ${err.message}`)))
      return
    }

    if (!upstreamRes.ok) {
      const text = await upstreamRes.text()
      res.statusCode = upstreamRes.status
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(errorPayload('api_error', `WorkBuddy 上游错误 (${upstreamRes.status}): ${text}`)))
      return
    }

    if (request.stream) {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      if (typeof (res as any).flushHeaders === 'function') (res as any).flushHeaders()

      await streamAnthropic(upstreamRes.body!, res, {
        model: request.model,
        clientSawStreaming: true,
      })
    } else {
      const data = await upstreamRes.json()
      const anthropicResponse = collectAnthropic(data, request.model)
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(anthropicResponse))
    }
  }

  /**
   * 附属余额查询小模块：获取 WorkBuddy 积分与账号信息
   */
  async getStatus(): Promise<ModuleStatus> {
    const cred = await this.creds.current().catch(() => undefined)
    if (!cred) {
      return {
        online: false,
        account: '未在 WorkBuddy 桌面端登录',
        balance: '0',
      }
    }

    let creditsStr = '已登录'
    let creditsNum: number | undefined
    try {
      const res = await this.upstream.fetchCredits(cred)
      creditsNum = res.total
      creditsStr = `${creditsNum} 算力`
    } catch {}

    const accountName = cred.displayName ?? cred.enterpriseUserName ?? cred.nickname ?? cred.uin ?? cred.uid ?? '已登录'

    return {
      online: true,
      account: `${accountName} (${cred.domain})`,
      balance: creditsStr,
      details: {
        domain: cred.domain,
        modelsCount: this.catalog.current().length,
      },
    }
  }

  async dispose(): Promise<void> {
    if (this.shimInstance) {
      await this.shimInstance.close()
      this.shimInstance = null
    }
  }
}
