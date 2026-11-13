/**
 * 反重力 (Antigravity / Google Cloud Code PA) 代理子模块：
 * 免密直通本机已登录反重力账号，将 Antigravity / Gemini / Claude 核心模型
 * 桥接为 Claude 桌面端与 CLI 能直接调用的标准 Anthropic Messages 格式。
 * 完整支持文本对话与 Tool Use (函数调用) 的协议双向转换。
 */

import type { ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
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
  ANTIGRAVITY_API_HOST,
  fetchLiveProjectAndTier,
  getAntigravityUserAgent,
  getDynamicAntigravityModels,
  getModelMaxOutputTokens,
  getQuotaBucket,
  resolveUpstreamModel,
} from './models.ts'
import { toGeminiRequest } from './gemini-converter.ts'
import { errorPayload, errorTypeForStatus } from '../../core/protocol/anthropic.ts'
import { antigravityAuth } from './auth.ts'

const MAX_CONCURRENT_REQUESTS = 1
const MIN_DISPATCH_GAP_MS = 350
const MAX_RETRY_DELAY_MS = 25_000
const MICRO_RETRY_MAX_MS = 2500
const DEFAULT_RETRY_AFTER_SEC = 30
const MAX_THOUGHT_SIG_CACHE = 500

/** 从上游响应头或 Google Cloud Code 错误文本中提取建议等待毫秒数 */
function parseRetryDelayMs(res: Response, errText: string): number | null {
  const retryAfter = res.headers.get('retry-after')
  if (retryAfter) {
    const sec = Number(retryAfter)
    if (Number.isFinite(sec) && sec > 0) {
      return Math.min(Math.ceil(sec * 1000), MAX_RETRY_DELAY_MS)
    }
    const dateMs = Date.parse(retryAfter)
    if (Number.isFinite(dateMs) && dateMs > Date.now()) {
      return Math.min(dateMs - Date.now(), MAX_RETRY_DELAY_MS)
    }
  }
  const delayMatch = errText.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i)
  if (delayMatch) {
    return Math.min(Math.ceil(Number(delayMatch[1]) * 1000), MAX_RETRY_DELAY_MS)
  }
  return null
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) {
    return signal.aborted ? Promise.reject(new DOMException('Aborted', 'AbortError')) : Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

const GRPC_TO_HTTP_STATUS: Record<number, number> = {
  1: 499, // CANCELLED
  2: 502, // UNKNOWN
  3: 400, // INVALID_ARGUMENT
  4: 504, // DEADLINE_EXCEEDED
  5: 404, // NOT_FOUND
  6: 409, // ALREADY_EXISTS
  7: 403, // PERMISSION_DENIED
  8: 429, // RESOURCE_EXHAUSTED
  9: 400, // FAILED_PRECONDITION
  10: 409, // ABORTED
  11: 400, // OUT_OF_RANGE
  12: 501, // UNIMPLEMENTED
  13: 500, // INTERNAL
  14: 503, // UNAVAILABLE
  15: 500, // DATA_LOSS
  16: 401, // UNAUTHENTICATED
}

const GRPC_NAME_TO_HTTP_STATUS: Record<string, number> = {
  CANCELLED: 499,
  UNKNOWN: 502,
  INVALID_ARGUMENT: 400,
  DEADLINE_EXCEEDED: 504,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  PERMISSION_DENIED: 403,
  RESOURCE_EXHAUSTED: 429,
  FAILED_PRECONDITION: 400,
  ABORTED: 409,
  OUT_OF_RANGE: 400,
  UNIMPLEMENTED: 501,
  INTERNAL: 500,
  UNAVAILABLE: 503,
  DATA_LOSS: 500,
  UNAUTHENTICATED: 401,
}

/** 将 Google/gRPC 流或非流错误对象的 code/status 规范映射到合法 HTTP [100, 599] 状态码 */
export function normalizeAntigravityErrorStatus(errObj: { code?: unknown; status?: unknown } | null | undefined): number {
  if (!errObj || typeof errObj !== 'object') return 502
  const rawCode = typeof errObj.code === 'string' && /^\d+$/.test(errObj.code.trim())
    ? Number(errObj.code.trim())
    : errObj.code
  if (typeof rawCode === 'number' && Number.isInteger(rawCode)) {
    if (rawCode >= 100 && rawCode <= 599) return rawCode
    if (rawCode in GRPC_TO_HTTP_STATUS) return GRPC_TO_HTTP_STATUS[rawCode]
  }
  if (typeof errObj.status === 'string') {
    const mapped = GRPC_NAME_TO_HTTP_STATUS[errObj.status.trim().toUpperCase()]
    if (mapped) return mapped
  }
  return 502
}

export class AntigravityModule implements GatewayModule {
  readonly id = 'antigravity'
  readonly name = '反重力 (Antigravity)'
  readonly description = '反重力桌面端免密桥接 (动态模型同步)'

  private ctx!: ModuleContext
  private accountEmail: string = ''
  private inFlight = 0
  private waitQueue: Array<() => void> = []
  private nextDispatchAt = 0
  private readonly bucketRateLimitUntil = new Map<string, number>()
  private readonly toolThoughtSignatures = new Map<string, string>()

  private cacheThoughtSignature(toolUseId: string, signature: string): void {
    if (!toolUseId || !signature) return
    if (this.toolThoughtSignatures.size >= MAX_THOUGHT_SIG_CACHE) {
      const oldestKey = this.toolThoughtSignatures.keys().next().value
      if (oldestKey) this.toolThoughtSignatures.delete(oldestKey)
    }
    this.toolThoughtSignatures.set(toolUseId, signature)
  }

  private async acquireSlot(signal: AbortSignal): Promise<void> {
    while (this.inFlight >= MAX_CONCURRENT_REQUESTS) {
      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }
      await new Promise<void>((resolve, reject) => {
        const entry = () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        }
        const onAbort = () => {
          const idx = this.waitQueue.indexOf(entry)
          if (idx !== -1) this.waitQueue.splice(idx, 1)
          reject(new DOMException('Aborted', 'AbortError'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        this.waitQueue.push(entry)
      })
    }
    if (signal.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    this.inFlight++
  }

  private releaseSlot(): void {
    this.inFlight = Math.max(0, this.inFlight - 1)
    const next = this.waitQueue.shift()
    if (next) next()
  }

  private async waitDispatchWindow(bucket: string, signal: AbortSignal): Promise<void> {
    const now = Date.now()
    const bucketUntil = this.bucketRateLimitUntil.get(bucket) ?? 0
    // 若冷却窗口大于微重试上限，说明应交给路由器立即切换配额桶，不要在此长时间阻塞
    const effectiveBucketWait = bucketUntil - now <= MICRO_RETRY_MAX_MS ? bucketUntil : 0
    const slotAt = Math.max(now, this.nextDispatchAt, effectiveBucketWait)
    this.nextDispatchAt = slotAt + MIN_DISPATCH_GAP_MS
    const waitMs = slotAt - now
    if (waitMs > 0) {
      await sleepAbortable(waitMs, signal)
    }
  }

  async init(context: ModuleContext): Promise<void> {
    this.ctx = context
    try {
      this.accountEmail = await antigravityAuth.getAccountEmail()
      this.ctx.log(`反重力模块初始化成功，检测到本地已登录账号: ${this.accountEmail}`)
    } catch (err: any) {
      this.ctx.log(`反重力本地凭据检测提示: ${err.message}`)
    }
  }

  async listModels(): Promise<ModuleModelInfo[]> {
    let token: string | null = null
    try {
      token = await antigravityAuth.getAccessToken()
    } catch {}
    return getDynamicAntigravityModels(token, { forceRefresh: true })
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
      if (result.status === 429) {
        const retryAfterSec = result.retryAfterMs
          ? Math.max(1, Math.ceil(result.retryAfterMs / 1000))
          : DEFAULT_RETRY_AFTER_SEC
        res.setHeader('Retry-After', String(retryAfterSec))
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
    let accessToken: string
    try {
      accessToken = await antigravityAuth.getAccessToken()
    } catch (err: any) {
      return {
        committed: false,
        status: 401,
        retryable: true,
        errorType: 'authentication_error',
        message: `反重力免密认证失败: ${err.message}。请确保本机已安装并登录反重力 (Antigravity) 桌面端。`,
      }
    }

    // 确保动态模型映射表与项目 ID 已预热（命中缓存时零额外延迟）
    await getDynamicAntigravityModels(accessToken)
    const rawModel = targetModel || request.model || resolveUpstreamModel('')
    const upstreamModel = resolveUpstreamModel(rawModel)
    const bucket = getQuotaBucket(upstreamModel)
    const { projectId } = await fetchLiveProjectAndTier(accessToken)

    const geminiBody = toGeminiRequest(request, {
      thoughtSignatureByToolId: this.toolThoughtSignatures,
      fallbackThoughtSignature: upstreamModel.toLowerCase().includes('gemini')
        ? 'skip_thought_signature_validator'
        : undefined,
    })
    const maxAllowedOut = getModelMaxOutputTokens(upstreamModel)
    if (
      maxAllowedOut &&
      geminiBody.generationConfig?.maxOutputTokens &&
      geminiBody.generationConfig.maxOutputTokens > maxAllowedOut
    ) {
      geminiBody.generationConfig.maxOutputTokens = maxAllowedOut
    }

    const effectiveMaxOut = geminiBody.generationConfig?.maxOutputTokens ?? maxAllowedOut
    if (
      effectiveMaxOut &&
      geminiBody.generationConfig?.thinkingConfig?.thinkingBudget !== undefined &&
      geminiBody.generationConfig.thinkingConfig.thinkingBudget >= effectiveMaxOut
    ) {
      const cap = effectiveMaxOut
      const adjusted = cap > 1024 ? Math.max(1024, cap - 1024) : cap - 1
      if (adjusted > 0) {
        geminiBody.generationConfig.thinkingConfig.thinkingBudget = adjusted
      } else {
        delete geminiBody.generationConfig.thinkingConfig
      }
    }

    let currentProjectId = projectId
    const buildPayload = () => ({
      project: currentProjectId,
      model: upstreamModel,
      request: geminiBody,
    })

    const isStream = !!request.stream
    const endpoint = isStream
      ? `${ANTIGRAVITY_API_HOST}/v1internal:streamGenerateContent?alt=sse`
      : `${ANTIGRAVITY_API_HOST}/v1internal:generateContent`

    const abortCtrl = new AbortController()
    const onResClose = () => {
      if (!res.writableEnded) {
        abortCtrl.abort()
      }
    }
    res.on('close', onResClose)

    let slotAcquired = false
    try {
      await this.acquireSlot(abortCtrl.signal)
      slotAcquired = true

      let upstreamRes: Response | null = null
      let lastErrText = ''

      for (let attempt = 0; attempt <= 1; attempt++) {
        await this.waitDispatchWindow(bucket, abortCtrl.signal)

        try {
          upstreamRes = await fetch(endpoint, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
              ...(isStream ? { Accept: 'text/event-stream' } : {}),
              'User-Agent': getAntigravityUserAgent(),
            },
            body: JSON.stringify(buildPayload()),
            signal: abortCtrl.signal,
          })
        } catch (err: any) {
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
          if (attempt === 0) {
            await sleepAbortable(700, abortCtrl.signal)
            continue
          }
          return {
            committed: false,
            status: 502,
            retryable: true,
            errorType: 'api_error',
            message: `连接反重力端点失败: ${err.message}`,
          }
        }

        if (upstreamRes.ok) break

        lastErrText = await upstreamRes.text().catch(() => '')
        const status = upstreamRes.status

        // 401 时使认证与模型/项目缓存失效并刷新重取一次
        if (status === 401 && attempt === 0) {
          this.ctx.log(`反重力鉴权失败 (401) [model: ${upstreamModel}]，清理缓存后刷新凭据重试一次`)
          antigravityAuth.invalidate()
          try {
            accessToken = await antigravityAuth.getAccessToken()
            const refreshedProject = await fetchLiveProjectAndTier(accessToken, true)
            currentProjectId = refreshedProject.projectId
            continue
          } catch (refreshErr: any) {
            return {
              committed: false,
              status: 401,
              retryable: true,
              errorType: 'authentication_error',
              message: `反重力凭据刷新失败: ${refreshErr?.message ?? String(refreshErr)}`,
            }
          }
        }

        if (status === 429) {
          const hintedMs = parseRetryDelayMs(upstreamRes, lastErrText)
          const cooldownMs = Math.max(hintedMs ?? 0, DEFAULT_RETRY_AFTER_SEC * 1000)
          this.bucketRateLimitUntil.set(
            bucket,
            Math.max(this.bucketRateLimitUntil.get(bucket) ?? 0, Date.now() + cooldownMs)
          )

          // 参考 cc-switch：仅当上游明确给出极短退避 (<= 2.5s) 时允许一次微重试，否则立即返回交由路由器熔断并切换配额桶
          if (attempt === 0 && hintedMs !== null && hintedMs <= MICRO_RETRY_MAX_MS) {
            this.ctx.log(
              `反重力触发短限流 (429) [model: ${upstreamModel}, bucket: ${bucket}]，等待 ${hintedMs}ms 后微重试一次`
            )
            await sleepAbortable(hintedMs, abortCtrl.signal)
            continue
          }

          const errSummary = lastErrText.replace(/\s+/g, ' ').trim().slice(0, 200)
          this.ctx.log(
            `反重力请求限流 (429) [model: ${upstreamModel}, bucket: ${bucket}]${errSummary ? `: ${errSummary}` : ''}，交由路由器切换备用节点`
          )
          return {
            committed: false,
            status: 429,
            retryable: true,
            retryAfterMs: cooldownMs,
            errorType: 'rate_limit_error',
            message: `反重力上游限流 (429): ${lastErrText}`,
          }
        }

        const retryable = isRetryableHttpStatus(status)
        if (retryable && attempt === 0 && (status === 502 || status === 503 || status === 529)) {
          this.ctx.log(`反重力上游临时错误 (${status}) [model: ${upstreamModel}]，800ms 后重试一次`)
          await sleepAbortable(800, abortCtrl.signal)
          continue
        }

        this.ctx.log(`反重力请求失败 (${status}) [model: ${upstreamModel}]: ${lastErrText}`)
        return {
          committed: false,
          status,
          retryable,
          errorType: errorTypeForStatus(status),
          message: `反重力上游错误 (${status}): ${lastErrText}`,
        }
      }

      if (!upstreamRes) {
        return {
          committed: false,
          status: 502,
          retryable: true,
          errorType: 'api_error',
          message: '反重力上游未返回有效响应',
        }
      }

      const messageId = `msg_${randomUUID().replace(/-/g, '')}`

      if (isStream) {
        let streamStarted = false
        let currentBlockIndex = -1
        let activeBlock: 'none' | 'thinking' | 'text' = 'none'
        let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn'
        let totalInputTokens = 0
        let upstreamOutputTokens = 0
        let estimatedOutputTokens = 0
        let hasValidFrame = false
        let emittedVisibleOrTool = false
        let lastFinishReason = ''
        let lastBlockReason = ''
        let firstStreamError: { status: number; message: string } | null = null
        let postStartStreamError: { status: number; message: string } | null = null
        let turnThoughtSignature: string | undefined

        const sendSse = (event: string, data: Record<string, unknown>) => {
          const rawRes = res as unknown as {
            writableEnded?: boolean
            destroyed?: boolean
            writable?: boolean
          }
          if (rawRes.writableEnded || rawRes.destroyed || rawRes.writable === false) return
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        }

        const ensureStreamStarted = () => {
          if (streamStarted) return
          streamStarted = true
          res.statusCode = 200
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
          res.setHeader('Cache-Control', 'no-cache')
          res.setHeader('Connection', 'keep-alive')
          if (typeof (res as any).flushHeaders === 'function') (res as any).flushHeaders()

          sendSse('message_start', {
            type: 'message_start',
            message: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              content: [],
              model: request.model,
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          })
        }

        const closeActiveBlock = () => {
          if (activeBlock !== 'none') {
            sendSse('content_block_stop', {
              type: 'content_block_stop',
              index: currentBlockIndex,
            })
            activeBlock = 'none'
          }
        }

        const handleParsedFrame = (parsed: any) => {
          if (!parsed || typeof parsed !== 'object') return

          if (parsed.error) {
            const errStatus = normalizeAntigravityErrorStatus(parsed.error)
            const errMsg = parsed.error.message || JSON.stringify(parsed.error)
            this.ctx.log(`反重力流内返回错误帧 (${errStatus}) [model: ${upstreamModel}]: ${errMsg}`)
            if (!streamStarted) {
              firstStreamError = { status: errStatus, message: errMsg }
            } else {
              closeActiveBlock()
              sendSse('error', {
                type: 'error',
                error: { type: errorTypeForStatus(errStatus), message: errMsg },
              })
              postStartStreamError = { status: errStatus, message: errMsg }
            }
            return
          }

          const resp = parsed.response ?? parsed
          if (!resp || typeof resp !== 'object') return

          if (resp.promptFeedback?.blockReason) {
            lastBlockReason = String(resp.promptFeedback.blockReason)
          }

          const candidate = resp.candidates?.[0]
          const parts = candidate?.content?.parts

          if (candidate || resp.usageMetadata || resp.promptFeedback) {
            hasValidFrame = true
          }

          if (resp.usageMetadata) {
            if (typeof resp.usageMetadata.promptTokenCount === 'number') {
              totalInputTokens = resp.usageMetadata.promptTokenCount
            }
            const candTok = resp.usageMetadata.candidatesTokenCount ?? 0
            const thoughtTok = resp.usageMetadata.thoughtsTokenCount ?? 0
            if (candTok + thoughtTok > 0) {
              upstreamOutputTokens = candTok + thoughtTok
            }
          }

          if (candidate?.finishReason) {
            lastFinishReason = String(candidate.finishReason)
            if (candidate.finishReason === 'MAX_TOKENS' && stopReason !== 'tool_use') {
              stopReason = 'max_tokens'
            }
          }

          if (!Array.isArray(parts) || parts.length === 0) return

          ensureStreamStarted()

          for (const part of parts) {
            if (!part || typeof part !== 'object') continue

            if (typeof part.thoughtSignature === 'string' && part.thoughtSignature) {
              turnThoughtSignature = part.thoughtSignature
            }

            // 1. Thinking / Text 内容块（注意：不把 Google thoughtSignature 伪装成 Anthropic signature_delta 发射给客户端，避免解码失败）
            if (typeof part.text === 'string' && part.text.length > 0) {
              if (part.thought === true) {
                if (activeBlock !== 'thinking') {
                  closeActiveBlock()
                  currentBlockIndex++
                  sendSse('content_block_start', {
                    type: 'content_block_start',
                    index: currentBlockIndex,
                    content_block: { type: 'thinking', thinking: '' },
                  })
                  activeBlock = 'thinking'
                }
                estimatedOutputTokens += Math.max(1, Math.ceil(part.text.length / 3))
                sendSse('content_block_delta', {
                  type: 'content_block_delta',
                  index: currentBlockIndex,
                  delta: { type: 'thinking_delta', thinking: part.text },
                })
                emittedVisibleOrTool = true
              } else {
                if (activeBlock !== 'text') {
                  closeActiveBlock()
                  currentBlockIndex++
                  sendSse('content_block_start', {
                    type: 'content_block_start',
                    index: currentBlockIndex,
                    content_block: { type: 'text', text: '' },
                  })
                  activeBlock = 'text'
                }
                estimatedOutputTokens += Math.max(1, Math.ceil(part.text.length / 3))
                sendSse('content_block_delta', {
                  type: 'content_block_delta',
                  index: currentBlockIndex,
                  delta: { type: 'text_delta', text: part.text },
                })
                emittedVisibleOrTool = true
              }
            }

            // 2. 函数调用块 (Tool Use)，并缓存 Google thoughtSignature（优先取 part 自身，缺失时回退本轮前置 thought 签名）
            if (part.functionCall && typeof part.functionCall === 'object') {
              closeActiveBlock()
              stopReason = 'tool_use'
              currentBlockIndex++
              const toolUseId = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`
              const fcSig =
                typeof part.thoughtSignature === 'string' && part.thoughtSignature
                  ? part.thoughtSignature
                  : turnThoughtSignature
              if (fcSig) {
                this.cacheThoughtSignature(toolUseId, fcSig)
              }
              const argsJson = JSON.stringify(part.functionCall.args ?? {})
              estimatedOutputTokens += Math.max(1, Math.ceil(argsJson.length / 3)) + 10

              sendSse('content_block_start', {
                type: 'content_block_start',
                index: currentBlockIndex,
                content_block: {
                  type: 'tool_use',
                  id: toolUseId,
                  name: part.functionCall.name,
                  input: {},
                },
              })

              sendSse('content_block_delta', {
                type: 'content_block_delta',
                index: currentBlockIndex,
                delta: {
                  type: 'input_json_delta',
                  partial_json: argsJson,
                },
              })

              sendSse('content_block_stop', {
                type: 'content_block_stop',
                index: currentBlockIndex,
              })
              emittedVisibleOrTool = true
            }
          }
        }

        const reader = upstreamRes.body?.getReader()
        const decoder = new TextDecoder('utf8')
        let sseBuffer = ''
        let rawJsonFallback = ''

        const processLine = (rawLine: string) => {
          const line = rawLine.trim()
          if (!line || line.startsWith(':')) return

          if (line.startsWith('data:')) {
            const dataPayload = line.slice(5).trim()
            if (!dataPayload || dataPayload === '[DONE]') return
            try {
              handleParsedFrame(JSON.parse(dataPayload))
            } catch (err: any) {
              this.ctx.log(`反重力 SSE JSON 解析异常: ${err.message}`)
            }
            return
          }

          // 兼容非 SSE JSON 数组流兜底
          if (line.startsWith('{') || rawJsonFallback.length > 0) {
            rawJsonFallback += line
            try {
              const cleaned = rawJsonFallback.replace(/,\s*$/, '')
              const parsed = JSON.parse(cleaned)
              rawJsonFallback = ''
              handleParsedFrame(parsed)
            } catch {
              // 尚未形成完整 JSON 对象，等待后续行
            }
          }
        }

        if (reader) {
          try {
            while (true) {
              if (abortCtrl.signal.aborted) {
                await reader.cancel().catch(() => {})
                return {
                  committed: false,
                  aborted: true,
                  status: 499,
                  retryable: false,
                  errorType: 'api_error',
                  message: '客户端已断开连接',
                }
              }
              const { done, value } = await reader.read()
              if (done) {
                sseBuffer += decoder.decode()
                break
              }
              sseBuffer += decoder.decode(value, { stream: true })
              const lines = sseBuffer.split(/\r?\n/)
              sseBuffer = lines.pop() ?? ''
              for (const line of lines) {
                processLine(line)
                if (postStartStreamError || firstStreamError) break
              }
              if (postStartStreamError || firstStreamError) {
                await reader.cancel().catch(() => {})
                break
              }
            }
            if (!postStartStreamError && !firstStreamError && sseBuffer.trim()) {
              processLine(sseBuffer)
            }
          } catch (readErr) {
            await reader.cancel().catch(() => {})
            throw readErr
          } finally {
            try {
              reader.releaseLock()
            } catch {}
          }
        }

        if (postStartStreamError) {
          if (!res.writableEnded) res.end()
          throw new Error(postStartStreamError.message)
        }

        if (!streamStarted && firstStreamError) {
          let retryAfterMs: number | undefined
          if (firstStreamError.status === 429) {
            retryAfterMs = DEFAULT_RETRY_AFTER_SEC * 1000
            this.bucketRateLimitUntil.set(
              bucket,
              Math.max(this.bucketRateLimitUntil.get(bucket) ?? 0, Date.now() + retryAfterMs)
            )
          }
          return {
            committed: false,
            status: firstStreamError.status,
            retryable: isRetryableHttpStatus(firstStreamError.status),
            ...(retryAfterMs ? { retryAfterMs } : {}),
            errorType: errorTypeForStatus(firstStreamError.status),
            message: `反重力流式响应错误 (${firstStreamError.status}): ${firstStreamError.message}`,
          }
        }

        if (!streamStarted && !hasValidFrame) {
          this.ctx.log(`反重力返回空流式响应 [model: ${upstreamModel}]，交由路由器尝试切换节点`)
          return {
            committed: false,
            status: 502,
            retryable: true,
            errorType: 'api_error',
            message: '反重力上游返回空响应流（未包含有效候选内容）',
          }
        }

        ensureStreamStarted()

        if (!emittedVisibleOrTool && (lastBlockReason || (lastFinishReason && lastFinishReason !== 'STOP'))) {
          const reasonDetail = lastBlockReason || lastFinishReason
          this.ctx.log(
            `反重力空内容结束 [model: ${upstreamModel}, reason: ${reasonDetail}]，已补充可读说明防止客户端空解码`
          )
          currentBlockIndex++
          sendSse('content_block_start', {
            type: 'content_block_start',
            index: currentBlockIndex,
            content_block: { type: 'text', text: '' },
          })
          activeBlock = 'text'
          sendSse('content_block_delta', {
            type: 'content_block_delta',
            index: currentBlockIndex,
            delta: { type: 'text_delta', text: `[上游未返回可显示内容，结束原因: ${reasonDetail}]` },
          })
        }

        closeActiveBlock()

        const finalOutputTokens =
          upstreamOutputTokens > 0 ? upstreamOutputTokens : estimatedOutputTokens

        sendSse('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: {
            ...(totalInputTokens > 0 ? { input_tokens: totalInputTokens } : {}),
            output_tokens: finalOutputTokens,
          },
        })

        sendSse('message_stop', { type: 'message_stop' })
        res.end()
        return { committed: true }
      } else {
        // 非流式
        const data = (await upstreamRes.json()) as any
        if (data?.error) {
          const errStatus = normalizeAntigravityErrorStatus(data.error)
          return {
            committed: false,
            status: errStatus,
            retryable: isRetryableHttpStatus(errStatus),
            errorType: errorTypeForStatus(errStatus),
            message: `反重力响应错误 (${errStatus}): ${data.error.message || JSON.stringify(data.error)}`,
          }
        }

        const resp = data.response ?? data
        const candidate = resp.candidates?.[0]
        const parts = candidate?.content?.parts ?? []

        const content: Array<Record<string, unknown>> = []
        let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' =
          candidate?.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn'
        let nonStreamTurnThoughtSig: string | undefined

        for (const part of parts) {
          if (!part || typeof part !== 'object') continue
          if (typeof part.thoughtSignature === 'string' && part.thoughtSignature) {
            nonStreamTurnThoughtSig = part.thoughtSignature
          }
          if (typeof part.text === 'string' && part.text) {
            if (part.thought === true) {
              content.push({
                type: 'thinking',
                thinking: part.text,
              })
            } else {
              content.push({ type: 'text', text: part.text })
            }
          }
          if (part.functionCall && typeof part.functionCall === 'object') {
            stopReason = 'tool_use'
            const toolUseId = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`
            const fcSig =
              typeof part.thoughtSignature === 'string' && part.thoughtSignature
                ? part.thoughtSignature
                : nonStreamTurnThoughtSig
            if (fcSig) {
              this.cacheThoughtSignature(toolUseId, fcSig)
            }
            content.push({
              type: 'tool_use',
              id: toolUseId,
              name: part.functionCall.name,
              input: part.functionCall.args ?? {},
            })
          }
        }

        if (content.length === 0) {
          const reason = resp.promptFeedback?.blockReason || candidate?.finishReason || 'EMPTY_RESPONSE'
          if (!candidate) {
            return {
              committed: false,
              status: 502,
              retryable: true,
              errorType: 'api_error',
              message: `反重力非流式响应为空 (${reason})`,
            }
          }
          content.push({ type: 'text', text: `[上游未返回内容，结束原因: ${reason}]` })
        }

        const usageMeta = resp.usageMetadata ?? {}
        const inputTokens = typeof usageMeta.promptTokenCount === 'number' ? usageMeta.promptTokenCount : 0
        const outputTokens =
          (usageMeta.candidatesTokenCount ?? 0) + (usageMeta.thoughtsTokenCount ?? 0) || 50

        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(
          JSON.stringify({
            id: messageId,
            type: 'message',
            role: 'assistant',
            content,
            model: request.model,
            stop_reason: stopReason,
            stop_sequence: null,
            usage: {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
            },
          })
        )
        return { committed: true }
      }
    } catch (err: any) {
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
        return {
          committed: false,
          status: 502,
          retryable: true,
          errorType: 'api_error',
          message: err?.message ?? String(err),
        }
      }
      throw err
    } finally {
      res.off('close', onResClose)
      if (slotAcquired) this.releaseSlot()
    }
  }

  private async fetchLiveUserStatus(): Promise<any | null> {
    const daemonDir = join(homedir(), '.gemini', 'antigravity', 'daemon')
    if (!existsSync(daemonDir)) return null

    try {
      const hubFiles = readdirSync(daemonDir)
        .filter((f) => f.startsWith('hub_') && f.endsWith('.json'))
        .map((f) => {
          const full = join(daemonDir, f)
          return { full, mtime: statSync(full).mtimeMs }
        })
        .sort((a, b) => b.mtime - a.mtime)

      if (hubFiles.length === 0) return null

      for (const hub of hubFiles) {
        try {
          const info = JSON.parse(readFileSync(hub.full, 'utf8'))
          if (!info.httpPort || !info.csrfToken) continue

          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 1200)
          const res = await fetch(
            `http://127.0.0.1:${info.httpPort}/exa.language_server_pb.LanguageServerService/GetUserStatus`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-codeium-csrf-token': info.csrfToken,
              },
              body: JSON.stringify({}),
              signal: controller.signal,
            }
          )
          clearTimeout(timer)
          if (res.ok) {
            const data = await res.json()
            return data?.userStatus ?? null
          }
        } catch {}
      }
    } catch {}
    return null
  }

  async getStatus(): Promise<ModuleStatus> {
    try {
      const email = await antigravityAuth.getAccountEmail()
      let balanceText = '已授权反重力账号'
      try {
        const liveStatus = await this.fetchLiveUserStatus()
        if (liveStatus?.userTier?.name) {
          balanceText = liveStatus.userTier.name
          const credits = liveStatus.planStatus?.planInfo?.monthlyPromptCredits
          if (typeof credits === 'number') {
            balanceText += ` (${credits.toLocaleString()} Credits)`
          }
        }
      } catch {}

      return {
        online: true,
        account: email || '已登录反重力',
        balance: balanceText,
      }
    } catch (err: any) {
      return {
        online: false,
        account: '未检测到登录态',
        balance: err.message,
      }
    }
  }
}
