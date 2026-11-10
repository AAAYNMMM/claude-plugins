/**
 * Claude Code 面向的本地网关：对外说 Anthropic Messages API，内部按模型名分流。
 *
 * 分流规则由配置里的 `routes` 决定，每条路由要么走 WorkBuddy（插件凭据），
 * 要么走 DeepSeek 的 Anthropic 兼容端点（原样转发，调用方的鉴权头一并转过去）。
 * 这样桌面 App 能在模型列表里同时列出两家模型，切换模型就等于切换提供方。
 *
 * 安全边界：
 *  - 只监听 127.0.0.1，并校验 Host 头，防止 DNS 重绑定；
 *  - 拒绝非回环的 Origin，防止网页跨站调用本机端口；
 *  - 鉴权有两种模式：
 *      token   —— 必须出示配置里的本地令牌（终端 Claude Code 用这一种）；
 *      loopback —— 桌面 App 的密钥是应用私有加密的、读不到，所以放宽为
 *                  “回环来源 + 非空 Authorization”即可，并把该凭据原样转发给
 *                  DeepSeek。代价是同机其它进程也能借用 WorkBuddy 额度。
 */

import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  collectAnthropic,
  errorPayload,
  errorTypeForStatus,
  estimateRequestTokens,
  streamAnthropic,
  toOpenAIRequest,
  type AnthRequest,
} from './anthropic.ts'

/** 一条模型路由：走哪家提供方，以及可选的 WorkBuddy 目标模型。 */
export interface Route {
  provider: 'workbuddy' | 'deepseek'
  /** provider 为 workbuddy 时使用的真实模型 id；缺省则用网关默认模型。 */
  model?: string
  /** 桌面 App 模型列表里显示的名字。 */
  label?: string
}

/** 网关启动参数。 */
export interface GatewayOptions {
  /**
   * 固定监听端口。
   *
   * 必须是固定值而不是随机端口：Claude Code 的 ANTHROPIC_BASE_URL 在会话启动
   * 前就写进了设置文件，网关每次重启换端口会让那条地址立刻失效。
   */
  port: number
  /** 本网关要求的本地令牌；authMode 为 token 时必填。 */
  token: string
  /** 鉴权模式，见文件头说明。 */
  authMode: 'token' | 'loopback'
  /** DeepSeek 的 Anthropic 兼容端点基址。 */
  deepseekBaseUrl: string
  /** 已启动的 shim 的基址（例如 http://127.0.0.1:39271）。 */
  shimBaseUrl: () => string
  /** shim 要求的进程内令牌。 */
  shimToken: () => string
  /** 当前的模型路由表。 */
  routes: () => Record<string, Route>
  /** 目录里的 WorkBuddy 模型 id，用于识别直接传真实模型名的请求。 */
  workbuddyModels: () => readonly string[]
  /** 把 Claude Code 送来的模型名解析成真正的 WorkBuddy 模型 id。 */
  resolveModel: (requested: string | undefined) => string
  /** 账号与积分等只读状态。 */
  status: () => Promise<Record<string, unknown>>
  /** 写日志。 */
  log: (message: string) => void
}

/** 网关句柄。 */
export interface Gateway {
  /** 监听成功后 resolve。 */
  ready: Promise<void>
  /** 关闭监听。 */
  close: () => Promise<void>
  /** 实际监听的端口。 */
  port: () => number
}

/** 请求体上限：Claude Code 会把截图以 base64 放进消息里，所以要留足空间。 */
const BODY_LIMIT = 64 * 1024 * 1024

/** 一次性把请求体读完；超过上限就直接报错。 */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > BODY_LIMIT) throw new Error(`request body exceeds ${BODY_LIMIT} bytes`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 常量时间比较两个字符串令牌。 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** 从请求头里取出调用方出示的凭据（原始值，用于转发给 DeepSeek）。 */
function presentedToken(req: IncomingMessage): string | undefined {
  const auth = req.headers['authorization']
  if (typeof auth === 'string' && auth.trim() !== '') return auth.trim()
  const key = req.headers['x-api-key']
  if (typeof key === 'string' && key.trim() !== '') return key.trim()
  return undefined
}

/** 写一条 Anthropic 格式的错误响应。 */
function fail(res: ServerResponse, status: number, message: string, type = errorTypeForStatus(status)): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(errorPayload(type, message))
}

