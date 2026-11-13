/**
 * 多节点智能路由器与故障转移调度器（参考 farion1231/cc-switch `provider_router.rs` + `forwarder.rs`）：
 * - 基于配额桶与目标节点的双层熔断器
 * - 遇到 429 限流或 5xx 故障时立即熔断冷却并故障转移，绝不长时间死等同一失败桶
 * - 严格区分客户端自身参数错误（NonRetryable，如 400/422）与上游可转移错误（429/5xx/401/403）
 */

import type { ServerResponse } from 'node:http'
import type { ModuleHost } from './module-host.ts'
import type {
  AnthropicRequest,
  GatewayConfig,
  GatewayModule,
  RequestContext,
  RouteAttemptResult,
  RouteConfig,
} from './types.ts'
import { CircuitBreaker, type CircuitBreakerStats } from './circuit-breaker.ts'
import { errorPayload, errorTypeForStatus } from './protocol/anthropic.ts'
import { getModelRemainingFraction, getQuotaBucket } from '../modules/antigravity/models.ts'

export interface RouteCandidate {
  moduleId: string
  targetModel?: string
  label: string
  bucketKey: string
  targetKey: string
  isPrimary: boolean
}

const NON_RETRYABLE_STATUSES = new Set([400, 405, 406, 413, 414, 415, 422, 501])

/** 判断上游状态码是否值得故障转移（对齐 cc-switch forwarder.rs categorize_proxy_error） */
export function isRetryableHttpStatus(status: number): boolean {
  if (status >= 200 && status < 300) return false
  return !NON_RETRYABLE_STATUSES.has(status)
}

/** 计算给定模块与目标模型所属的独立配额桶 Key */
export function getTargetBucketKey(moduleId: string, targetModel?: string): string {
  if (moduleId === 'antigravity') {
    return `antigravity:bucket:${getQuotaBucket(targetModel ?? '')}`
  }
  return `${moduleId}:model:${targetModel ?? 'default'}`
}

function classifyModelTier(modelName: string): 'fast' | 'flagship' | 'balanced' {
  const lower = modelName.toLowerCase()
  if (lower.includes('haiku') || lower.includes('flash') || lower.includes('lite')) {
    return 'fast'
  }
  if (lower.includes('opus') || lower.includes('hydrogen') || lower.includes('pro') || lower.includes('argon')) {
    return 'flagship'
  }
  return 'balanced'
}

export class GatewayRouter {
  private readonly breakers = new Map<string, CircuitBreaker>()
  private readonly fallbackProbeInFlight = new Set<string>()

  private getConfigOptions(config: GatewayConfig) {
    const f = config.failover ?? {}
    return {
      enabled: f.enabled === true,
      maxAttempts: Math.max(1, f.maxAttempts ?? 4),
      failureThreshold: Math.max(1, f.failureThreshold ?? 2),
      successThreshold: Math.max(1, f.successThreshold ?? 1),
      cooldownMs: Math.max(10_000, (f.cooldownSeconds ?? 45) * 1000),
      crossModuleFailover: f.crossModuleFailover === true,
    }
  }

  private getOrCreateBreaker(key: string, config: GatewayConfig): CircuitBreaker {
    const opts = this.getConfigOptions(config)
    let breaker = this.breakers.get(key)
    if (!breaker) {
      breaker = new CircuitBreaker(key, {
        failureThreshold: opts.failureThreshold,
        successThreshold: opts.successThreshold,
        cooldownMs: opts.cooldownMs,
      })
      this.breakers.set(key, breaker)
    } else {
      breaker.updateConfig({
        failureThreshold: opts.failureThreshold,
        successThreshold: opts.successThreshold,
        cooldownMs: opts.cooldownMs,
      })
    }
    return breaker
  }

