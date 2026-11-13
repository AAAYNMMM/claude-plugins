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
  AnthropicRequest,
} from '../../core/types.ts'
import {
  ANTIGRAVITY_API_HOST,
  fetchLiveProjectAndTier,
  getAntigravityUserAgent,
  getDynamicAntigravityModels,
  getModelMaxOutputTokens,
  resolveUpstreamModel,
} from './models.ts'
import { toGeminiRequest } from './gemini-converter.ts'
import { errorPayload, errorTypeForStatus } from '../../core/protocol/anthropic.ts'
import { antigravityAuth } from './auth.ts'

const MAX_CONCURRENT_REQUESTS = 2
const MIN_DISPATCH_GAP_MS = 250
const RETRY_BACKOFF_MS = [2500, 5000, 9000, 14000, 20000]
const MAX_UPSTREAM_RETRIES = RETRY_BACKOFF_MS.length
const MAX_RETRY_DELAY_MS = 25_000
const DEFAULT_RETRY_AFTER_SEC = 30

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

export class AntigravityModule implements GatewayModule {
  readonly id = 'antigravity'
  readonly name = '反重力 (Antigravity)'
  readonly description = '反重力桌面端免密桥接 (动态模型同步)'

  private ctx!: ModuleContext
  private accountEmail: string = ''
  private inFlight = 0
  private waitQueue: Array<() => void> = []
  private nextDispatchAt = 0
  private rateLimitUntil = 0

  private async acquireSlot(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    if (this.inFlight >= MAX_CONCURRENT_REQUESTS) {
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
    this.inFlight++
  }

  private releaseSlot(): void {
    this.inFlight = Math.max(0, this.inFlight - 1)
    const next = this.waitQueue.shift()
    if (next) next()
  }

  private async waitDispatchWindow(signal: AbortSignal): Promise<void> {
    const now = Date.now()
    const slotAt = Math.max(now, this.nextDispatchAt, this.rateLimitUntil)
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
    _context: RequestContext,
    targetModel?: string
  ): Promise<void> {
    let accessToken: string
    try {
      accessToken = await antigravityAuth.getAccessToken()
    } catch (err: any) {
      res.statusCode = 401
      res.setHeader('Content-Type', 'application/json')
      res.end(
        errorPayload(
          'authentication_error',
          `反重力免密认证失败: ${err.message}。请确保本机已安装并登录反重力 (Antigravity) 桌面端。`
        )
      )
      return
    }

    // 确保动态模型映射表与项目 ID 已预热（命中缓存时零额外延迟）
    await getDynamicAntigravityModels(accessToken)
    const rawModel = targetModel || request.model || resolveUpstreamModel('')
    const upstreamModel = resolveUpstreamModel(rawModel)
    const { projectId } = await fetchLiveProjectAndTier(accessToken)

    const geminiBody = toGeminiRequest(request)
    const maxAllowedOut = getModelMaxOutputTokens(upstreamModel)
    if (
      maxAllowedOut &&
      geminiBody.generationConfig?.maxOutputTokens &&
      geminiBody.generationConfig.maxOutputTokens > maxAllowedOut
    ) {
      geminiBody.generationConfig.maxOutputTokens = maxAllowedOut
    }

    const payload = {
      project: projectId,
      model: upstreamModel,
      userAgent: 'antigravity',
      requestType: 'agent',
      request: geminiBody,
    }

    const isStream = !!request.stream
    const endpoint = isStream
      ? `${ANTIGRAVITY_API_HOST}/v1internal:streamGenerateContent`
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

      for (let attempt = 0; attempt <= MAX_UPSTREAM_RETRIES; attempt++) {
        await this.waitDispatchWindow(abortCtrl.signal)

        try {
          upstreamRes = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
              'User-Agent': getAntigravityUserAgent(),
            },
            body: JSON.stringify(payload),
            signal: abortCtrl.signal,
          })
        } catch (err: any) {
          if (abortCtrl.signal.aborted) return
          if (attempt < MAX_UPSTREAM_RETRIES) {
            const delayMs = 1000 * (attempt + 1) + Math.floor(Math.random() * 400)
            this.ctx.log(`连接反重力端点异常，${delayMs}ms 后第 ${attempt + 1} 次重试 [model: ${upstreamModel}]: ${err.message}`)
            await sleepAbortable(delayMs, abortCtrl.signal)
            continue
          }
          res.statusCode = 502
          res.setHeader('Content-Type', 'application/json')
          res.end(errorPayload('api_error', `连接反重力端点失败: ${err.message}`))
          return
        }

