import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'
import { CircuitBreaker } from '../src/core/circuit-breaker.ts'
import { cleanupLegacyClaudeCommands, getGatewayPluginState, setGatewayPluginEnabled } from '../src/core/config.ts'
import { GatewayRouter, getTargetBucketKey, isRetryableHttpStatus } from '../src/core/router.ts'
import { createGatewayServer } from '../src/core/server.ts'
import type { AnthropicRequest, GatewayConfig, GatewayModule, RequestContext, RouteAttemptResult } from '../src/core/types.ts'
import { toGeminiRequest } from '../src/modules/antigravity/gemini-converter.ts'
import { getQuotaBucket } from '../src/modules/antigravity/models.ts'
import { AntigravityModule } from '../src/modules/antigravity/index.ts'
import { antigravityAuth } from '../src/modules/antigravity/auth.ts'
import { WorkBuddyModule } from '../src/modules/workbuddy/index.ts'

class MockServerResponse extends EventEmitter {
  statusCode = 200
  headersSent = false
  writableEnded = false
  readonly headers = new Map<string, string>()
  readonly chunks: Buffer[] = []

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), String(value))
  }

  flushHeaders(): void {
    this.headersSent = true
  }

  write(chunk: string | Uint8Array): boolean {
    this.headersSent = true
    this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk))
    return true
  }

  end(chunk?: string | Uint8Array): this {
    if (chunk !== undefined) {
      this.write(chunk)
    } else {
      this.headersSent = true
    }
    this.writableEnded = true
    return this
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

describe('CircuitBreaker', () => {
  it('opens immediately on 429 and enforces single half-open probe after cooldown', () => {
    const breaker = new CircuitBreaker('antigravity:bucket:claude', {
      failureThreshold: 3,
      successThreshold: 1,
      cooldownMs: 10_000,
    })

    const t0 = Date.now()
    const p0 = breaker.allowRequest(t0)
    assert.equal(p0.allowed, true)
    assert.equal(p0.usedHalfOpenPermit, false)

    // Simulate instant open via 429
    const state = breaker.recordFailure(false, {
      openImmediately: true,
      cooldownMs: 10_000,
      error: '429 rate limited',
    })
    assert.equal(state, 'open')
    assert.equal(breaker.isAvailable(t0 + 2_000), false)
    assert.equal(breaker.allowRequest(t0 + 2_000).allowed, false)

    // After cooldown expires -> transitions to half_open and allows exactly 1 concurrent probe
    const afterCooldown = t0 + 11_000
    assert.equal(breaker.isAvailable(afterCooldown), true)
    const probe1 = breaker.allowRequest(afterCooldown)
    assert.equal(probe1.allowed, true)
    assert.equal(probe1.usedHalfOpenPermit, true)

    const probe2 = breaker.allowRequest(afterCooldown)
    assert.equal(probe2.allowed, false)

    breaker.recordSuccess(probe1.usedHalfOpenPermit)
    assert.equal(breaker.getStats(afterCooldown + 100).state, 'closed')
  })
})

describe('Quota buckets & retryability', () => {
  it('maps Antigravity models into independent quota buckets', () => {
    assert.equal(getQuotaBucket('claude-opus-5-5-medium'), 'claude')
    assert.equal(getQuotaBucket('claude-sonnet-5-5-medium'), 'claude')
    assert.equal(getQuotaBucket('gpt-oss-120b-medium'), 'claude')
    assert.equal(getQuotaBucket('gemini-4-argon-medium'), 'argon')
    assert.equal(getQuotaBucket('gemini-3.8-flash-high'), 'gemini-5h')
    assert.equal(getTargetBucketKey('antigravity', 'claude-opus-5-5-medium'), 'antigravity:bucket:claude')
    assert.equal(getTargetBucketKey('antigravity', 'gemini-4-argon-medium'), 'antigravity:bucket:argon')
  })

  it('distinguishes non-retryable 4xx from retryable 429/5xx errors', () => {
    assert.equal(isRetryableHttpStatus(400), false)
    assert.equal(isRetryableHttpStatus(422), false)
    assert.equal(isRetryableHttpStatus(429), true)
    assert.equal(isRetryableHttpStatus(401), true)
    assert.equal(isRetryableHttpStatus(503), true)
  })
})

describe('GatewayRouter multi-bucket & cross-module failover', () => {
  const baseConfig: GatewayConfig = {
    port: 0,
    token: 'local-gw-token',
    authMode: 'token',
    defaultModel: 'claude-opus-5-5',
    smallModel: 'claude-haiku-5-5',
    routes: {
      'claude-opus-5-5': { module: 'antigravity', targetModel: 'claude-opus-5-5-medium', label: 'AGY Opus' },
      'claude-sonnet-5-5': { module: 'antigravity', targetModel: 'claude-sonnet-5-5-medium', label: 'AGY Sonnet' },
      'claude-fable-5-2': { module: 'antigravity', targetModel: 'gemini-4-argon-medium', label: 'AGY Argon' },
      'claude-haiku-5-5': { module: 'workbuddy', targetModel: 'deepseek-v4-pro', label: 'WB DeepSeek' },
    },
    failover: {
      enabled: true,
      maxAttempts: 5,
      failureThreshold: 2,
      successThreshold: 1,
      cooldownSeconds: 45,
      crossModuleFailover: true,
    },
  }

  it('skips same exhausted Antigravity bucket on 429 and fails over immediately to another bucket or WorkBuddy', async () => {
    const calls: string[] = []
    const router = new GatewayRouter()

    const mockAgy: GatewayModule = {
      id: 'antigravity',
      name: 'Mock AGY',
      description: 'Mock',
      async init() {},
      async listModels() { return [] },
      async getStatus() { return { online: true, account: 'mock' } },
      async handleRequest() {},
      async tryHandleRequest(_req, res, _ctx, targetModel): Promise<RouteAttemptResult> {
        calls.push(`antigravity:${targetModel}`)
        if (targetModel?.includes('claude') || targetModel?.includes('argon')) {
          // Simulate Claude bucket + Argon bucket both returning 429
          return {
            committed: false,
            status: 429,
            retryable: true,
            retryAfterMs: 30_000,
            errorType: 'rate_limit_error',
            message: 'RESOURCE_EXHAUSTED',
          }
        }
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true, model: targetModel }))
        return { committed: true }
      },
    }

    const mockWb: GatewayModule = {
      id: 'workbuddy',
      name: 'Mock WB',
      description: 'Mock',
      async init() {},
      async listModels() { return [] },
      async getStatus() { return { online: true, account: 'mock' } },
      async handleRequest() {},
      async tryHandleRequest(_req, res, _ctx, targetModel): Promise<RouteAttemptResult> {
        calls.push(`workbuddy:${targetModel}`)
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'fallback ok' }] }))
        return { committed: true }
      },
    }

    const fakeHost = {
      getModule: (id: string) => (id === 'antigravity' ? mockAgy : id === 'workbuddy' ? mockWb : undefined),
      getAntigravityModule: () => mockAgy,
      getPassthroughModule: () => undefined,
      collectStatuses: async () => ({}),
    } as any

    const logs: string[] = []
    const res1 = new MockServerResponse()
    const started = Date.now()
    await router.dispatchMessage(
      { model: 'claude-opus-5-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
      res1 as unknown as ServerResponse,
      { req: {} as any, headers: {}, clientKey: 'local-gw-token', log: (m) => logs.push(m) },
      baseConfig,
      fakeHost,
      (m) => logs.push(m)
    )
    const elapsedMs = Date.now() - started

    assert.equal(res1.statusCode, 200)
    assert.ok(res1.text().includes('fallback ok'))
    assert.ok(elapsedMs < 1000, `Expected fast failover without sleeping, got ${elapsedMs}ms`)
    // Must NOT call claude-sonnet-5-5 after claude-opus-5-5 failed in same `claude` bucket
    assert.equal(calls.includes('antigravity:claude-sonnet-5-5-medium'), false)
    assert.deepEqual(calls, [
      'antigravity:claude-opus-5-5-medium',
      'antigravity:gemini-4-argon-medium',
      'workbuddy:deepseek-v4-pro',
    ])

    // Second request must bypass open `claude` & `argon` breakers directly to WorkBuddy
    calls.length = 0
    const res2 = new MockServerResponse()
    await router.dispatchMessage(
      { model: 'claude-opus-5-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi again' }] },
      res2 as unknown as ServerResponse,
      { req: {} as any, headers: {}, clientKey: 'local-gw-token', log: (m) => logs.push(m) },
      baseConfig,
      fakeHost,
      (m) => logs.push(m)
    )
    assert.equal(res2.statusCode, 200)
    assert.deepEqual(calls, ['workbuddy:deepseek-v4-pro'])
  })

  it('does not trip breakers or fail over on non-retryable 400 errors', async () => {
    const calls: string[] = []
    const router = new GatewayRouter()

    const mockAgy: GatewayModule = {
      id: 'antigravity',
      name: 'Mock AGY',
      description: 'Mock',
      async init() {},
      async listModels() { return [] },
      async getStatus() { return { online: true, account: 'mock' } },
      async handleRequest() {},
      async tryHandleRequest(_req, _res, _ctx, targetModel): Promise<RouteAttemptResult> {
        calls.push(`antigravity:${targetModel}`)
        return {
          committed: false,
          status: 400,
          retryable: false,
          errorType: 'invalid_request_error',
          message: 'Invalid schema',
        }
      },
    }

    const mockWb: GatewayModule = {
      id: 'workbuddy',
      name: 'Mock WB',
      description: 'Mock',
      async init() {},
      async listModels() { return [] },
      async getStatus() { return { online: true, account: 'mock' } },
      async handleRequest() {},
      async tryHandleRequest(): Promise<RouteAttemptResult> {
        calls.push('workbuddy')
        return { committed: true }
      },
    }

    const fakeHost = {
      getModule: (id: string) => (id === 'antigravity' ? mockAgy : id === 'workbuddy' ? mockWb : undefined),
    } as any

    const res = new MockServerResponse()
    await router.dispatchMessage(
      { model: 'claude-opus-5-5', max_tokens: 64, messages: [{ role: 'user', content: 'bad' }] },
      res as unknown as ServerResponse,
      { req: {} as any, headers: {}, log: () => {} },
      baseConfig,
      fakeHost,
      () => {}
    )

    assert.equal(res.statusCode, 400)
    assert.ok(res.text().includes('Invalid schema'))
    assert.deepEqual(calls, ['antigravity:claude-opus-5-5-medium'])
    assert.equal(router.getBreakerStats().every((b) => b.state === 'closed'), true)
  })
})