  /** 解析首跳主路由与有序故障转移候选队列 */
  selectCandidates(
    reqModel: string,
    config: GatewayConfig,
    host: ModuleHost,
    clientKey?: string
  ): RouteCandidate[] {
    const opts = this.getConfigOptions(config)
    const isLocalGatewayToken = !!clientKey && clientKey === config.token

    let primaryRoute: RouteConfig | undefined = config.routes[reqModel]
    if (!primaryRoute) {
      if (reqModel.includes('antigravity') || reqModel.includes('gemini')) {
        primaryRoute = { module: 'antigravity', targetModel: reqModel, label: `AGY · ${reqModel}` }
      } else if (reqModel.includes('deepseek')) {
        primaryRoute = { module: 'passthrough', targetModel: reqModel, label: reqModel }
      } else {
        const usableRoutes = Object.values(config.routes).filter(
          (r) => !(isLocalGatewayToken && r.module === 'passthrough')
        )
        primaryRoute =
          (reqModel.includes('haiku')
            ? usableRoutes.find((r) => r.targetModel?.includes('flash') || r.label?.includes('Flash'))
            : undefined) ??
          usableRoutes[0] ?? {
            module: 'antigravity',
            targetModel: undefined,
            label: reqModel || 'antigravity',
          }
      }
    }

    const candidates: RouteCandidate[] = []
    const seenTargets = new Set<string>()

    const pushCandidate = (
      modId: string,
      targetModel: string | undefined,
      label: string,
      isPrimary = false
    ) => {
      if (!host.getModule(modId)) return
      if (isLocalGatewayToken && modId === 'passthrough' && !isPrimary) return
      const targetKey = `${modId}:${targetModel ?? 'default'}`
      if (seenTargets.has(targetKey)) return
      seenTargets.add(targetKey)
      candidates.push({
        moduleId: modId,
        targetModel,
        label,
        bucketKey: getTargetBucketKey(modId, targetModel),
        targetKey,
        isPrimary,
      })
    }

    pushCandidate(
      primaryRoute.module,
      primaryRoute.targetModel,
      primaryRoute.label ?? primaryRoute.targetModel ?? primaryRoute.module,
      true
    )

    if (!opts.enabled) {
      return candidates
    }

    const tier = classifyModelTier(`${reqModel} ${primaryRoute.targetModel ?? ''}`)
    const registeredRoutes = Object.values(config.routes)

    // 1. 优先尝试同模块内的不同配额桶（例如 Antigravity: gemini-5h <-> argon <-> claude）
    if (primaryRoute.module === 'antigravity') {
      const agyRoutes = registeredRoutes.filter((r) => r.module === 'antigravity')
      const sortedAgy = [...agyRoutes].sort((a, b) => {
        const qA = getModelRemainingFraction(a.targetModel ?? '') ?? 1
        const qB = getModelRemainingFraction(b.targetModel ?? '') ?? 1
        if ((qA <= 0) !== (qB <= 0)) return qA <= 0 ? 1 : -1
        // 快速任务优先 argon / flash / sonnet；旗舰任务优先 argon / sonnet / opus / hydrogen
        const score = (r: RouteConfig) => {
          const m = (r.targetModel ?? '').toLowerCase()
          if (tier === 'fast') {
            if (m.includes('argon')) return 3
            if (m.includes('sonnet')) return 2
            if (m.includes('flash')) return 1
            return 0
          }
          if (m.includes('argon')) return 3
          if (m.includes('sonnet') || m.includes('opus')) return 2
          return 1
        }
        return score(b) - score(a)
      })
      for (const r of sortedAgy) {
        const rem = getModelRemainingFraction(r.targetModel ?? '')
        if (rem !== undefined && rem <= 0) continue
        pushCandidate(r.module, r.targetModel, r.label ?? r.targetModel ?? 'antigravity')
      }
    } else if (primaryRoute.module === 'workbuddy') {
      const wbRoutes = registeredRoutes.filter((r) => r.module === 'workbuddy')
      const preferredOrder =
        tier === 'fast'
          ? ['deepseek-v4-flash', 'hy3', 'glm-5v-turbo', 'glm-5.1']
          : ['deepseek-v4-pro', 'glm-5.3', 'kimi-k3-1', 'deepseek-v4-flash']
      for (const id of preferredOrder) {
        const match = wbRoutes.find((r) => r.targetModel === id)
        if (match) pushCandidate(match.module, match.targetModel, match.label ?? id)
      }
      for (const r of wbRoutes) {
        pushCandidate(r.module, r.targetModel, r.label ?? r.targetModel ?? 'WorkBuddy')
      }
    }

    // 2. 跨模块故障转移：当当前模块全部可用桶均受限/不可用时，无缝切换至另一健康的可用模块
    if (opts.crossModuleFailover) {
      if (primaryRoute.module !== 'workbuddy') {
        const wbRoutes = registeredRoutes.filter((r) => r.module === 'workbuddy')
        const preferredOrder =
          tier === 'fast'
            ? ['deepseek-v4-flash', 'hy3', 'glm-5v-turbo', 'deepseek-v4-pro']
            : ['deepseek-v4-pro', 'glm-5.3', 'kimi-k3-1', 'deepseek-v4-flash']
        for (const id of preferredOrder) {
          const match = wbRoutes.find((r) => r.targetModel === id)
          if (match) {
            pushCandidate(match.module, match.targetModel, match.label ?? `WB · ${id}`)
          }
        }
        if (wbRoutes.length > 0) {
          pushCandidate(wbRoutes[0].module, wbRoutes[0].targetModel, wbRoutes[0].label ?? 'WorkBuddy')
        }
      }

      if (primaryRoute.module !== 'antigravity') {
        const agyRoutes = registeredRoutes.filter((r) => r.module === 'antigravity')
        const preferred =
          tier === 'fast'
            ? agyRoutes.find((r) => r.targetModel?.includes('flash')) ??
              agyRoutes.find((r) => r.targetModel?.includes('argon')) ??
              agyRoutes[0]
            : agyRoutes.find((r) => r.targetModel?.includes('sonnet')) ??
              agyRoutes.find((r) => r.targetModel?.includes('opus')) ??
              agyRoutes[0]
        if (preferred) {
          pushCandidate(preferred.module, preferred.targetModel, preferred.label ?? 'Antigravity')
        }
      }
    }

    return candidates
  }