/** 判断 Host 头是否指向回环地址；防止 DNS 重绑定把请求转到本网关。 */
function hostIsLoopback(host: string | undefined): boolean {
  if (typeof host !== 'string') return false
  const name = host.trim().toLowerCase()
  return name.startsWith('127.0.0.1:')
    || name.startsWith('localhost:')
    || name === '127.0.0.1'
    || name === 'localhost'
    || name.startsWith('[::1]:')
    || name === '[::1]'
}

/** 判断 Origin 是否为空或回环；网页跨站请求会被这里挡住。 */
function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return true
  try {
    const url = new URL(origin)
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  } catch {
    return false
  }
}

/** 从上游错误响应里抠出可读的消息。 */
function upstreamMessage(status: number, text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string }
    if (typeof parsed.error === 'string') return parsed.error
    if (parsed.error?.message !== undefined) return parsed.error.message
    if (typeof parsed.message === 'string') return parsed.message
  } catch {
    // 不是 JSON：按原文返回即可。
  }
  return `upstream returned HTTP ${status}: ${text.slice(0, 500)}`
}

/** 创建并启动网关。 */
export function createGateway(options: GatewayOptions): Gateway {
  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      options.log(`gateway: unhandled error: ${String(error)}`)
      fail(res, 500, String(error))
    })
  })

  let disposed = false

  /**
   * 按模型名决定走哪家提供方。
   *
   * 桌面 App 开着 `modelPrefer1mContext` 时会给模型名加 `[1m]` 之类的后缀，
   * 所以匹配路由表前先把方括号后缀去掉；转发给 DeepSeek 时仍用原始名字。
   */
  function routeFor(model: string | undefined): Route {
    const bare = typeof model === 'string' ? model.replace(/\[[^\]]*\]$/, '') : undefined
    const table = options.routes()
    if (bare !== undefined && bare !== '' && table[bare] !== undefined) return table[bare]
    if (bare !== undefined && options.workbuddyModels().includes(bare)) return { provider: 'workbuddy' }
    // 没登记过的 claude-* 保持原有行为：原样交给 DeepSeek。
    if (bare !== undefined && bare.startsWith('claude-')) return { provider: 'deepseek' }
    return { provider: 'workbuddy' }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostIsLoopback(req.headers['host'])) {
      fail(res, 403, 'the Host header must name the loopback interface', 'permission_error')
      return
    }
    if (!originAllowed(typeof req.headers['origin'] === 'string' ? req.headers['origin'] : undefined)) {
      fail(res, 403, 'cross-origin requests are not accepted', 'permission_error')
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.replace(/\/+$/, '') || '/'

    // 健康检查不要求令牌：安装脚本要靠它判断网关是否已经起来了。
    if (req.method === 'GET' && (path === '/health' || path === '/healthz')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, gateway: 'workbuddy-claude', authMode: options.authMode }))
      return
    }

    const presented = presentedToken(req)
    if (options.authMode === 'token') {
      if (presented === undefined || !tokenMatches(presented, options.token)) {
        fail(res, 401, 'missing or invalid local token; use the token in ~/.workbuddy-claude/config.json', 'authentication_error')
        return
      }
    } else if (presented === undefined) {
      // loopback 模式也要求一个非空凭据：挡住浏览器发起的无头请求。
      fail(res, 401, 'this gateway requires an Authorization header even on loopback', 'authentication_error')
      return
    }

    if (req.method === 'POST' && (path === '/v1/messages' || path === '/messages')) {
      await handleMessages(req, res, url)
      return
    }

    if (req.method === 'POST' && (path === '/v1/messages/count_tokens' || path === '/messages/count_tokens')) {
      const raw = await readBody(req)
      let body: AnthRequest
      try {
        body = JSON.parse(raw) as AnthRequest
      } catch {
        fail(res, 400, 'request body is not valid JSON')
        return
      }
      if (routeFor(body.model).provider === 'deepseek') {
        await proxy(req, res, raw, url)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ input_tokens: estimateRequestTokens(body) }))
      return
    }

    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      const table = options.routes()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        object: 'list',
        data: Object.entries(table).map(([id, route]) => ({
          type: 'model',
          id,
          display_name: route.label ?? id,
          created_at: '1970-01-01T00:00:00Z',
        })),
      }))
      return
    }

    if (req.method === 'GET' && path === '/v1/workbuddy/status') {
      const status = await options.status()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(status))
      return
    }

    fail(res, 404, `no such route: ${req.method ?? 'GET'} ${path}`, 'not_found_error')
  }

  /** 把请求原样转发给 DeepSeek 的 Anthropic 兼容端点，响应原样回传。 */
  async function proxy(req: IncomingMessage, res: ServerResponse, raw: string, url: URL): Promise<void> {
    const base = options.deepseekBaseUrl.endsWith('/') ? options.deepseekBaseUrl : `${options.deepseekBaseUrl}/`
    const target = new URL(`${url.pathname.replace(/^\/+/, '')}${url.search}`, base)
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    const auth = req.headers['authorization']
    const apiKey = req.headers['x-api-key']
    const version = req.headers['anthropic-version']
    const beta = req.headers['anthropic-beta']
    if (typeof auth === 'string') headers['authorization'] = auth
    if (typeof apiKey === 'string') headers['x-api-key'] = apiKey
    if (typeof version === 'string') headers['anthropic-version'] = version
    if (typeof beta === 'string') headers['anthropic-beta'] = beta

    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) controller.abort()
    })
    try {
      const upstream = await fetch(target, { method: 'POST', headers, body: raw, signal: controller.signal })
      const contentType = upstream.headers.get('content-type') ?? 'application/json'
      res.writeHead(upstream.status, { 'content-type': contentType, 'cache-control': 'no-cache' })
      if (upstream.body === null) {
        res.end()
        return
      }
      for await (const chunk of upstream.body as AsyncIterable<Uint8Array>) res.write(chunk)
      res.end()
    } catch (error: unknown) {
      if (!res.headersSent) fail(res, 502, `could not reach DeepSeek: ${String(error)}`)
      else res.end()
    }
  }

  async function handleMessages(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const raw = await readBody(req)
    let body: AnthRequest
    try {
      body = JSON.parse(raw) as AnthRequest
    } catch {
      fail(res, 400, 'request body is not valid JSON')
      return
    }
    if (!Array.isArray(body.messages)) {
      fail(res, 400, 'messages must be an array')
      return
    }

    const route = routeFor(body.model)
    if (route.provider === 'deepseek') {
      await proxy(req, res, raw, url)
      return
    }

    const model = route.model ?? options.resolveModel(body.model)
    const converted = toOpenAIRequest(body, model)
    for (const warning of converted.warnings) options.log(`gateway: ${warning}`)

    const controller = new AbortController()
    // 客户端断开时立刻取消上游请求，避免白白消耗积分。
    res.on('close', () => {
      if (!res.writableFinished) controller.abort()
    })
    const timeout = setTimeout(() => controller.abort(), 20 * 60_000)

    let upstream: Response
    try {
      upstream = await fetch(`${options.shimBaseUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.shimToken()}`,
        },
        body: JSON.stringify(converted.body),
        signal: controller.signal,
      })
    } catch (error: unknown) {
      clearTimeout(timeout)
      fail(res, 502, `could not reach the WorkBuddy shim: ${String(error)}`)
      return
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '')
      clearTimeout(timeout)
      options.log(`gateway: upstream ${upstream.status}: ${text.slice(0, 300)}`)
      fail(res, upstream.status === 401 ? 502 : upstream.status, upstreamMessage(upstream.status, text))
      return
    }

    const inputTokens = estimateRequestTokens(body)
    const stream = upstream.body

    try {
      if (body.stream === false) {
        const message = await collectAnthropic(stream as AsyncIterable<Uint8Array>, model, inputTokens, warning => options.log(`gateway: ${warning}`))
        clearTimeout(timeout)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(message))
        return
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      await streamAnthropic(stream as AsyncIterable<Uint8Array>, res, model, inputTokens, warning => options.log(`gateway: ${warning}`))
      clearTimeout(timeout)
      res.end()
    } catch (error: unknown) {
      clearTimeout(timeout)
      if (res.headersSent) {
        // 流已经开始了：只能用 Anthropic 的 error 事件收尾，HTTP 状态码改不了。
        res.write(`event: error\ndata: ${errorPayload('api_error', String(error))}\n\n`)
        res.end()
      } else {
        fail(res, 502, String(error))
      }
    }
  }

  const ready = new Promise<void>((resolve, reject) => {
    server.once('error', error => {
      if (!server.listening) {
        const code = (error as { code?: string }).code
        if (code === 'EADDRINUSE') {
          reject(new Error(`port ${options.port} is already in use (another copy of the gateway is probably running)`))
          return
        }
        reject(error)
      } else {
        options.log(`gateway: listener error: ${String(error)}`)
      }
    })
    server.listen(options.port, '127.0.0.1', () => resolve())
  })

  return {
    ready,
    port: () => {
      const address = server.address()
      return address === null || typeof address === 'string' ? options.port : address.port
    },
    close: async () => {
      if (disposed) return
      disposed = true
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
