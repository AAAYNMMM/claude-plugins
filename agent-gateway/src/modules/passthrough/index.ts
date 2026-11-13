/**
 * 直连透传子模块：负责原样转发到 DeepSeek 等 Anthropic 兼容端点。
 */

import type { ServerResponse } from 'node:http'
import type {
  GatewayModule,
  ModuleContext,
  ModuleModelInfo,
  ModuleStatus,
  RequestContext,
  RouteAttemptResult,
  AnthropicRequest,
} from '../../core/types.ts'
import { errorPayload, errorTypeForStatus } from '../../core/protocol/anthropic.ts'
import { isRetryableHttpStatus } from '../../core/router.ts'

export class PassthroughModule implements GatewayModule {
  readonly id = 'passthrough'
  readonly name = '直连透传 (DeepSeek/Anthropic)'
  readonly description = '直连转发到外部 Anthropic 协议兼容端点'

  private ctx!: ModuleContext
  private targetUrl: string = 'https://api.deepseek.com/anthropic'

  async init(context: ModuleContext): Promise<void> {
    this.ctx = context
  }

  setBaseUrl(url: string): void {
    this.targetUrl = url
  }

  async listModels(): Promise<ModuleModelInfo[]> {
    return [
      {
        id: 'claude-sonnet-5.5',
        name: 'DeepSeek Sonnet 兼容路由',
        recommendedAlias: 'claude-sonnet-5.5',
        labelOverride: 'DeepSeek · Sonnet (透传)',
        description: '原样透传至 DeepSeek 官方端点',
      },
    ]
  }

  async handleRequest(
    request: AnthropicRequest,
    res: ServerResponse,
    context: RequestContext,
    targetModel?: string
  ): Promise<void> {
    const result = await this.tryHandleRequest(request, res, context, targetModel)
    if (!result.committed && !res.headersSent && !result.aborted) {
      const status = Number.isInteger(result.status) && result.status >= 100 && result.status <= 599
        ? result.status
        : 502
      res.statusCode = status
      if (result.rawHeaders) {
        for (const [k, v] of Object.entries(result.rawHeaders)) {
          res.setHeader(k, v)
        }
      }
      if (result.rawBody !== undefined) {
        res.setHeader('Content-Type', result.rawContentType ?? 'application/json')
        res.end(result.rawBody)
      } else {
        res.setHeader('Content-Type', 'application/json')
        res.end(errorPayload(result.errorType ?? errorTypeForStatus(status), result.message))
      }
    }
  }

  async tryHandleRequest(
    request: AnthropicRequest,
    res: ServerResponse,
    context: RequestContext,
    targetModel?: string
  ): Promise<RouteAttemptResult> {
    const upstreamUrl = `${this.targetUrl.replace(/\/+$/, '')}/v1/messages`
    const clientKey = context.clientKey
    const outboundRequest =
      targetModel && targetModel !== request.model
        ? { ...request, model: targetModel }
        : request

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    }
    if (clientKey) {
      headers['authorization'] = `Bearer ${clientKey}`
      headers['x-api-key'] = clientKey
    }

    const abortCtrl = new AbortController()
    const onClientClose = () => {
      if (!res.writableEnded) {
        abortCtrl.abort()
      }
    }
    if (typeof (res as any).on === 'function') {
      res.on('close', onClientClose)
    }

    try {
      let upstreamRes: Response
      try {
        upstreamRes = await fetch(upstreamUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(outboundRequest),
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
        return {
          committed: false,
          status: 502,
          retryable: true,
          errorType: 'api_error',
          message: `无法连接透传上游: ${err?.message ?? String(err)}`,
        }
      }

      if (!upstreamRes.ok) {
        const errText = await upstreamRes.text().catch(() => '')
        const status = upstreamRes.status
        const rawHeaders: Record<string, string> = {}
        for (const [key, value] of upstreamRes.headers.entries()) {
          if (!/^(content-encoding|content-length|transfer-encoding|connection|content-type)$/i.test(key)) {
            rawHeaders[key] = value
          }
        }
        const rawContentType = upstreamRes.headers.get('content-type') ?? 'application/json'
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
          message: `透传上游错误 (${status}): ${errText}`,
          rawBody: errText,
          rawContentType,
          rawHeaders,
        }
      }

      res.statusCode = upstreamRes.status
      for (const [key, value] of upstreamRes.headers.entries()) {
        if (!/content-encoding|content-length|transfer-encoding|connection/i.test(key)) {
          res.setHeader(key, value)
        }
      }

      if (upstreamRes.body) {
        const reader = upstreamRes.body.getReader()
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
            if (done) break
            const rawRes = res as unknown as {
              writableEnded?: boolean
              destroyed?: boolean
              writable?: boolean
            }
            if (rawRes.writableEnded || rawRes.destroyed || rawRes.writable === false) {
              await reader.cancel().catch(() => {})
              return {
                committed: false,
                aborted: true,
                status: 499,
                retryable: false,
                errorType: 'api_error',
                message: '客户端响应流已关闭',
              }
            }
            res.write(value)
          }
        } catch (err: any) {
          await reader.cancel().catch(() => {})
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
          throw err
        } finally {
          try {
            reader.releaseLock()
          } catch {}
        }
      }

      if (!res.writableEnded) {
        res.end()
      }
      return { committed: true }
    } finally {
      if (typeof (res as any).off === 'function') {
        res.off('close', onClientClose)
      }
    }
  }

  async getStatus(): Promise<ModuleStatus> {
    return {
      online: true,
      account: this.targetUrl,
      balance: '以账户实际为准',
    }
  }
}