describe('Gemini converter thoughtSignature & Antigravity SSE decoding', () => {
  it('replays cached thoughtSignature on functionCall and falls back cleanly on Gemini', () => {
    const sigCache = new Map<string, string>([['toolu_123', 'opaque-sig-abc']])
    const req: AnthropicRequest = {
      model: 'gemini-3.8-flash',
      messages: [
        { role: 'user', content: 'run tool' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_123', name: 'read_file', input: { path: 'a.txt' } } as any,
            { type: 'tool_use', id: 'toolu_999', name: 'list_dir', input: { path: '.' } } as any,
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_123', content: 'ok' } as any,
            { type: 'tool_result', tool_use_id: 'toolu_999', content: 'ok' } as any,
          ],
        },
      ],
    }

    const gemini = toGeminiRequest(req, {
      thoughtSignatureByToolId: sigCache,
      fallbackThoughtSignature: 'skip_thought_signature_validator',
    })
    const modelTurn = gemini.contents.find((c) => c.role === 'model')
    assert.ok(modelTurn)
    assert.equal(modelTurn.parts[0].thoughtSignature, 'opaque-sig-abc')
    assert.equal(modelTurn.parts[1].thoughtSignature, 'skip_thought_signature_validator')
  })

  it('decodes ?alt=sse UTF-8 chunks without emitting fake signature_delta or double-counting tokens', async () => {
    const mod = new AntigravityModule()
    await mod.init({ gatewayPort: 0, log: () => {}, dataDir: '' })

    const origTokenFn = antigravityAuth.getAccessToken
    const origFetch = globalThis.fetch
    let capturedToolSig = ''

    antigravityAuth.getAccessToken = async () => 'mock-access-token'
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input)
      if (url.includes(':loadCodeAssist')) {
        return new Response(JSON.stringify({ cloudaicompanionProject: 'proj-1', currentTier: { id: 'g1-pro-tier' } }), { status: 200 })
      }
      if (url.includes(':fetchAvailableModels')) {
        return new Response(JSON.stringify({ models: { 'gemini-3.8-flash-high': { maxOutputTokens: 8192 } } }), { status: 200 })
      }
      assert.ok(url.includes(':streamGenerateContent?alt=sse'), `Unexpected endpoint: ${url}`)

      const sseFrame1 = `data: ${JSON.stringify({
        response: {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ thought: true, text: '先思考一下', thoughtSignature: 'google-opaque-sig' }],
              },
            },
          ],
        },
      })}\n\n`
      const sseFrame2 = `data: ${JSON.stringify({
        response: {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { text: '你好，世界！' },
                  { functionCall: { name: 'check_weather', args: { city: 'Beijing' } }, thoughtSignature: 'fc-sig-xyz' },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 25, thoughtsTokenCount: 10 },
        },
      })}\n\ndata: [DONE]\n\n`

      const bytes = Buffer.concat([Buffer.from(sseFrame1, 'utf8'), Buffer.from(sseFrame2, 'utf8')])
      // Split across multi-byte UTF-8 boundary intentionally to test TextDecoder { stream: true }
      const splitPoint = Buffer.from(sseFrame1, 'utf8').indexOf('思') + 1

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.subarray(0, splitPoint))
          controller.enqueue(bytes.subarray(splitPoint))
          controller.close()
        },
      })
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }) as any

    try {
      const res = new MockServerResponse()
      const result = await mod.tryHandleRequest(
        {
          model: 'gemini-3.8-flash-high',
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
        },
        res as unknown as ServerResponse,
        { req: {} as any, headers: {}, log: () => {} },
        'gemini-3.8-flash-high'
      )

      assert.equal(result.committed, true)
      assert.equal(res.statusCode, 200)
      const sseText = res.text()
      assert.ok(sseText.includes('先思考一下'), 'Should preserve split UTF-8 thinking text')
      assert.ok(sseText.includes('你好，世界！'), 'Should decode visible text')
      assert.ok(sseText.includes('check_weather'), 'Should emit tool_use')
      assert.equal(sseText.includes('signature_delta'), false, 'Must NOT emit fake Anthropic signature_delta')
      assert.ok(sseText.includes('"output_tokens":35'), `Expected exact upstream 25+10=35 tokens, got:\n${sseText}`)

      const toolIdMatch = sseText.match(/"id":"(toolu_[^"]+)"/)
      assert.ok(toolIdMatch)
      capturedToolSig = toolIdMatch[1]
      const nextTurn = toGeminiRequest(
        {
          model: 'gemini-3.8-flash-high',
          messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: capturedToolSig, name: 'check_weather', input: {} } as any] }],
        },
        { thoughtSignatureByToolId: (mod as any).toolThoughtSignatures }
      )
      assert.equal(nextTurn.contents[0].parts[0].thoughtSignature, 'fc-sig-xyz')
    } finally {
      antigravityAuth.getAccessToken = origTokenFn
      globalThis.fetch = origFetch
    }
  })

  it('returns uncommitted retryable error when SSE stream ends empty so router can fail over', async () => {
    const mod = new AntigravityModule()
    await mod.init({ gatewayPort: 0, log: () => {}, dataDir: '' })

    const origTokenFn = antigravityAuth.getAccessToken
    const origFetch = globalThis.fetch
    antigravityAuth.getAccessToken = async () => 'mock-access-token'
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input)
      if (url.includes(':loadCodeAssist')) {
        return new Response(JSON.stringify({ cloudaicompanionProject: 'proj-1' }), { status: 200 })
      }
      if (url.includes(':fetchAvailableModels')) {
        return new Response(JSON.stringify({ models: {} }), { status: 200 })
      }
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }) as any

    try {
      const res = new MockServerResponse()
      const result = await mod.tryHandleRequest(
        { model: 'gemini-3.8-flash-high', stream: true, messages: [{ role: 'user', content: 'hi' }] },
        res as unknown as ServerResponse,
        { req: {} as any, headers: {}, log: () => {} },
        'gemini-3.8-flash-high'
      )
      assert.equal(result.committed, false)
      assert.equal(result.retryable, true)
      assert.equal(res.headersSent, false)
    } finally {
      antigravityAuth.getAccessToken = origTokenFn
      globalThis.fetch = origFetch
    }
  })
})

