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
  AnthropicRequest,
} from '../../core/types.ts'
import { errorPayload } from '../../core/protocol/anthropic.ts'

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
    _targetModel?: string
  ): Promise<void> {
    const upstreamUrl = `${this.targetUrl.replace(/\/+$/, '')}/v1/messages`
    const clientKey = context.clientKey

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    }
    if (clientKey) {
      headers['authorization'] = `Bearer ${clientKey}`
      headers['x-api-key'] = clientKey
    }

    let upstreamRes: Response
    try {
      upstreamRes = await fetch(upstreamUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
      })
    } catch (err: any) {
      res.statusCode = 502
      res.setHeader('Content-Type', 'application/json')
      res.end(errorPayload('api_error', `无法连接透传上游: ${err.message}`))
      return
    }

    res.statusCode = upstreamRes.status
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (!/content-encoding|content-length|transfer-encoding|connection/i.test(key)) {
        res.setHeader(key, value)
      }
    }

    if (upstreamRes.body) {
      const reader = upstreamRes.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(value)
      }
    }
    res.end()
  }

  async getStatus(): Promise<ModuleStatus> {
    return {
      online: true,
      account: this.targetUrl,
      balance: '以账户实际为准',
    }
  }
}
