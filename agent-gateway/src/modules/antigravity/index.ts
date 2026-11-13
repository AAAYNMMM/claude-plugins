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
import { ANTIGRAVITY_MODELS, resolveUpstreamModel } from './models.ts'
import { toGeminiRequest } from './gemini-converter.ts'
import { errorPayload } from '../../core/protocol/anthropic.ts'
import { antigravityAuth } from './auth.ts'

const ANTIGRAVITY_API_HOST = 'https://daily-cloudcode-pa.googleapis.com'
const PROJECT_ID = 'aicode-consumers'

export class AntigravityModule implements GatewayModule {
  readonly id = 'antigravity'
  readonly name = '反重力 (Antigravity)'
  readonly description = '反重力桌面端免密桥接 (Gemini 3.8 / Claude 4.6 / GPT-OSS 120B)'

  private ctx!: ModuleContext
  private accountEmail: string = ''

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
    return ANTIGRAVITY_MODELS
  }

  async handleRequest(
    request: AnthropicRequest,
    res: ServerResponse,
    _context: RequestContext,
    targetModel?: string
  ): Promise<void> {
    const rawModel = targetModel || request.model || 'gemini-3.8-flash'
    const upstreamModel = resolveUpstreamModel(rawModel)

    let accessToken: string
    try {
      accessToken = await antigravityAuth.getAccessToken()
    } catch (err: any) {
      res.statusCode = 401
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify(
          errorPayload(
            'authentication_error',
            `反重力免密认证失败: ${err.message}。请确保本机已安装并登录反重力 (Antigravity) 桌面端。`
          )
        )
      )
      return
    }

    const geminiBody = toGeminiRequest(request)
    const payload = {
      project: PROJECT_ID,
      model: upstreamModel,
      request: geminiBody,
    }

    const isStream = !!request.stream
    const endpoint = isStream
      ? `${ANTIGRAVITY_API_HOST}/v1internal:streamGenerateContent`
      : `${ANTIGRAVITY_API_HOST}/v1internal:generateContent`

    let upstreamRes: Response
    try {
      upstreamRes = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'antigravity/2.31.0',
        },
        body: JSON.stringify(payload),
      })
    } catch (err: any) {
      res.statusCode = 502
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(errorPayload('api_error', `连接反重力端点失败: ${err.message}`)))
      return
    }

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text()
      this.ctx.log(`反重力请求失败 (${upstreamRes.status}) [model: ${upstreamModel}]: ${errText}`)
      res.statusCode = upstreamRes.status
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(errorPayload('api_error', `反重力上游错误 (${upstreamRes.status}): ${errText}`)))
      return
    }

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
