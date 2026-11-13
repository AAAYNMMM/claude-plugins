/**
 * 本地网关 HTTP 核心服务：接收 Claude 请求，按模块分流。
 */

import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AnthropicRequest, GatewayConfig, RequestContext, RouteConfig } from './types.ts'
import type { ModuleHost } from './module-host.ts'
import { GatewayRouter } from './router.ts'
import { errorPayload } from './protocol/anthropic.ts'

export interface ServerOptions {
  config: GatewayConfig
  host: ModuleHost
  log: (msg: string) => void
  buildStamp?: string
  readyPromise?: Promise<void>
  onSyncRequest?: () => Promise<Record<string, RouteConfig>>
}

const BODY_LIMIT = 64 * 1024 * 1024

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > BODY_LIMIT) throw new Error(`请求体积超限 (${BODY_LIMIT} bytes)`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function createGatewayServer(options: ServerOptions): {
  start: () => Promise<number>
  close: (forceAfterMs?: number) => Promise<void>
  server: Server
} {
  const { config, host, log } = options
  const router = new GatewayRouter()

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // 1. 安全检查：只允许 127.0.0.1 / localhost 访问
      const hostHeader = req.headers.host ?? ''
      if (!/^127\.0\.0\.1(:\d+)?$/.test(hostHeader) && !/^localhost(:\d+)?$/.test(hostHeader)) {
        res.statusCode = 403
        res.end('Forbidden: Invalid Host header')
        return
      }

      const origin = req.headers.origin
      if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
        res.statusCode = 403
        res.end('Forbidden: Cross-origin blocked')
        return
      }

      // CORS 支持：完整放行桌面端 Electron / Stainless SDK 所需请求头
      res.setHeader('Access-Control-Allow-Origin', origin ?? '*')
      const reqHeaders = req.headers['access-control-request-headers']
      res.setHeader(
        'Access-Control-Allow-Headers',
        typeof reqHeaders === 'string' && reqHeaders
          ? reqHeaders
          : 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access, x-app, x-stainless-lang, x-stainless-package-version, x-stainless-os, x-stainless-arch, x-stainless-runtime, x-stainless-runtime-version'
      )
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')

      if (req.method === 'OPTIONS') {
        res.statusCode = 204
        res.end()
        return
      }

      let url: URL
      try {
        url = new URL(req.url ?? '/', `http://${hostHeader}`)
      } catch {
        res.statusCode = 400
        res.setHeader('Content-Type', 'application/json')
        res.end(errorPayload('invalid_request_error', '无效的请求 URL'))
        return
      }
      const path = url.pathname

      // 2. 健康检查与状态查询端点
      if (path === '/health') {
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(
          JSON.stringify({
            status: 'ok',
            port: config.port,
            ...(options.buildStamp ? { buildStamp: options.buildStamp } : {}),
          })
        )
        return
      }

      if (path === '/status') {
        if (options.readyPromise) await options.readyPromise.catch(() => {})
        const statuses = await host.collectStatuses()
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(
          JSON.stringify({
            status: 'ok',
            port: config.port,
            ...(options.buildStamp ? { buildStamp: options.buildStamp } : {}),
            modules: statuses,
            routes: config.routes,
            breakers: router.getBreakerStats(),
          }, null, 2)
        )
        return
      }

      // 3. 模型列表端点
      if (path === '/v1/models') {
        const models = Object.entries(config.routes).map(([alias, r]) => ({
          id: alias,
          name: r.label ?? alias,
          module: r.module,
        }))
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ data: models }))
        return
      }

      // 3.5. 实时模型同步端点: 供启动/重启/会话 Hook 实时静默更新
      if ((path === '/v1/gateway/sync' || path === '/sync') && (req.method === 'GET' || req.method === 'POST')) {
        try {
          if (options.readyPromise) await options.readyPromise.catch(() => {})
          if (options.onSyncRequest) {
            const routes = await options.onSyncRequest()
            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: true, count: Object.keys(routes).length, routes }))
            return
          }
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: true, count: Object.keys(config.routes).length }))
          return
        } catch (err: any) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: err?.message ?? String(err) }))
          return
        }
      }

      // 4. 鉴权提取
      const authHeader = req.headers.authorization ?? ''
      const apiKeyHeader = req.headers['x-api-key'] ?? ''
      let clientKey = typeof apiKeyHeader === 'string' && apiKeyHeader ? apiKeyHeader : ''
      if (!clientKey && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
        clientKey = authHeader.slice(7).trim()
      }

      if (config.authMode === 'token') {
        const keyBuf = Buffer.from(clientKey, 'utf8')
        const tokenBuf = Buffer.from(config.token ?? '', 'utf8')
        const valid = Boolean(clientKey) && keyBuf.length === tokenBuf.length && timingSafeEqual(keyBuf, tokenBuf)
        if (!valid) {
          res.statusCode = 401
          res.setHeader('Content-Type', 'application/json')
          res.end(errorPayload('authentication_error', '网关本地令牌无效'))
          return
        }
      } else {
        // loopback 模式：必须有非空凭据
        if (!clientKey) {
          res.statusCode = 401
          res.setHeader('Content-Type', 'application/json')
          res.end(errorPayload('authentication_error', '缺少 Authorization 凭据'))
          return
        }
      }

      // 4.5. Token Counting API: POST /v1/messages/count_tokens（桌面端上下文百分比统计所需）
      if (path === '/v1/messages/count_tokens' && req.method === 'POST') {
        try {
          const rawBody = await readBody(req)
          const parsed = JSON.parse(rawBody) as AnthropicRequest
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(errorPayload('invalid_request_error', 'count_tokens 请求体必须是 JSON 对象'))
            return
          }
          let chars = 0
          if (typeof parsed.system === 'string') chars += parsed.system.length
          else if (Array.isArray(parsed.system)) {
            for (const s of parsed.system) {
              if (s && typeof s.text === 'string') chars += s.text.length
            }
          }
          if (Array.isArray(parsed.messages)) {
            for (const m of parsed.messages) {
              if (!m || typeof m !== 'object') continue
              if (typeof m.content === 'string') chars += m.content.length
              else if (Array.isArray(m.content)) {
                for (const p of m.content as any[]) {
                  if (!p || typeof p !== 'object') continue
                  if (typeof p.text === 'string') chars += p.text.length
                  else if (typeof p.thinking === 'string') chars += p.thinking.length
                  else if (p.input) chars += JSON.stringify(p.input).length
                  else if (typeof p.content === 'string') chars += p.content.length
                  else if (Array.isArray(p.content)) chars += JSON.stringify(p.content).length
                  else if (p.type === 'image') chars += 1600
                }
              }
            }
          }
          if (Array.isArray(parsed.tools)) chars += JSON.stringify(parsed.tools).length
          const inputTokens = Math.max(1, Math.ceil(chars / 3))
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ input_tokens: inputTokens }))
        } catch {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json')
          res.end(errorPayload('invalid_request_error', '无效的 count_tokens 请求体'))
        }
        return
      }

      // 5. 核心对话端点 POST /v1/messages
      if (path === '/v1/messages' && req.method === 'POST') {
        let rawBody = ''
        try {
          rawBody = await readBody(req)
        } catch (err: any) {
          res.statusCode = 413
          res.setHeader('Content-Type', 'application/json')
          res.end(errorPayload('invalid_request_error', err?.message ?? '请求体积超限'))
          return
        }

        let parsed: any
        try {
          parsed = JSON.parse(rawBody)
        } catch {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json')
          res.end(errorPayload('invalid_request_error', '请求体不是合法的 JSON'))
          return
        }

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json')
          res.end(errorPayload('invalid_request_error', '请求体必须是 JSON 对象'))
          return
        }

        if (!Array.isArray(parsed.messages)) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json')
          res.end(errorPayload('invalid_request_error', '请求体缺少有效的 messages 数组'))
          return
        }

        if (options.readyPromise) await options.readyPromise.catch(() => {})

        const reqContext: RequestContext = {
          req,
          headers: req.headers,
          clientKey,
          log,
        }

        await router.dispatchMessage(parsed as AnthropicRequest, res, reqContext, config, host, log)
        return
      }

      res.statusCode = 404
      res.setHeader('Content-Type', 'application/json')
      res.end(errorPayload('not_found_error', `不支持的路径: ${path}`))
    } catch (err: any) {
      log(`[HTTP] 未捕获请求异常: ${err?.stack ?? err?.message ?? String(err)}`)
      if (!res.headersSent) {
        try {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(errorPayload('api_error', '网关内部错误'))
        } catch {}
      } else if (!res.writableEnded) {
        try {
          res.end()
        } catch {}
      }
    }
  })

  return {
    server,
    start: () =>
      new Promise<number>((resolve, reject) => {
        const onError = (err: Error) => reject(err)
        server.once('error', onError)
        server.listen(config.port, '127.0.0.1', () => {
          server.off('error', onError)
          const addr = server.address()
          const port = typeof addr === 'object' && addr ? addr.port : config.port
          log(`网关服务已启动: http://127.0.0.1:${port}`)
          resolve(port)
        })
      }),
    close: (forceAfterMs = 500) =>
      new Promise<void>((resolve) => {
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          clearTimeout(forceTimer)
          clearTimeout(deadlineTimer)
          resolve()
        }

        server.closeIdleConnections?.()
        const forceTimer = setTimeout(() => {
          server.closeAllConnections?.()
        }, forceAfterMs)
        forceTimer.unref?.()

        const deadlineTimer = setTimeout(() => {
          server.closeAllConnections?.()
          done()
        }, forceAfterMs + 1500)
        deadlineTimer.unref?.()

        server.close(() => done())
      }),
  }
}
