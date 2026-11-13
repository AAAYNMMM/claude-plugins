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
  RouteAttemptResult,
  AnthropicRequest,
} from '../../core/types.ts'
import { isRetryableHttpStatus } from '../../core/router.ts'
import {
  collectAnthropic,
  errorPayload,
  errorTypeForStatus,
  estimateRequestTokens,
  streamAnthropic,
  toOpenAIRequest,
  UpstreamStreamError,
} from '../../core/protocol/anthropic.ts'
import { WorkBuddyCredentialStore, type WorkBuddyCredential } from './vendor/src/auth.ts'
import {
  WorkBuddyCatalog,
  FALLBACK_WORKBUDDY_MODELS,
  FALLBACK_WORKBUDDY_MODELS_GLOBAL,
  type WorkBuddyModelInfo,
} from './vendor/src/catalog.ts'
import { createDeviceProfileLookup } from './vendor/src/device-profile.ts'
import { createWorkBuddyShim, type WorkBuddyShim } from './vendor/src/shim.ts'
import { createTuringSdk, type WorkBuddyTuringSdk } from './vendor/src/turing-sdk.ts'
import { APP_VERSION, WorkBuddyUpstreamClient, type WorkBuddyRegion } from './vendor/src/upstream.ts'

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
  private configuredRegion: 'cn' | 'global' | 'auto' = 'auto'
  private activeRegion: WorkBuddyRegion = 'cn'
  private channelPerturbation: 'off' | 'failure' | 'always' = 'failure'
  private cnStore: WorkBuddyCredentialStore | null = null
  private globalStore: WorkBuddyCredentialStore | null = null
  private creds!: WorkBuddyCredentialStore
  private catalog!: WorkBuddyCatalog
  private upstream!: WorkBuddyUpstreamClient
  private turing: WorkBuddyTuringSdk | null = null
  private shimInstance: WorkBuddyShim | null = null

  setRegion(region?: 'cn' | 'global' | 'auto'): void {
    this.configuredRegion = region ?? 'auto'
  }

  setChannelPerturbation(mode?: 'off' | 'failure' | 'always'): void {
    this.channelPerturbation = mode ?? 'failure'
  }

  private getRegionStore(region: WorkBuddyRegion): WorkBuddyCredentialStore {
    if (region === 'cn') {
      if (!this.cnStore) {
        this.cnStore = new WorkBuddyCredentialStore({
          region: 'cn',
          refresh: (cred) => this.upstream.refreshToken(cred),
        })
      }
      return this.cnStore
    }
    if (!this.globalStore) {
      this.globalStore = new WorkBuddyCredentialStore({
        region: 'global',
        refresh: (cred) => this.upstream.refreshToken(cred),
      })
    }
    return this.globalStore
  }

  private async resolveRegionStore(): Promise<{
    region: WorkBuddyRegion
    store: WorkBuddyCredentialStore
    cred?: WorkBuddyCredential
    error?: unknown
  }> {
    if (this.configuredRegion === 'cn' || this.configuredRegion === 'global') {
      const store = this.getRegionStore(this.configuredRegion)
      try {
        const cred = await store.resolve()
        return { region: this.configuredRegion, store, cred }
      } catch (error) {
        return { region: this.configuredRegion, store, error }
      }
    }

    const cnStore = this.getRegionStore('cn')
    try {
      const cnCred = await cnStore.resolve()
      return { region: 'cn', store: cnStore, cred: cnCred }
    } catch {}

    const globalStore = this.getRegionStore('global')
    try {
      const globalCred = await globalStore.resolve()
      return { region: 'global', store: globalStore, cred: globalCred }
    } catch (error) {
      return { region: 'cn', store: cnStore, error }
    }
  }

  private async resolveActiveCredential(): Promise<WorkBuddyCredential> {
    const resolved = await this.resolveRegionStore()
    this.activeRegion = resolved.region
    this.creds = resolved.store
    if (resolved.cred) {
      return resolved.cred
    }
    if (resolved.error instanceof Error) {
      throw resolved.error
    }
    throw new Error('未检测到已登录的 WorkBuddy 账号')
  }

  async init(context: ModuleContext): Promise<void> {
    await this.dispose()
    this.cnStore = null
    this.globalStore = null

    this.ctx = context
    const deviceProfiles = createDeviceProfileLookup()
    this.turing = createTuringSdk({
      productVersion: APP_VERSION,
      dirSource: () => deviceProfiles.sdkDir(),
      enabled: true,
    })
    this.turing.startAutoRefresh()

    this.upstream = new WorkBuddyUpstreamClient(
      (msg) => {
        this.ctx.log(`WorkBuddy 上游回退: ${msg}`)
      },
      {},
      {
        deviceProfiles,
        realDevice: this.turing.tokens,
      }
    )

    const resolved = await this.resolveRegionStore()
    this.activeRegion = resolved.region
    this.creds = resolved.store
    this.catalog = new WorkBuddyCatalog(this.activeRegion)

    // 尝试拉取上游实时模型目录（4s 超时防止启动挂起）
    const cred = resolved.cred
    if (cred) {
      const accountName = cred.displayName ?? cred.enterpriseUserName ?? cred.nickname ?? cred.uin ?? cred.uid
      this.ctx.log(`WorkBuddy 模块检测到已登录账号: ${accountName} (${cred.domain}, region=${this.activeRegion})`)
      try {
        const roster = await this.upstream.fetchModels(cred, AbortSignal.timeout(4000))
        if (roster && roster.length > 0) {
          this.catalog.replace(roster)
        }
      } catch {}
    } else {
      this.ctx.log('WorkBuddy 本地凭据检测提示: 未检测到已登录账号')
    }

    const dynamicStore = {
      resolve: () => this.resolveActiveCredential(),
    } as unknown as WorkBuddyCredentialStore

    // 启动本地回环 OpenAI shim
    this.shimInstance = createWorkBuddyShim({
      store: dynamicStore,
      client: this.upstream,
      catalog: this.catalog,
      logger: {
        warn: (...args: unknown[]) => this.ctx.log(`shim warn: ${args.map(String).join(' ')}`),
        error: (...args: unknown[]) => this.ctx.log(`shim error: ${args.map(String).join(' ')}`),
      },
      channelPerturbation: this.channelPerturbation,
    })

    await this.shimInstance.ready
    this.ctx.log(`WorkBuddy shim 已就绪，内部端点 :${this.shimInstance.baseUrl()}`)
  }

  async listModels(): Promise<ModuleModelInfo[]> {
    // 若启动时未登录或尚未拉取到实时目录，在同步时动态探测登录态并刷新目录
    if (!this.catalog.hasLiveRoster()) {
      const resolved = await this.resolveRegionStore()
      if (resolved.region !== this.activeRegion) {
        this.activeRegion = resolved.region
        this.creds = resolved.store
        this.catalog = new WorkBuddyCatalog(this.activeRegion)
      }
      if (resolved.cred) {
        try {
          const roster = await this.upstream.fetchModels(resolved.cred, AbortSignal.timeout(4000))
          if (roster && roster.length > 0) {
            this.catalog.replace(roster)
          }
        } catch {}
      }
    }

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

    // 2. 收集与合并全部可用模型：已拉取到实时目录时只暴露上游真实支持的模型，避免无效模型 11102
    const live = this.catalog.current()
    const hasLive = this.catalog.hasLiveRoster()
    const seen = new Set<string>()
    const allModels: Array<{
      id: string
      name?: string
      creditMultiplier?: number
      free?: boolean
    }> = []

    // 实时从上游拉取到的模型目录
    for (const m of live) {
      if (!seen.has(m.id)) {
        seen.add(m.id)
        const known = KNOWN_WB_RATES[m.id]
        const mult = m.creditMultiplier ?? (known?.rate !== undefined ? Number(known.rate) : undefined)
        allModels.push({
          id: m.id,
          name: m.name ?? m.id,
          creditMultiplier: mult,
          free: mult === 0 || known?.free || m.id.toLowerCase().includes('free'),
        })
      }
    }

    // 仅在尚未拉取到实时目录时回退到静态清单
    if (!hasLive) {
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
      const staticFallback = this.activeRegion === 'global' ? FALLBACK_WORKBUDDY_MODELS_GLOBAL : FALLBACK_WORKBUDDY_MODELS
      for (const m of staticFallback) {
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
    context: RequestContext,
    targetModel?: string
  ): Promise<void> {
    const result = await this.tryHandleRequest(request, res, context, targetModel)
    if (!result.committed && !res.headersSent) {
      res.statusCode = result.status
      res.setHeader('Content-Type', 'application/json')
      if (result.status === 429 && result.retryAfterMs) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))))
      }
      res.end(errorPayload(result.errorType ?? errorTypeForStatus(result.status), result.message))
    }
  }

  async tryHandleRequest(
    request: AnthropicRequest,
    res: ServerResponse,
    _context: RequestContext,
    targetModel?: string
  ): Promise<RouteAttemptResult> {
    if (!this.shimInstance) {
      return {
        committed: false,
        status: 503,
        retryable: true,
        errorType: 'api_error',
        message: 'WorkBuddy shim 未初始化',
      }
    }

    const actualModel = targetModel || request.model
    const shimUrl = `${this.shimInstance.baseUrl()}/v1/chat/completions`
    const anthReq = request as any
    const { body: openAiBody, warnings } = toOpenAIRequest(anthReq, actualModel)
    for (const w of warnings) {
      this.ctx.log(`WorkBuddy 请求转换提示: ${w}`)
    }
    const inputTokens = estimateRequestTokens(anthReq)

    const abortCtrl = new AbortController()
    const onClientClose = () => {
      if (!res.writableEnded) {
        abortCtrl.abort()
      }
    }
    if (typeof (res as any).on === 'function') {
      res.on('close', onClientClose)
    }

    let upstreamRes: Response
    try {
      upstreamRes = await fetch(shimUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.shimInstance.token()}`,
        },
        body: JSON.stringify(openAiBody),
        signal: abortCtrl.signal,
      })
    } catch (err: any) {
      if (typeof (res as any).off === 'function') {
        res.off('close', onClientClose)
      }
      if (abortCtrl.signal.aborted || err?.name === 'AbortError') {
        return {
          committed: false,
          aborted: true,
          status: 499,
          retryable: false,
          errorType: 'api_error',
          message: '客户端已断开连接',
        }
      }
      return {
        committed: false,
        status: 502,
        retryable: true,
        errorType: 'api_error',
        message: `无法连接 WorkBuddy shim: ${err?.message ?? String(err)}`,
      }
    }

    try {
      if (!upstreamRes.ok) {
        const text = await upstreamRes.text().catch(() => '')
        const status = upstreamRes.status
        const retryAfterHeader = upstreamRes.headers.get('retry-after')
        const retrySec = retryAfterHeader ? Number(retryAfterHeader) : NaN
        const retryAfterMs =
          Number.isFinite(retrySec) && retrySec > 0 ? Math.ceil(retrySec * 1000) : undefined
        return {
          committed: false,
          status,
          retryable: isRetryableHttpStatus(status),
          retryAfterMs,
          errorType: errorTypeForStatus(status),
          message: `WorkBuddy 上游错误 (${status}): ${text}`,
        }
      }

      if (!upstreamRes.body) {
        return {
          committed: false,
          status: 502,
          retryable: true,
          errorType: 'api_error',
          message: 'WorkBuddy 上游返回空响应体',
        }
      }

      const onStreamWarning = (w: string) => this.ctx.log(`WorkBuddy 流转换警告: ${w}`)
      if (request.stream) {
        const onBeforeStart = () => {
          if (res.headersSent) return
          res.statusCode = 200
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
          res.setHeader('Cache-Control', 'no-cache')
          res.setHeader('Connection', 'keep-alive')
          if (typeof (res as any).flushHeaders === 'function') (res as any).flushHeaders()
        }

        try {
          await streamAnthropic(upstreamRes.body, res, request.model, inputTokens, onStreamWarning, onBeforeStart)
          return { committed: true }
        } catch (err: any) {
          await upstreamRes.body.cancel().catch(() => {})
          if (abortCtrl.signal.aborted || err?.name === 'AbortError') {
            return {
              committed: false,
              aborted: true,
              status: 499,
              retryable: false,
              errorType: 'api_error',
              message: '客户端已断开连接',
            }
          }
          if (!res.headersSent) {
            const status = err instanceof UpstreamStreamError ? err.status : 502
            return {
              committed: false,
              status,
              retryable: isRetryableHttpStatus(status),
              errorType: errorTypeForStatus(status),
              message: err?.message ?? 'WorkBuddy 流在首帧即返回错误',
            }
          }
          throw err
        } finally {
          if (abortCtrl.signal.aborted) {
            await upstreamRes.body.cancel().catch(() => {})
          }
          if (res.headersSent && !res.writableEnded) {
            res.end()
          }
        }
      } else {
        try {
          const anthropicResponse = await collectAnthropic(
            upstreamRes.body,
            request.model,
            inputTokens,
            onStreamWarning
          )
          if (abortCtrl.signal.aborted) {
            return {
              committed: false,
              aborted: true,
              status: 499,
              retryable: false,
              errorType: 'api_error',
              message: '客户端已断开连接',
            }
          }
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(anthropicResponse))
          return { committed: true }
        } catch (err: any) {
          await upstreamRes.body.cancel().catch(() => {})
          if (abortCtrl.signal.aborted || err?.name === 'AbortError') {
            return {
              committed: false,
              aborted: true,
              status: 499,
              retryable: false,
              errorType: 'api_error',
              message: '客户端已断开连接',
            }
          }
          const status = err instanceof UpstreamStreamError ? err.status : 502
          return {
            committed: false,
            status,
            retryable: isRetryableHttpStatus(status),
            errorType: errorTypeForStatus(status),
            message: err?.message ?? 'WorkBuddy 响应汇总失败',
          }
        }
      }
    } finally {
      if (typeof (res as any).off === 'function') {
        res.off('close', onClientClose)
      }
    }
  }

  /**
   * 附属余额查询小模块：获取 WorkBuddy 积分与账号信息
   */
  async getStatus(): Promise<ModuleStatus> {
    const resolved = await this.resolveRegionStore()
    this.activeRegion = resolved.region
    this.creds = resolved.store
    const cred = resolved.cred
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
    if (this.turing) {
      this.turing.stopAutoRefresh()
      this.turing = null
    }
    if (this.shimInstance) {
      await this.shimInstance.close()
      this.shimInstance = null
    }
  }
}
