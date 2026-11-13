/**
 * 路由熔断器（参考 farion1231/cc-switch `circuit_breaker.rs`）：
 * 追踪各上游目标/配额桶的健康状态（Closed -> Open -> HalfOpen），
 * 在触发 429 限流或连续故障时立即熔断并进入冷却，避免长时间死等同一失败节点。
 */

export type CircuitState = 'closed' | 'open' | 'half_open'

export interface CircuitBreakerConfig {
  /** 连续失败多少次后熔断（429 限流可直接触发瞬时熔断） */
  failureThreshold: number
  /** 半开探测连续成功多少次后恢复为 closed */
  successThreshold: number
  /** 默认熔断冷却时长（毫秒） */
  cooldownMs: number
  /** 计算错误率前的最小样本数 */
  minRequests: number
  /** 错误率阈值 (0~1) */
  errorRateThreshold: number
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 2,
  successThreshold: 1,
  cooldownMs: 45_000,
  minRequests: 6,
  errorRateThreshold: 0.6,
}

export interface CircuitPermit {
  allowed: boolean
  usedHalfOpenPermit: boolean
  release: () => void
}

export interface CircuitBreakerStats {
  key: string
  state: CircuitState
  consecutiveFailures: number
  consecutiveSuccesses: number
  totalRequests: number
  failedRequests: number
  cooldownRemainingMs: number
  lastError?: string
}

export class CircuitBreaker {
  private state: CircuitState = 'closed'
  private consecutiveFailures = 0
  private consecutiveSuccesses = 0
  private totalRequests = 0
  private failedRequests = 0
  private openedAt = 0
  private openDurationMs: number
  private halfOpenRound = 0
  private halfOpenInFlight = 0
  private halfOpenPermitActive = false
  private lastError?: string
  private config: CircuitBreakerConfig
  readonly key: string

  constructor(key: string, config: Partial<CircuitBreakerConfig> = {}) {
    this.key = key
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config }
    this.openDurationMs = this.config.cooldownMs
  }

  updateConfig(next: Partial<CircuitBreakerConfig>): void {
    this.config = { ...this.config, ...next }
  }

  /** 判断当前节点是否可进入候选路由（Open 超时后切至 HalfOpen） */
  isAvailable(now = Date.now()): boolean {
    if (this.state !== 'open') return true
    if (now - this.openedAt >= this.openDurationMs) {
      this.transitionToHalfOpen()
      return true
    }
    return false
  }

  /** 请求前申请放行许可；HalfOpen 状态每轮仅放行 1 个并发探测 */
  allowRequest(now = Date.now()): CircuitPermit {
    if (this.state === 'open') {
      if (now - this.openedAt >= this.openDurationMs) {
        this.transitionToHalfOpen()
      } else {
        return { allowed: false, usedHalfOpenPermit: false, release: () => {} }
      }
    }

    if (this.state === 'closed') {
      return { allowed: true, usedHalfOpenPermit: false, release: () => {} }
    }

    if (this.halfOpenInFlight >= 1) {
      return { allowed: false, usedHalfOpenPermit: false, release: () => {} }
    }

    this.halfOpenInFlight++
    this.halfOpenPermitActive = true
    const round = this.halfOpenRound
    let released = false
    return {
      allowed: true,
      usedHalfOpenPermit: true,
      release: () => {
        if (!released && this.halfOpenRound === round) {
          released = true
          if (this.halfOpenPermitActive) {
            this.halfOpenPermitActive = false
            this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1)
          }
        }
      },
    }
  }

  private consumeHalfOpenPermit(usedHalfOpenPermit: boolean): void {
    if (usedHalfOpenPermit && this.halfOpenPermitActive) {
      this.halfOpenPermitActive = false
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1)
    }
  }

  recordSuccess(usedHalfOpenPermit: boolean): void {
    this.consumeHalfOpenPermit(usedHalfOpenPermit)

    this.totalRequests++
    this.consecutiveFailures = 0
    this.lastError = undefined

    if (this.state === 'half_open') {
      this.consecutiveSuccesses++
      if (this.consecutiveSuccesses >= this.config.successThreshold) {
        this.transitionToClosed()
      }
    }
  }

  recordFailure(
    usedHalfOpenPermit: boolean,
    options: { openImmediately?: boolean; cooldownMs?: number; error?: string } = {}
  ): CircuitState {
    this.consumeHalfOpenPermit(usedHalfOpenPermit)

    this.totalRequests++
    this.failedRequests++
    this.consecutiveFailures++
    this.consecutiveSuccesses = 0
    if (options.error) this.lastError = options.error

    if (this.state === 'half_open' || options.openImmediately) {
      this.transitionToOpen(options.cooldownMs)
      return this.state
    }

    const errorRate = this.totalRequests > 0 ? this.failedRequests / this.totalRequests : 0
    if (
      this.consecutiveFailures >= this.config.failureThreshold ||
      (this.totalRequests >= this.config.minRequests && errorRate >= this.config.errorRateThreshold)
    ) {
      this.transitionToOpen(options.cooldownMs)
    }
    return this.state
  }

  reset(): void {
    this.transitionToClosed()
  }

  getStats(now = Date.now()): CircuitBreakerStats {
    const cooldownRemainingMs =
      this.state === 'open' ? Math.max(0, this.openDurationMs - (now - this.openedAt)) : 0
    return {
      key: this.key,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      totalRequests: this.totalRequests,
      failedRequests: this.failedRequests,
      cooldownRemainingMs,
      lastError: this.lastError,
    }
  }

  private transitionToOpen(cooldownMs?: number): void {
    this.state = 'open'
    this.openedAt = Date.now()
    const baseMs = cooldownMs && cooldownMs > 0 ? cooldownMs : this.config.cooldownMs
    this.openDurationMs = Math.max(10_000, Math.min(baseMs, 180_000))
    this.halfOpenInFlight = 0
    this.halfOpenPermitActive = false
  }

  private transitionToHalfOpen(): void {
    if (this.state !== 'open') return
    this.state = 'half_open'
    this.halfOpenRound++
    this.halfOpenInFlight = 0
    this.halfOpenPermitActive = false
    this.consecutiveSuccesses = 0
  }

  private transitionToClosed(): void {
    this.state = 'closed'
    this.consecutiveFailures = 0
    this.consecutiveSuccesses = 0
    this.totalRequests = 0
    this.failedRequests = 0
    this.openedAt = 0
    this.halfOpenInFlight = 0
    this.halfOpenPermitActive = false
    this.lastError = undefined
  }
}