describe('createGatewayServer HTTP /status & routing integration', () => {
  it('exposes circuit breaker stats on /status and routes HTTP /v1/messages cleanly', async () => {
    const cfg: GatewayConfig = {
      port: 0,
      token: 'secret-tok',
      authMode: 'token',
      defaultModel: 'claude-opus-5-5',
      smallModel: 'claude-haiku-5-5',
      routes: {
        'claude-opus-5-5': { module: 'antigravity', targetModel: 'claude-opus-5-5-medium', label: 'Opus' },
        'claude-haiku-5-5': { module: 'workbuddy', targetModel: 'deepseek-v4-pro', label: 'WB' },
      },
      failover: {
        enabled: true,
        crossModuleFailover: true,
      },
    }
    const mockAgy: GatewayModule = {
      id: 'antigravity',
      name: 'AGY',
      description: 'AGY',
      async init() {},
      async listModels() { return [] },
      async getStatus() { return { online: true, account: 'agy@test' } },
      async handleRequest() {},
      async tryHandleRequest(): Promise<RouteAttemptResult> {
        return { committed: false, status: 429, retryable: true, retryAfterMs: 30_000, message: 'busy' }
      },
    }
    const mockWb: GatewayModule = {
      id: 'workbuddy',
      name: 'WB',
      description: 'WB',
      async init() {},
      async listModels() { return [] },
      async getStatus() { return { online: true, account: 'wb@test' } },
      async handleRequest() {},
      async tryHandleRequest(_req, res): Promise<RouteAttemptResult> {
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ id: 'msg_http', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'via http wb' }] }))
        return { committed: true }
      },
    }
    const fakeHost = {
      getModule: (id: string) => (id === 'antigravity' ? mockAgy : id === 'workbuddy' ? mockWb : undefined),
      collectStatuses: async () => ({
        antigravity: { online: true, account: 'agy@test' },
        workbuddy: { online: true, account: 'wb@test' },
      }),
    } as any

    const gw = createGatewayServer({ config: cfg, host: fakeHost, log: () => {} })
    const actualPort = await gw.start()
    try {
      const msgRes = await fetch(`http://127.0.0.1:${actualPort}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'secret-tok',
        },
        body: JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hello' }] }),
      })
      assert.equal(msgRes.status, 200)
      const body = await msgRes.json() as any
      assert.equal(body.content[0].text, 'via http wb')

      const stRes = await fetch(`http://127.0.0.1:${actualPort}/status`)
      assert.equal(stRes.status, 200)
      const stBody = await stRes.json() as any
      assert.ok(Array.isArray(stBody.breakers))
      assert.ok(stBody.breakers.some((b: any) => b.key === 'antigravity:bucket:claude' && b.state === 'open'))
    } finally {
      await gw.close()
    }
  })
})