  /** 执行带熔断器过滤与自动故障转移的 /v1/messages 路由转发 */
  async dispatchMessage(
    request: AnthropicRequest,
    res: ServerResponse,
    reqContext: RequestContext,
    config: GatewayConfig,
    host: ModuleHost,
    log: (msg: string) => void
  ): Promise<void> {
    const reqModel = request.model ?? ''
    const opts = this.getConfigOptions(config)
    const candidates = this.selectCandidates(reqModel, config, host, reqContext.clientKey)

    if (candidates.length === 0) {
      res.statusCode = 503
      res.setHeader('Content-Type', 'application/json')
      res.end(errorPayload('api_error', `未找到可用于模型 "${reqModel}" 的路由模块`))
      return
    }

    const bypassBreakers = !opts.enabled || candidates.length === 1
    let attempted = 0
    let lastFailure: Extract<RouteAttemptResult, { committed: false }> | null = null
    const failedBuckets = new Set<string>()
    const failedModules = new Set<string>()

    for (const candidate of candidates) {
      if (attempted >= opts.maxAttempts) break
      // 若同一 Antigravity 配额桶本轮已失败（例如刚 429），或整模块认证失效（401/403），跳过同组其他节点
      if (!candidate.isPrimary && (failedBuckets.has(candidate.bucketKey) || failedModules.has(candidate.moduleId))) {
        continue
      }

      const mod = host.getModule(candidate.moduleId)
      if (!mod) continue

      const targetBreaker = opts.enabled ? this.getOrCreateBreaker(candidate.targetKey, config) : null
      const bucketBreaker =
        opts.enabled && candidate.bucketKey !== candidate.targetKey
          ? this.getOrCreateBreaker(candidate.bucketKey, config)
          : null

      let targetPermit = { allowed: true, usedHalfOpenPermit: false, release: () => {} }
      let bucketPermit = { allowed: true, usedHalfOpenPermit: false, release: () => {} }

      if (!bypassBreakers && targetBreaker) {
        if (!targetBreaker.isAvailable() || (bucketBreaker && !bucketBreaker.isAvailable())) {
          continue
        }
        targetPermit = targetBreaker.allowRequest()
        if (!targetPermit.allowed) continue
        if (bucketBreaker) {
          bucketPermit = bucketBreaker.allowRequest()
          if (!bucketPermit.allowed) {
            targetPermit.release()
            continue
          }
        }
      }

      attempted++
      if (candidate.isPrimary) {
        log(`分流路由: 模型 "${reqModel}" -> 模块 [${mod.name}] (目标: ${candidate.targetModel ?? '默认'})`)
      } else {
        log(
          `[故障转移] 模型 "${reqModel}" 自动切换至备用节点 [${mod.name}] -> ${candidate.targetModel ?? '默认'} (${candidate.label})`
        )
      }

      try {
        const result = await this.invokeModule(mod, request, res, reqContext, candidate.targetModel)
        if (!result.committed && result.aborted) {
          targetPermit.release()
          bucketPermit.release()
          if (!res.writableEnded) res.end()
          return
        }
        if (result.committed) {
          if (opts.enabled && targetBreaker) {
            targetBreaker.recordSuccess(targetPermit.usedHalfOpenPermit)
            bucketBreaker?.recordSuccess(bucketPermit.usedHalfOpenPermit)
          }
          return
        }

        // 不可重试错误（客户端 400/422 等）：不污染熔断器，立即原样返回
        if (!result.retryable) {
          targetPermit.release()
          bucketPermit.release()
          if (!res.headersSent) {
            this.writeFailureResponse(res, result)
          } else if (!res.writableEnded) {
            res.end()
          }
          return
        }

        // 上游可转移故障（429 / 5xx / 认证失效等）：记录失败，429 立即熔断本配额桶并切换下家
        const isRateLimit = result.status === 429
        const isAuthFailure = result.status === 401 || result.status === 403
        if (opts.enabled && targetBreaker) {
          targetBreaker.recordFailure(targetPermit.usedHalfOpenPermit, {
            openImmediately: isRateLimit || isAuthFailure,
            cooldownMs: result.retryAfterMs,
            error: result.message,
          })
          bucketBreaker?.recordFailure(bucketPermit.usedHalfOpenPermit, {
            openImmediately: isRateLimit || isAuthFailure,
            cooldownMs: result.retryAfterMs,
            error: result.message,
          })
        } else {
          targetPermit.release()
          bucketPermit.release()
        }

        if (res.headersSent) {
          if (!res.writableEnded) res.end()
          return
        }

        if (isRateLimit) {
          failedBuckets.add(candidate.bucketKey)
        }
        if (isAuthFailure) {
          failedModules.add(candidate.moduleId)
        }

        // 若主节点已返回具体上游错误（如 429），不要被未登录备用节点的 401/403 覆盖错误提示
        if (candidate.isPrimary || !lastFailure || !isAuthFailure) {
          lastFailure = result
        }
        log(
          `[路由熔断] 节点 ${candidate.targetKey} 返回 ${result.status}${
            isRateLimit ? '（配额桶已进入冷却）' : ''
          }，尝试下一可用节点`
        )
      } catch (err: any) {
        const isAbort =
          err?.name === 'AbortError' ||
          (reqContext.req as any)?.aborted ||
          (reqContext.req as any)?.destroyed ||
          (res as any)?.destroyed
        if (isAbort) {
          targetPermit.release()
          bucketPermit.release()
          if (!res.writableEnded) res.end()
          return
        }
        const msg = err?.message ?? String(err)
        if (opts.enabled && targetBreaker) {
          targetBreaker.recordFailure(targetPermit.usedHalfOpenPermit, { error: msg })
          bucketBreaker?.recordFailure(bucketPermit.usedHalfOpenPermit, { error: msg })
        } else {
          targetPermit.release()
          bucketPermit.release()
        }
        if (res.headersSent) {
          if (!res.writableEnded) res.end()
          return
        }
        lastFailure = {
          committed: false,
          status: 502,
          retryable: true,
          errorType: 'api_error',
          message: `模块 [${mod.name}] 处理异常: ${msg}`,
        }
        log(`[路由异常] 节点 ${candidate.targetKey}: ${msg}`)
      }
    }

    // 若所有节点当前均处于熔断 Open 状态，仍做一次首节点兜底探针（带并发互斥锁，避免惊群）
    if (attempted === 0 && candidates.length > 0) {
      const primary = candidates[0]
      const mod = host.getModule(primary.moduleId)
      const probeLockKey = primary.bucketKey || primary.targetKey
      if (mod) {
        if (this.fallbackProbeInFlight.has(probeLockKey)) {
          lastFailure = {
            committed: false,
            status: 429,
            retryable: true,
            retryAfterMs: 10_000,
            errorType: 'rate_limit_error',
            message: '所有可用模型路由均处于熔断冷却状态（恢复探测正在进行中），请稍后重试',
          }
        } else {
          this.fallbackProbeInFlight.add(probeLockKey)
          log(`[熔断兜底] 所有备用节点均处于冷却状态，放行首节点探测 [${mod.name}] -> ${primary.targetModel ?? '默认'}`)
          try {
            const probe = await this.invokeModule(mod, request, res, reqContext, primary.targetModel)
            if (!probe.committed && probe.aborted) {
              if (!res.writableEnded) res.end()
              return
            }
            if (probe.committed) {
              if (opts.enabled) {
                this.getOrCreateBreaker(primary.targetKey, config).reset()
                if (primary.bucketKey !== primary.targetKey) {
                  this.getOrCreateBreaker(primary.bucketKey, config).reset()
                }
              }
              return
            }
            if (opts.enabled && probe.retryable) {
              const isRateLimit = probe.status === 429
              const isAuthFailure = probe.status === 401 || probe.status === 403
              this.getOrCreateBreaker(primary.targetKey, config).recordFailure(false, {
                openImmediately: isRateLimit || isAuthFailure,
                cooldownMs: probe.retryAfterMs,
                error: probe.message,
              })
              if (primary.bucketKey !== primary.targetKey) {
                this.getOrCreateBreaker(primary.bucketKey, config).recordFailure(false, {
                  openImmediately: isRateLimit || isAuthFailure,
                  cooldownMs: probe.retryAfterMs,
                  error: probe.message,
                })
              }
            }
            if (res.headersSent) {
              if (!res.writableEnded) res.end()
              return
            }
            lastFailure = probe
          } catch (err: any) {
            const isAbort =
              err?.name === 'AbortError' ||
              (reqContext.req as any)?.aborted ||
              (reqContext.req as any)?.destroyed ||
              (res as any)?.destroyed
            if (isAbort) {
              if (!res.writableEnded) res.end()
              return
            }
            const msg = err?.message ?? String(err)
            if (opts.enabled) {
              this.getOrCreateBreaker(primary.targetKey, config).recordFailure(false, { error: msg })
              if (primary.bucketKey !== primary.targetKey) {
                this.getOrCreateBreaker(primary.bucketKey, config).recordFailure(false, { error: msg })
              }
            }
            if (res.headersSent) {
              if (!res.writableEnded) res.end()
              return
            }
            lastFailure = {
              committed: false,
              status: 502,
              retryable: true,
              errorType: 'api_error',
              message: `模块 [${mod.name}] 兜底探测异常: ${msg}`,
            }
          } finally {
            this.fallbackProbeInFlight.delete(probeLockKey)
          }
        }
      }
    }

    if (!res.headersSent) {
      this.writeFailureResponse(res, lastFailure)
    }
  }

