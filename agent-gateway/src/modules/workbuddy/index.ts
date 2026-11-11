/**
 * WorkBuddy 代理子模块：接入 WorkBuddy 模型并提供余额/积分附属小模块。
 */

import type { ServerResponse } from 'node:http'
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
} from './vendor/src/catalog.ts'
import { createWorkBuddyShim, type WorkBuddyShim } from './vendor/src/shim.ts'
import { WorkBuddyUpstreamClient } from './vendor/src/upstream.ts'

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
    // 优先从活跃 catalog 中读取
    const live = this.catalog.current()
    const seen = new Set<string>()
    const allModels: Array<{ id: string; name?: string; multiplier?: number | string }> = []

    for (const m of live) {
      if (!seen.has(m.id)) {
        seen.add(m.id)
        allModels.push(m)
      }
    }

    // 合并静态 fallback 保证不遗漏任何可用型号
    for (const m of [...FALLBACK_WORKBUDDY_MODELS, ...FALLBACK_WORKBUDDY_MODELS_GLOBAL]) {
      if (!seen.has(m.id)) {
        seen.add(m.id)
        allModels.push(m)
      }
    }

    return allModels.map(m => {
      const mult = m.multiplier !== undefined ? ` (${m.multiplier}x)` : ''
      return {
        id: m.id,
        name: m.name ?? m.id,
        labelOverride: `WB · ${m.name ?? m.id}${mult}`,
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