describe('Router auth failover & Claude plugin state sync', () => {
  it('does not switch models or cross modules by default when failover is omitted', async () => {
    const calls: string[] = []
    const router = new GatewayRouter()
    const cfg: GatewayConfig = {
      port: 0,
      token: 'tok',
      authMode: 'token',
      defaultModel: 'claude-haiku-5-5',
      smallModel: 'claude-haiku-5-5',
      routes: {
        'claude-haiku-5-5': { module: 'antigravity', targetModel: 'gemini-3.8-flash-medium', label: 'AGY Flash' },
        'claude-fable-5-2': { module: 'antigravity', targetModel: 'gemini-4-argon-medium', label: 'AGY Argon' },
        'claude-sonnet-5-5': { module: 'workbuddy', targetModel: 'deepseek-v4-pro', label: 'WB DeepSeek' },
      },
    }

    const mockAgy: GatewayModule = {
      id: 'antigravity',
      name: 'AGY',
      description: 'AGY',
      async init() {},
      async listModels() { return [] },
      async getStatus() { return { online: true } },
      async handleRequest() {},
      async tryHandleRequest(_req, _res, _ctx, targetModel): Promise<RouteAttemptResult> {
        calls.push(`antigravity:${targetModel}`)
        return { committed: false, status: 429, retryable: true, message: 'AGY_ONLY_429' }
      },
    }

    const mockWb: GatewayModule = {
      id: 'workbuddy',
      name: 'WB',
      description: 'WB',
      async init() {},
      async listModels() { return [] },
      async getStatus() { return { online: true } },
      async handleRequest() {},
      async tryHandleRequest(_req, _res, _ctx, targetModel): Promise<RouteAttemptResult> {
        calls.push(`workbuddy:${targetModel}`)
        return { committed: true }
      },
    }

    const fakeHost = {
      getModule: (id: string) => (id === 'antigravity' ? mockAgy : id === 'workbuddy' ? mockWb : undefined),
    } as any

    const res = new MockServerResponse()
    await router.dispatchMessage(
      { model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'hi' }] },
      res as unknown as ServerResponse,
      { req: {} as any, headers: {}, log: () => {} },
      cfg,
      fakeHost,
      () => {}
    )

    assert.equal(res.statusCode, 429)
    assert.ok(res.text().includes('AGY_ONLY_429'))
    assert.deepEqual(calls, ['antigravity:gemini-3.8-flash-medium'])
  })

  it('stops retrying the same unauthenticated module on 401 and preserves primary 429 error', async () => {
    const calls: string[] = []
    const router = new GatewayRouter()
    const cfg: GatewayConfig = {
      port: 0,
      token: 'tok',
      authMode: 'token',
      defaultModel: 'claude-opus-5-5',
      smallModel: 'claude-haiku-5-5',
      routes: {
        'claude-opus-5-5': { module: 'antigravity', targetModel: 'claude-opus-5-5-medium', label: 'AGY Opus' },
        'claude-haiku-5-5': { module: 'workbuddy', targetModel: 'deepseek-v4-pro', label: 'WB DeepSeek' },
        'claude-3-5-haiku-20241022': { module: 'workbuddy', targetModel: 'hy4free', label: 'WB Hy4 Free' },
      },
      failover: { enabled: true, maxAttempts: 5, crossModuleFailover: true },
    }

    const mockAgy: GatewayModule = {
      id: 'antigravity',
      name: 'AGY',
      description: 'AGY',
      async init() {},
      async listModels() { return [] },
      async getStatus() { return { online: true } },
      async handleRequest() {},
      async tryHandleRequest(_req, _res, _ctx, targetModel): Promise<RouteAttemptResult> {
        calls.push(`antigravity:${targetModel}`)
        return { committed: false, status: 429, retryable: true, message: 'AGY_PRIMARY_429' }
      },
    }

    const mockWb: GatewayModule = {
      id: 'workbuddy',
      name: 'WB',
      description: 'WB',
      async init() {},
      async listModels() { return [] },
      async getStatus() { return { online: false } },
      async handleRequest() {},
      async tryHandleRequest(_req, _res, _ctx, targetModel): Promise<RouteAttemptResult> {
        calls.push(`workbuddy:${targetModel}`)
        return { committed: false, status: 401, retryable: true, message: 'WB_401_NOT_SIGNED_IN' }
      },
    }

    const fakeHost = {
      getModule: (id: string) => (id === 'antigravity' ? mockAgy : id === 'workbuddy' ? mockWb : undefined),
    } as any

    const res = new MockServerResponse()
    await router.dispatchMessage(
      { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] },
      res as unknown as ServerResponse,
      { req: {} as any, headers: {}, log: () => {} },
      cfg,
      fakeHost,
      () => {}
    )

    assert.equal(res.statusCode, 429)
    assert.ok(res.text().includes('AGY_PRIMARY_429'))
    assert.deepEqual(calls, ['antigravity:claude-opus-5-5-medium', 'workbuddy:deepseek-v4-pro'])
  })

  it('syncs plugin enabled/disabled state in settings.json and cleans legacy commands', () => {
    const tmp = mkdtempSync(join(import.meta.dirname, '.tmp-plugin-state-'))
    try {
      const settingsPath = join(tmp, 'settings.json')
      const installedPath = join(tmp, 'installed_plugins.json')
      const cmdsDir = join(tmp, 'commands')
      mkdirSync(cmdsDir, { recursive: true })
      writeFileSync(join(cmdsDir, 'workbuddy-models.md'), 'old', 'utf8')
      writeFileSync(join(cmdsDir, 'workbuddy-status.md'), 'old', 'utf8')
      writeFileSync(join(cmdsDir, 'keep-me.md'), 'keep', 'utf8')

      writeFileSync(
        installedPath,
        JSON.stringify({ version: 2, plugins: { 'agent-gateway@aaaynmmm-plugins': [{}] } }),
        'utf8'
      )
      writeFileSync(
        settingsPath,
        JSON.stringify({ enabledPlugins: { 'agent-gateway@aaaynmmm-plugins': true } }),
        'utf8'
      )

      let state = getGatewayPluginState(false, settingsPath, installedPath)
      assert.equal(state.registered, true)
      assert.equal(state.enabled, true)
      assert.equal(state.disabled, false)

      assert.equal(setGatewayPluginEnabled(false, settingsPath, installedPath), true)
      state = getGatewayPluginState(true, settingsPath, installedPath)
      assert.equal(state.enabled, false)
      assert.equal(state.disabled, true)

      assert.equal(setGatewayPluginEnabled(true, settingsPath, installedPath), true)
      state = getGatewayPluginState(true, settingsPath, installedPath)
      assert.equal(state.enabled, true)
      assert.equal(state.disabled, false)

      // Uninstalling plugin after startup also marks state.disabled = true
      writeFileSync(installedPath, JSON.stringify({ version: 2, plugins: {} }), 'utf8')
      writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: {} }), 'utf8')
      state = getGatewayPluginState(true, settingsPath, installedPath)
      assert.equal(state.disabled, true)

      const removed = cleanupLegacyClaudeCommands(cmdsDir)
      assert.equal(removed.length, 2)
      assert.equal(existsSync(join(cmdsDir, 'workbuddy-models.md')), false)
      assert.equal(existsSync(join(cmdsDir, 'workbuddy-status.md')), false)
      assert.equal(existsSync(join(cmdsDir, 'keep-me.md')), true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('initializes WorkBuddyModule with valid region resolution and shim without crashing', async () => {
    const mod = new WorkBuddyModule()
    mod.setRegion('auto')
    await mod.init({ gatewayPort: 0, log: () => {}, dataDir: '' })
    try {
      const models = await mod.listModels()
      assert.ok(models.length > 0)
    } finally {
      await mod.dispose()
    }
  })

  it('sends flat OpenAI body with model field to WorkBuddy shim and converts SSE for both stream and non-stream', async () => {
    const mod = new WorkBuddyModule()
    mod.setRegion('cn')
    const capturedBodies: Array<Record<string, unknown>> = []
    const origFetch = globalThis.fetch

    // Mock only the WorkBuddy upstream or shim? Wait: shim runs on 127.0.0.1, so we stub globalThis.fetch
    // for shimUrl so we verify the exact body WorkBuddyModule sends AND the SSE -> Anthropic conversion!
    await mod.init({ gatewayPort: 0, log: () => {}, dataDir: '' })
    try {
      globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/v1/chat/completions')) {
          capturedBodies.push(JSON.parse(String(init?.body ?? '{}')))
          const sse = [
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'wb-ok' } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`,
            'data: [DONE]\n\n',
          ].join('')
          return new Response(sse, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          })
        }
        return origFetch(input, init)
      }) as typeof fetch

      // 1. Non-stream Anthropic request
      const resJson = new MockServerResponse()
      const r1 = await mod.tryHandleRequest(
        { model: 'claude-haiku-5-5', max_tokens: 64, stream: false, messages: [{ role: 'user', content: 'hi' }] },
        resJson as unknown as ServerResponse,
        { req: {} as any, headers: {}, log: () => {} },
        'deepseek-v4-flash'
      )
      assert.equal(r1.committed, true)
      assert.equal(capturedBodies[0]?.['model'], 'deepseek-v4-flash')
      assert.equal(capturedBodies[0]?.['body'], undefined)
      const jsonOut = JSON.parse(resJson.text())
      assert.equal(jsonOut.type, 'message')
      assert.equal(jsonOut.model, 'claude-haiku-5-5')
      assert.equal(jsonOut.content[0].text, 'wb-ok')

      // 2. Stream Anthropic request
      const resSse = new MockServerResponse()
      const r2 = await mod.tryHandleRequest(
        { model: 'claude-opus-5-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] },
        resSse as unknown as ServerResponse,
        { req: {} as any, headers: {}, log: () => {} },
        'deepseek-v4-pro'
      )
      assert.equal(r2.committed, true)
      assert.equal(resSse.writableEnded, true)
      assert.equal(capturedBodies[1]?.['model'], 'deepseek-v4-pro')
      assert.ok(resSse.text().includes('"model":"claude-opus-5-5"'))
      assert.ok(resSse.text().includes('"text":"wb-ok"'))
      assert.ok(resSse.text().includes('event: message_stop'))
    } finally {
      globalThis.fetch = origFetch
      await mod.dispose()
    }
  })
})