  private writeFailureResponse(
    res: ServerResponse,
    failure: Extract<RouteAttemptResult, { committed: false }> | null
  ): void {
    const rawStatus = failure?.status ?? 503
    const status = Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : 502
    res.statusCode = status
    if (failure?.rawHeaders) {
      for (const [k, v] of Object.entries(failure.rawHeaders)) {
        if (v !== undefined) res.setHeader(k, v)
      }
    }
    if (status === 429 && !failure?.rawHeaders?.['retry-after']) {
      const retrySec = Math.max(1, Math.ceil((failure?.retryAfterMs ?? 30_000) / 1000))
      res.setHeader('Retry-After', String(retrySec))
    }
    if (failure?.rawBody !== undefined) {
      res.setHeader('Content-Type', failure.rawContentType || 'application/json')
      res.end(failure.rawBody)
      return
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(
      errorPayload(
        failure?.errorType ?? errorTypeForStatus(status),
        failure?.message ?? '所有可用模型路由均繁忙或已触发限流，请稍后重试'
      )
    )
  }

  private async invokeModule(
    mod: GatewayModule,
    request: AnthropicRequest,
    res: ServerResponse,
    reqContext: RequestContext,
    targetModel?: string
  ): Promise<RouteAttemptResult> {
    if (typeof mod.tryHandleRequest === 'function') {
      return mod.tryHandleRequest(request, res, reqContext, targetModel)
    }
    await mod.handleRequest(request, res, reqContext, targetModel)
    return { committed: true }
  }

  getBreakerStats(): CircuitBreakerStats[] {
    const now = Date.now()
    return Array.from(this.breakers.values()).map((b) => b.getStats(now))
  }
}