        if (upstreamRes.ok) break

        lastErrText = await upstreamRes.text()
        const status = upstreamRes.status
        const isRetryable = status === 429 || status === 502 || status === 503 || status === 529

        if (status === 429) {
          const hintedMs = parseRetryDelayMs(upstreamRes, lastErrText)
          const scheduledBase = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]
          const baseBackoff = scheduledBase + Math.floor(Math.random() * 500)
          const waitMs = Math.min(hintedMs ?? baseBackoff, MAX_RETRY_DELAY_MS)
          this.rateLimitUntil = Math.max(this.rateLimitUntil, Date.now() + waitMs)

          if (attempt < MAX_UPSTREAM_RETRIES) {
            this.ctx.log(
              `反重力触发限流 (429) [model: ${upstreamModel}]，冷却 ${waitMs}ms 后自动第 ${attempt + 1}/${MAX_UPSTREAM_RETRIES} 次重试`
            )
            await sleepAbortable(waitMs, abortCtrl.signal)
            continue
          }
        } else if (isRetryable && attempt < MAX_UPSTREAM_RETRIES) {
          const waitMs = Math.min(1200 * Math.pow(2, attempt) + Math.floor(Math.random() * 400), MAX_RETRY_DELAY_MS)
          this.ctx.log(
            `反重力上游临时错误 (${status}) [model: ${upstreamModel}]，${waitMs}ms 后自动重试 (${attempt + 1}/${MAX_UPSTREAM_RETRIES})`
          )
          await sleepAbortable(waitMs, abortCtrl.signal)
          continue
        }

        this.ctx.log(`反重力请求失败 (${status}) [model: ${upstreamModel}]: ${lastErrText}`)
        res.statusCode = status
        res.setHeader('Content-Type', 'application/json')
        if (status === 429) {
          const hintedMs = parseRetryDelayMs(upstreamRes, lastErrText)
          const retryAfterSec = hintedMs ? Math.max(1, Math.ceil(hintedMs / 1000)) : DEFAULT_RETRY_AFTER_SEC
          res.setHeader('Retry-After', String(retryAfterSec))
        }
        res.end(
          errorPayload(errorTypeForStatus(status), `反重力上游错误 (${status}): ${lastErrText}`)
        )
        return
      }

      if (!upstreamRes) return

    const messageId = `msg_${randomUUID().replace(/-/g, '')}`

    if (isStream) {
      // 流式处理：Google streamGenerateContent 返回一个不断输出的 JSON Array
      // 形如: [ \n { "response": { "candidates": [ ... ] } }, \n { ... } \n ]
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      if (typeof (res as any).flushHeaders === 'function') (res as any).flushHeaders()

      const sendSse = (event: string, data: Record<string, unknown>) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }

      // 1. message_start
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

      let currentBlockIndex = -1
      let activeBlock: 'none' | 'thinking' | 'text' = 'none'
      let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn'
      let totalInputTokens = 0
      let totalOutputTokens = 0

      const closeActiveBlock = () => {
        if (activeBlock !== 'none') {
          sendSse('content_block_stop', {
            type: 'content_block_stop',
            index: currentBlockIndex,
          })
          activeBlock = 'none'
        }
      }

      const reader = upstreamRes.body?.getReader()
      const decoder = new TextDecoder('utf8')
      let streamBuffer = ''

      if (reader) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          streamBuffer += decoder.decode(value, { stream: true })

          // 按 JSON 对象边界逐步提取解析
          while (true) {
            const startIdx = streamBuffer.indexOf('{\n  "response"') !== -1
              ? streamBuffer.indexOf('{\n  "response"')
              : streamBuffer.indexOf('{"response"')

            if (startIdx === -1) {
              const altIdx = streamBuffer.indexOf('{')
              if (altIdx === -1) {
                streamBuffer = ''
                break
              }
              if (altIdx > 0) {
                streamBuffer = streamBuffer.slice(altIdx)
              }
            } else if (startIdx > 0) {
              streamBuffer = streamBuffer.slice(startIdx)
            }

            // 寻找闭合的花括号
            let depth = 0
            let endIdx = -1
            let inString = false
            let escape = false

            for (let i = 0; i < streamBuffer.length; i++) {
              const ch = streamBuffer[i]
              if (escape) {
                escape = false
                continue
              }
              if (ch === '\\') {
                escape = true
                continue
              }
              if (ch === '"') {
                inString = !inString
                continue
              }
              if (!inString) {
                if (ch === '{') depth++
                else if (ch === '}') {
                  depth--
                  if (depth === 0) {
                    endIdx = i
                    break
                  }
                }
              }
            }

            if (endIdx === -1) break

            const jsonStr = streamBuffer.slice(0, endIdx + 1)
            streamBuffer = streamBuffer.slice(endIdx + 1)

            try {
              const parsed = JSON.parse(jsonStr)
              const resp = parsed.response ?? parsed
              const candidate = resp.candidates?.[0]
              const parts = candidate?.content?.parts

              // 记录精确 Token 统计
              if (resp.usageMetadata) {
                if (typeof resp.usageMetadata.promptTokenCount === 'number') {
                  totalInputTokens = resp.usageMetadata.promptTokenCount
                }
                const candTok = resp.usageMetadata.candidatesTokenCount ?? 0
                const thoughtTok = resp.usageMetadata.thoughtsTokenCount ?? 0
                if (candTok + thoughtTok > 0) {
                  totalOutputTokens = candTok + thoughtTok
                }
              }

              // 映射结束原因
              if (candidate?.finishReason === 'MAX_TOKENS' && stopReason !== 'tool_use') {
                stopReason = 'max_tokens'
              }

              if (Array.isArray(parts)) {
                for (const part of parts) {
                  // 1. Thinking 思考内容块 vs 正式 Text 文本内容块
                  if (typeof part.text === 'string' && part.text) {
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
                      totalOutputTokens += Math.ceil(part.text.length / 3)
                      sendSse('content_block_delta', {
                        type: 'content_block_delta',
                        index: currentBlockIndex,
                        delta: { type: 'thinking_delta', thinking: part.text },
                      })
                      if (typeof part.thoughtSignature === 'string' && part.thoughtSignature) {
                        sendSse('content_block_delta', {
                          type: 'content_block_delta',
                          index: currentBlockIndex,
                          delta: { type: 'signature_delta', signature: part.thoughtSignature },
                        })
                      }
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
                      totalOutputTokens += Math.ceil(part.text.length / 3)
                      sendSse('content_block_delta', {
                        type: 'content_block_delta',
                        index: currentBlockIndex,
                        delta: { type: 'text_delta', text: part.text },
                      })
                    }
                  }

                  // 2. 函数调用块 (Tool Use)
                  if (part.functionCall && typeof part.functionCall === 'object') {
                    closeActiveBlock()

                    stopReason = 'tool_use'
                    currentBlockIndex++
                    const toolUseId = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`
                    const argsJson = JSON.stringify(part.functionCall.args ?? {})
                    totalOutputTokens += Math.ceil(argsJson.length / 3) + 10

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
                  }
                }
              }
            } catch {}
          }
        }
      }

      // 如果有尚未关闭的内容块，在此闭合
      closeActiveBlock()

      // 4. message_delta & message_stop
      sendSse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: {
          ...(totalInputTokens > 0 ? { input_tokens: totalInputTokens } : {}),
          output_tokens: totalOutputTokens,
        },
      })

      sendSse('message_stop', { type: 'message_stop' })
      res.end()
    } else {
      // 非流式
      const data = (await upstreamRes.json()) as any
      const resp = data.response ?? data
      const candidate = resp.candidates?.[0]
      const parts = candidate?.content?.parts ?? []

      const content: Array<Record<string, unknown>> = []
      let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' =
        candidate?.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn'

      for (const part of parts) {
        if (typeof part.text === 'string' && part.text) {
          if (part.thought === true) {
            content.push({
              type: 'thinking',
              thinking: part.text,
              ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}),
            })
          } else {
            content.push({ type: 'text', text: part.text })
          }
        }
        if (part.functionCall && typeof part.functionCall === 'object') {
          stopReason = 'tool_use'
          content.push({
            type: 'tool_use',
            id: `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
            name: part.functionCall.name,
            input: part.functionCall.args ?? {},
          })
        }
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
    }
    } catch (err: any) {
      if (abortCtrl.signal.aborted) return
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
