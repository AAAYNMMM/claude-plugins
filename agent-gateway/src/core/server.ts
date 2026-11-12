/**
 * 本地网关 HTTP 核心服务：接收 Claude 请求，按模块分流。
 */

import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AnthropicRequest, GatewayConfig, RequestContext, RouteConfig } from './types.ts'
import type { ModuleHost } from './module-host.ts'
import { errorPayload } from './protocol/anthropic.ts'

export interface ServerOptions {
  config: GatewayConfig
  host: ModuleHost
  log: (msg: string) => void
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
  close: () => Promise<void>
  server: Server
} {
  const { config, host, log } = options

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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

    const url = new URL(req.url ?? '/', `http://${hostHeader}`)
    const path = url.pathname

    // 2. 状态查询端点
    if (path === '/status' || path === '/health') {
      const statuses = await host.collectStatuses()
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          status: 'ok',
          port: config.port,
          modules: statuses,
          routes: config.routes,
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
        res.end(JSON.stringify({ ok: false, error: err.message }))
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
      const valid = clientKey && clientKey.length === config.token.length &&
        timingSafeEqual(Buffer.from(clientKey), Buffer.from(config.token))
      if (!valid) {
        res.statusCode = 401
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(errorPayload('authentication_error', '网关本地令牌无效')))
        return
      }
    } else {
      // loopback 模式：必须有非空凭据
      if (!clientKey) {
        res.statusCode = 401
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(errorPayload('authentication_error', '缺少 Authorization 凭据')))
        return
      }
    }

    // 4.5. Token Counting API: POST /v1/messages/count_tokens（桌面端上下文百分比统计所需）
    if (path === '/v1/messages/count_tokens' && req.method === 'POST') {
      try {
        const rawBody = await readBody(req)
        const parsed = JSON.parse(rawBody) as AnthropicRequest
        let chars = 0
        if (typeof parsed.system === 'string') chars += parsed.system.length
        else if (Array.isArray(parsed.system)) {
          for (const s of parsed.system) chars += (s.text ?? '').length
        }
        if (Array.isArray(parsed.messages)) {
          for (const m of parsed.messages) {
            if (typeof m.content === 'string') chars += m.content.length
            else if (Array.isArray(m.content)) {
              for (const p of m.content as any[]) {
                if (p.text) chars += p.text.length
                else if (p.thinking) chars += p.thinking.length
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
        res.end(JSON.stringify(errorPayload('invalid_request_error', '无效的 count_tokens 请求体')))
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
        res.end(JSON.stringify(errorPayload('invalid_request_error', err.message)))
        return
      }

      let parsed: AnthropicRequest
      try {
        parsed = JSON.parse(rawBody)
      } catch {
        res.statusCode = 400
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(errorPayload('invalid_request_error', '请求体不是合法的 JSON')))
        return
      }

      const reqModel = parsed.model ?? ''
      const route: RouteConfig | undefined = config.routes[reqModel]

      const reqContext: RequestContext = {
        req,
        headers: req.headers,
        clientKey,
        log,
      }

      if (route) {
        const mod = host.getModule(route.module)
        if (mod) {
          log(`分流路由: 模型 "${reqModel}" -> 模块 [${mod.name}] (目标: ${route.targetModel ?? '默认'})`)
          try {
            await mod.handleRequest(parsed, res, reqContext, route.targetModel)
            return
          } catch (err: any) {
            log(`模块 [${mod.name}] 处理异常: ${err.message}`)
            if (!res.headersSent) {
              res.statusCode = 500
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify(errorPayload('api_error', err.message)))
            }
            return
          }
        }
      }

      // 未命中已知路由：智能回退（绝不把陌生的 claude-* 直接透传给不支持它的下游）
      if (reqModel.includes('antigravity') || reqModel.includes('gemini')) {
        const agy = host.getAntigravityModule()
        log(`未配置路由，回退到反重力模块: "${reqModel}"`)
        await agy.handleRequest(parsed, res, reqContext)
        return
      }

      if (reqModel.includes('deepseek')) {
        const pass = host.getPassthroughModule()
        log(`未配置路由，回退到直连透传: "${reqModel}"`)
        await pass.handleRequest(parsed, res, reqContext)
        return
      }

      // 若是后台发出的未登记 claude-* 请求（例如标题生成/摘要模型），智能映射到已登记的轻量或首条可用路由
      const routeValues = Object.values(config.routes)
      const fallbackRoute =
        (reqModel.includes('haiku')
          ? routeValues.find((r) => r.targetModel?.includes('flash') || r.label?.includes('Flash'))
          : undefined) ?? routeValues[0]

      if (fallbackRoute) {
        const mod = host.getModule(fallbackRoute.module)
        if (mod) {
          log(`未命中路由 "${reqModel}"，智能降级至 [${mod.name}] -> ${fallbackRoute.targetModel}`)
          await mod.handleRequest(parsed, res, reqContext, fallbackRoute.targetModel)
          return
        }
      }

      // 终极兜底
      const agy = host.getAntigravityModule()
      log(`无可用路由，终极兜底至反重力: "${reqModel}"`)
      await agy.handleRequest(parsed, res, reqContext)
      return
    }

    res.statusCode = 404
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(errorPayload('not_found_error', `不支持的路径: ${path}`)))
  })

  return {
    server,
    start: () =>
      new Promise<number>((resolve, reject) => {
        server.listen(config.port, '127.0.0.1', () => {
          const addr = server.address()
          const port = typeof addr === 'object' && addr ? addr.port : config.port
          log(`网关服务已启动: http://127.0.0.1:${port}`)
          resolve(port)
        })
        server.on('error', reject)
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}
