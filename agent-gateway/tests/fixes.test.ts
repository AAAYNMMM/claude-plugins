import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'
import { CircuitBreaker } from '../src/core/circuit-breaker.ts'
import {
  applyGatewayToClaude,
  applyGatewayToSettings,
  getGatewayPluginState,
  isGatewayManagedModelLabel,
  loadGatewayConfig,
  restoreOriginalClaudeProvider,
  restoreOriginalSettings,
  saveGatewayConfig,
} from '../src/core/config.ts'
import {
  createClaudeLifecycleMonitor,
  parseListeningPidsForPort,
  parseWindowsTasklistHasClaude,
  withFileLock,
} from '../src/core/lifecycle.ts'
import {
  collectAnthropic,
  streamAnthropic,
  toOpenAIRequest,
  UpstreamStreamError,
} from '../src/core/protocol/anthropic.ts'
import { GatewayRouter } from '../src/core/router.ts'
import { createGatewayServer } from '../src/core/server.ts'
import type { AnthropicRequest, GatewayConfig, GatewayModule, RouteAttemptResult } from '../src/core/types.ts'
import { antigravityAuth } from '../src/modules/antigravity/auth.ts'
import { cleanSchemaForGemini, toGeminiRequest } from '../src/modules/antigravity/gemini-converter.ts'
import { AntigravityModule, normalizeAntigravityErrorStatus } from '../src/modules/antigravity/index.ts'
import {
  fetchLiveProjectAndTier,
  getDynamicAntigravityModels,
  getModelRemainingFraction,
  invalidateAntigravityModelCaches,
  resolveUpstreamModel,
} from '../src/modules/antigravity/models.ts'
import { PassthroughModule } from '../src/modules/passthrough/index.ts'
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

function makeSseBody(frames: unknown[]): ReadableStream<Uint8Array> {
  const payload = frames
    .map((f) => (typeof f === 'string' ? `data: ${f}\n\n` : `data: ${JSON.stringify(f)}\n\n`))
    .join('')
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from(payload, 'utf8'))
      controller.close()
    },
  })
}

describe('P0-1: HTTP server validation, timingSafeEqual UTF-8, and error status mapping', () => {
  it('handles UTF-8 token comparison safely and validates /v1/messages & count_tokens bodies', async () => {
    const cfg: GatewayConfig = {
      port: 0,
      token: 'abc123',
      authMode: 'token',
      defaultModel: 'm1',
      smallModel: 'm1',
      routes: { m1: { module: 'passthrough', targetModel: 'm1', label: 'M1' } },
    }
    const fakeHost = {
      getModule: () => undefined,
      collectStatuses: async () => ({}),
    } as any

    const gw = createGatewayServer({ config: cfg, host: fakeHost, log: () => {} })
    const port = await gw.start()
    try {
      // Same UTF-16 length (6) as 'abc123', different UTF-8 byte length (12): must return 401, not throw
      const utf8BadRes = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'éééééé',
        },
        body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }),
      })
      assert.equal(utf8BadRes.status, 401)

      // Non-object / null / missing messages -> 400
      for (const badBody of ['null', '[1,2]', '"str"', JSON.stringify({ model: 'm1' })]) {
        const badRes = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': 'abc123' },
          body: badBody,
        })
        assert.equal(badRes.status, 400, `Expected 400 for body=${badBody}`)
      }

      const badCount = await fetch(`http://127.0.0.1:${port}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'abc123' },
        body: 'null',
      })
      assert.equal(badCount.status, 400)
    } finally {
      await gw.close()
    }
  })

  it('normalizes gRPC error codes such as 8 (RESOURCE_EXHAUSTED) into valid HTTP [100, 599]', () => {
    assert.equal(normalizeAntigravityErrorStatus({ code: 8 }), 429)
    assert.equal(normalizeAntigravityErrorStatus({ code: '8' }), 429)
    assert.equal(normalizeAntigravityErrorStatus({ code: 16 }), 401)
    assert.equal(normalizeAntigravityErrorStatus({ status: 'RESOURCE_EXHAUSTED' }), 429)
    assert.equal(normalizeAntigravityErrorStatus({ status: 'UNAUTHENTICATED' }), 401)
    assert.equal(normalizeAntigravityErrorStatus({ code: 429 }), 429)
    assert.equal(normalizeAntigravityErrorStatus({ code: 0 }), 502)
  })
})

describe('P0-2 & P1-5: Atomic config persistence, backup recovery, and provider restoration', () => {
  it('recovers config.json from .bak on parse failure and throws if both are corrupt', () => {
    const tmp = mkdtempSync(join(import.meta.dirname, '.tmp-cfg-'))
    try {
      const cfgPath = join(tmp, 'config.json')
      const original: GatewayConfig = {
        port: 43119,
        token: 'stable-user-token-xyz',
        authMode: 'token',
        defaultModel: 'claude-sonnet-5.5',
        smallModel: 'claude-haiku-5-5',
        routes: { 'claude-sonnet-5.5': { module: 'workbuddy', targetModel: 'deepseek-v4-pro', label: 'WB' } },
        passthrough: {
          deepseekBaseUrl: 'https://custom-upstream.example/anthropic',
          settingsBaseUrl: 'https://settings-upstream.example/anthropic',
        },
      }
      saveGatewayConfig(original, cfgPath)
      // Second save populates .bak
      saveGatewayConfig({ ...original, port: 43120 }, cfgPath)
      // Corrupt primary config.json
      writeFileSync(cfgPath, '{broken json', 'utf8')

      const recovered = loadGatewayConfig(cfgPath)
      assert.equal(recovered.token, 'stable-user-token-xyz')
      assert.equal(recovered.passthrough?.settingsBaseUrl, 'https://settings-upstream.example/anthropic')
      assert.equal(recovered.passthrough?.deepseekBaseUrl, 'https://custom-upstream.example/anthropic')

      // Corrupt both primary and .bak -> must throw instead of silently generating new random token
      writeFileSync(cfgPath, '{broken1', 'utf8')
      writeFileSync(`${cfgPath}.bak`, '{broken2', 'utf8')
      assert.throws(() => loadGatewayConfig(cfgPath))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('backs up and restores inferenceProvider and removes gateway/DeepSeek labels without hardcoding DeepSeek', () => {
    const tmp = mkdtempSync(join(import.meta.dirname, '.tmp-provider-'))
    try {
      const activePath = join(tmp, 'provider.json')
      const backupPath = join(tmp, 'backup.json')

      // Case A: official account without custom inferenceGatewayBaseUrl and with inferenceProvider: 'anthropic'
      writeFileSync(
        activePath,
        JSON.stringify({
          inferenceProvider: 'anthropic',
          inferenceModels: [{ name: 'claude-sonnet-5.5', labelOverride: 'My Custom Sonnet' }],
        }),
        'utf8'
      )

      const routes = {
        'claude-sonnet-5.5': { module: 'passthrough', targetModel: 'claude-sonnet-5.5', label: 'DeepSeek · Sonnet (透传)' },
        'claude-opus-5-5': { module: 'antigravity', targetModel: 'claude-opus-5-5-medium', label: 'AGY · Opus' },
      }
      applyGatewayToClaude(routes, 43119, activePath, backupPath)
      const during = JSON.parse(readFileSync(activePath, 'utf8'))
      assert.equal(during.inferenceProvider, 'gateway')

      // Re-applying while active must NOT overwrite original backup
      applyGatewayToClaude(routes, 43119, activePath, backupPath)

      assert.equal(isGatewayManagedModelLabel('DeepSeek · Sonnet (透传)'), true)
      restoreOriginalClaudeProvider('https://api.deepseek.com/anthropic', activePath, backupPath)

      const after = JSON.parse(readFileSync(activePath, 'utf8'))
      assert.equal(after.inferenceProvider, 'anthropic')
      assert.equal('inferenceGatewayBaseUrl' in after, false, 'Must NOT inject hardcoded DeepSeek URL')
      assert.deepEqual(after.inferenceModels, [{ name: 'claude-sonnet-5.5', labelOverride: 'My Custom Sonnet' }])

      // Isolated settings.json backup & restore with claude-sonnet-* models
      const settingsPath = join(tmp, 'settings.json')
      const envBackupPath = join(tmp, 'original-settings-env.json')
      writeFileSync(
        settingsPath,
        JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
            ANTHROPIC_AUTH_TOKEN: 'orig-ds-token',
            ANTHROPIC_MODEL: 'claude-sonnet-5.5',
          },
          enabledPlugins: { 'agent-gateway@aaaynmmm-plugins': true },
        }),
        'utf8'
      )
      applyGatewayToSettings(43119, 'gw-token', 'claude-sonnet-5-5', 'claude-sonnet-4-6', settingsPath, envBackupPath)
      const settingsDuring = JSON.parse(readFileSync(settingsPath, 'utf8'))
      assert.equal(settingsDuring.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:43119')
      assert.equal(settingsDuring.env.ANTHROPIC_AUTH_TOKEN, 'gw-token')
      assert.equal(settingsDuring.env.ANTHROPIC_MODEL, 'claude-sonnet-5-5')
      assert.equal(settingsDuring.env.ANTHROPIC_SMALL_FAST_MODEL, 'claude-sonnet-4-6')

      // Re-applying while active must not clobber original backup
      applyGatewayToSettings(43119, 'gw-token', 'claude-sonnet-5-6', 'claude-sonnet-5-7', settingsPath, envBackupPath)
      assert.equal(restoreOriginalSettings('gw-token', undefined, settingsPath, envBackupPath), true)
      const settingsAfter = JSON.parse(readFileSync(settingsPath, 'utf8'))
      assert.deepEqual(settingsAfter.env, {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'orig-ds-token',
        ANTHROPIC_MODEL: 'claude-sonnet-5.5',
      })
      assert.equal(existsSync(envBackupPath), false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('P0-3: Server close timeout & transient plugin IO error immunity', () => {
  it('closes server promptly even with active open SSE connection', async () => {
    const cfg: GatewayConfig = {
      port: 0,
      token: 'tok',
      authMode: 'loopback',
      defaultModel: 'm',
      smallModel: 'm',
      routes: { m: { module: 'mock', targetModel: 'm', label: 'M' } },
    }
    const hangingModule: GatewayModule = {
      id: 'mock',
      name: 'Mock',
      description: 'Mock',
      async init() {},
      async listModels() { return [] },
      async getStatus() { return { online: true } },
      async handleRequest() {},
      async tryHandleRequest(_req, res): Promise<RouteAttemptResult> {
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/event-stream')
        res.write('data: {"ok":1}\n\n')
        // Keep connection open intentionally
        await new Promise(() => {})
        return { committed: true }
      },
    }
    const gw = createGatewayServer({
      config: cfg,
      host: { getModule: () => hangingModule, collectStatuses: async () => ({}) } as any,
      log: () => {},
    })
    const port = await gw.start()

    // Fire hanging SSE request
    const ac = new AbortController()
    const reqPromise = fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'k' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
      signal: ac.signal,
    }).catch(() => {})

    await new Promise((r) => setTimeout(r, 50))
    const t0 = Date.now()
    await gw.close(50)
    const elapsed = Date.now() - t0
    ac.abort()
    await reqPromise
    assert.ok(elapsed < 1000, `Expected close() to finish quickly, took ${elapsed}ms`)
  })

  it('does not treat transient JSON parse errors in plugin files as uninstalled', () => {
    const tmp = mkdtempSync(join(import.meta.dirname, '.tmp-plugin-io-'))
    try {
      const settingsPath = join(tmp, 'settings.json')
      const installedPath = join(tmp, 'installed_plugins.json')
      writeFileSync(settingsPath, '{partial json write', 'utf8')
      writeFileSync(installedPath, '{partial json write', 'utf8')

      const st = getGatewayPluginState(true, settingsPath, installedPath)
      assert.equal(st.indeterminate, true)
      assert.equal(st.disabled, false, 'Transient JSON parse error must NOT trigger self-destruct')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('P1-1 & P1-2: Anthropic protocol conversion, interleaved tool_calls, and SSE framing', () => {
  it('keeps role:tool messages contiguous before images and preserves is_error/object content', () => {
    const { body } = toOpenAIRequest(
      {
        model: 'm',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool_1',
                content: [
                  { type: 'text', text: 'first' },
                  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
                ],
              },
              {
                type: 'tool_result',
                tool_use_id: 'tool_2',
                is_error: true,
                content: { code: 42 } as any,
              },
            ],
          },
        ],
      },
      'upstream-m'
    )

    const msgs = body.messages as Array<{ role: string; content: unknown; tool_call_id?: string }>
    assert.equal(msgs.length, 3)
    assert.equal(msgs[0].role, 'tool')
    assert.equal(msgs[0].tool_call_id, 'tool_1')
    assert.equal(msgs[1].role, 'tool')
    assert.equal(msgs[1].tool_call_id, 'tool_2')
    assert.equal(msgs[1].content, '[tool_error] {"code":42}')
    assert.equal(msgs[2].role, 'user')
  })

  it('merges interleaved parallel tool_calls cleanly and ignores nameless tool_calls in stop_reason', async () => {
    const interleaved = makeSseBody([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_a', function: { name: 'tool_alpha', arguments: '{"a":' } },
                { index: 1, id: 'call_b', function: { name: 'tool_beta', arguments: '{"b":' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '1}' } },
                { index: 1, function: { arguments: '2}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      '[DONE]',
    ])

    const msg = await collectAnthropic(interleaved, 'm', 10, () => {})
    const content = msg.content as Array<{ type: string; name: string; input: unknown }>
    assert.equal(content.length, 2)
    assert.equal(content[0].name, 'tool_alpha')
    assert.deepEqual(content[0].input, { a: 1 })
    assert.equal(content[1].name, 'tool_beta')
    assert.deepEqual(content[1].input, { b: 2 })
    assert.equal(msg.stop_reason, 'tool_use')

    // Nameless tool_calls must NOT emit stop_reason: 'tool_use'
    const nameless = makeSseBody([
      { choices: [{ delta: { content: 'hello' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
      '[DONE]',
    ])
    const msg2 = await collectAnthropic(nameless, 'm', 5, () => {})
    assert.equal(msg2.stop_reason, 'end_turn')
  })

  it('defers onBeforeStart until valid frame and emits event:error on post-start failure', async () => {
    // Pre-start error -> onBeforeStart NOT called, throws preStart UpstreamStreamError
    const res1 = new MockServerResponse()
    let beforeStartCalled = false
    await assert.rejects(
      () =>
        streamAnthropic(
          makeSseBody([{ error: { message: 'overloaded', status: 503 } }]),
          res1 as unknown as ServerResponse,
          'm',
          5,
          () => {},
          () => {
            beforeStartCalled = true
            res1.headersSent = true
          }
        ),
      (err: unknown) => err instanceof UpstreamStreamError && err.status === 503 && err.preStart === true
    )
    assert.equal(beforeStartCalled, false)
    assert.equal(res1.headersSent, false)

    // Mid-stream error after content started -> emits event: error, no message_delta/message_stop
    const res2 = new MockServerResponse()
    await assert.rejects(
      () =>
        streamAnthropic(
          makeSseBody([
            { choices: [{ delta: { content: 'partial' } }] },
            { error: { message: 'stream crashed', status: 500 } },
          ]),
          res2 as unknown as ServerResponse,
          'm',
          5,
          () => {}
        ),
      (err: unknown) => err instanceof UpstreamStreamError && err.preStart === false
    )
    const out = res2.text()
    assert.ok(out.includes('event: error'))
    assert.ok(out.includes('stream crashed'))
    assert.equal(out.includes('message_stop'), false)
  })
})

describe('P1-3, P1-6 & P2-2: Antigravity schema/converter/auth/models/SSE fixes', () => {
  it('cleans array types, null types, empty system arrays, and wraps non-object tool_result JSON', () => {
    const cleaned = cleanSchemaForGemini({
      type: 'object',
      properties: {
        a: { type: ['string', 'null'] },
        b: { type: 'null' },
        c: { type: 'array', items: [{ type: 'integer' }] },
      },
    }) as any
    assert.equal(cleaned.properties.a.type, 'string')
    assert.equal(cleaned.properties.b.type, 'string')
    assert.equal(cleaned.properties.c.items.type, 'integer')

    const gem = toGeminiRequest({
      model: 'gemini-3.8-flash',
      system: [{ type: 'text', text: '' }],
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'fn', input: {} } as any] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: '[1,2]', is_error: true } as any,
          ],
        },
      ],
    })
    assert.equal(gem.systemInstruction, undefined)
    const fr = gem.contents[1].parts[0].functionResponse
    assert.deepEqual(fr?.response, { result: [1, 2], is_error: true })
  })

  it('clamps thinkingBudget below maxOutputTokens, uses thought fallback sig, and stops stream on post-start error', async () => {
    const mod = new AntigravityModule()
    await mod.init({ gatewayPort: 0, log: () => {}, dataDir: '' })

    const origTokenFn = antigravityAuth.getAccessToken
    const origFetch = globalThis.fetch
    let capturedBody: any = null

    antigravityAuth.getAccessToken = async () => 'tok-test-sig'
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes(':loadCodeAssist')) {
        return new Response(JSON.stringify({ cloudaicompanionProject: 'proj-sig' }), { status: 200 })
      }
      if (url.includes(':fetchAvailableModels')) {
        return new Response(
          JSON.stringify({
            agentModelSorts: [{ groups: [{ modelIds: ['gemini-3.8-flash-high'] }] }],
            models: { 'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash', maxOutputTokens: 4096 } },
          }),
          { status: 200 }
        )
      }
      capturedBody = JSON.parse(String(init?.body))
      return new Response(
        makeSseBody([
          {
            response: {
              candidates: [
                { content: { role: 'model', parts: [{ thought: true, text: 'think', thoughtSignature: 'turn-sig-1' }] } },
              ],
            },
          },
          {
            response: {
              candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'do_x', args: {} } }] } }],
            },
          },
          { error: { code: 8, message: 'rate limit mid stream' } },
        ]),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      )
    }) as any

    try {
      const res = new MockServerResponse()
      await assert.rejects(() =>
        mod.tryHandleRequest(
          {
            model: 'gemini-3.8-flash-high',
            max_tokens: 16000,
            thinking: { type: 'enabled', budget_tokens: 12000 },
            stream: true,
            messages: [{ role: 'user', content: 'hi' }],
          },
          res as unknown as ServerResponse,
          { req: {} as any, headers: {}, log: () => {} },
          'gemini-3.8-flash-high'
        )
      )
      assert.equal(capturedBody.request.generationConfig.maxOutputTokens, 4096)
      assert.ok(capturedBody.request.generationConfig.thinkingConfig.thinkingBudget < 4096)

      const sseText = res.text()
      assert.ok(sseText.includes('event: error'))
      assert.equal(sseText.includes('message_stop'), false, 'Post-start error must NOT emit message_stop')
      const sigMap = (mod as any).toolThoughtSignatures as Map<string, string>
      assert.ok(Array.from(sigMap.values()).includes('turn-sig-1'))
    } finally {
      antigravityAuth.getAccessToken = origTokenFn
      globalThis.fetch = origFetch
      invalidateAntigravityModelCaches()
    }
  })

  it('scopes projectId cache by token and preserves dynamic maps when fetch returns empty models', async () => {
    invalidateAntigravityModelCaches()
    const origFetch = globalThis.fetch
    let projectCalls = 0
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const auth = (init?.headers as Record<string, string>)?.Authorization
      if (url.includes(':loadCodeAssist')) {
        projectCalls++
        if (auth === 'Bearer token-a') return new Response(JSON.stringify({ cloudaicompanionProject: 'proj-a' }), { status: 200 })
        return new Response(JSON.stringify({}), { status: 200 }) // Missing projectId -> must NOT cache default for token-b
      }
      if (url.includes(':fetchAvailableModels')) {
        if (auth === 'Bearer token-a') {
          return new Response(
            JSON.stringify({
              agentModelSorts: [{ groups: [{ modelIds: ['m-alpha'] }] }],
              models: { 'm-alpha': { displayName: 'Alpha', quotaInfo: { remainingFraction: 0.9 } } },
            }),
            { status: 200 }
          )
        }
        return new Response(JSON.stringify({ models: {} }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }) as any

    try {
      const pA = await fetchLiveProjectAndTier('token-a')
      const pB = await fetchLiveProjectAndTier('token-b')
      assert.equal(pA.projectId, 'proj-a')
      assert.equal(pB.projectId, 'aicode-consumers')
      assert.equal(projectCalls, 2)

      await getDynamicAntigravityModels('token-a', { forceRefresh: true })
      assert.equal(resolveUpstreamModel('m-alpha'), 'm-alpha')
      assert.equal(getModelRemainingFraction('m-alpha'), 0.9)

      // Empty response for token-b must NOT clear token-a's dynamicUpstreamMap if returning cached fallback
      await getDynamicAntigravityModels('token-b', { forceRefresh: true })
      assert.equal(resolveUpstreamModel('m-alpha'), 'm-alpha')
    } finally {
      globalThis.fetch = origFetch
      invalidateAntigravityModelCaches()
    }
  })
})

describe('P1-4 & P2-1: CircuitBreaker, Router failover=false, Passthrough verbatim errors & aborts', () => {
  it('never double-decrements halfOpenInFlight on release + recordFailure', () => {
    const breaker = new CircuitBreaker('k', { failureThreshold: 1, cooldownMs: 10_000 })
    breaker.recordFailure(false, { openImmediately: true, cooldownMs: 10_000 })
    const t = Date.now() + 11_000
    const p1 = breaker.allowRequest(t)
    assert.equal(p1.allowed, true)
    assert.equal(p1.usedHalfOpenPermit, true)
    p1.release()
    breaker.recordFailure(p1.usedHalfOpenPermit, { openImmediately: true, cooldownMs: 10_000 })
    // Verify next half-open probe still enforces concurrency 1
    const t2 = Date.now() + 25_000
    const p2 = breaker.allowRequest(t2)
    const p3 = breaker.allowRequest(t2)
    assert.equal(p2.allowed, true)
    assert.equal(p3.allowed, false)
  })

  it('passes through raw error body verbatim when failover is disabled without tripping breakers, and ignores aborts', async () => {
    const router = new GatewayRouter()
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'RAW_UPSTREAM' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'x-custom-err': 'yes' },
      })) as any

    try {
      const pass = new PassthroughModule()
      await pass.init({ gatewayPort: 0, log: () => {}, dataDir: '' })
      const cfg: GatewayConfig = {
        port: 0,
        token: 't',
        authMode: 'token',
        defaultModel: 'claude-sonnet-5.5',
        smallModel: 'claude-sonnet-5.5',
        routes: { 'claude-sonnet-5.5': { module: 'passthrough', targetModel: 'claude-sonnet-5.5', label: 'P' } },
        failover: { enabled: false },
      }
      const res = new MockServerResponse()
      await router.dispatchMessage(
        { model: 'claude-sonnet-5.5', messages: [{ role: 'user', content: 'hi' }] },
        res as unknown as ServerResponse,
        { req: {} as any, headers: {}, clientKey: 'k', log: () => {} },
        cfg,
        { getModule: () => pass } as any,
        () => {}
      )
      assert.equal(res.statusCode, 429)
      assert.equal(res.headers.get('x-custom-err'), 'yes')
      assert.ok(res.text().includes('RAW_UPSTREAM'))
      assert.equal(router.getBreakerStats().length, 0, 'failover.enabled=false must NOT populate breakers')
    } finally {
      globalThis.fetch = origFetch
    }

    // Abort attempt must not recordSuccess or recordFailure
    const abortCfg: GatewayConfig = {
      port: 0,
      token: 't',
      authMode: 'token',
      defaultModel: 'm',
      smallModel: 'm',
      routes: { m: { module: 'mock', targetModel: 'm', label: 'M' } },
      failover: { enabled: true, failureThreshold: 1 },
    }
    const abortRes = new MockServerResponse()
    await router.dispatchMessage(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      abortRes as unknown as ServerResponse,
      { req: {} as any, headers: {}, log: () => {} },
      abortCfg,
      {
        getModule: () => ({
          id: 'mock',
          tryHandleRequest: async (): Promise<RouteAttemptResult> => ({
            committed: false,
            aborted: true,
            status: 499,
            retryable: false,
            message: 'aborted',
          }),
        }),
      } as any,
      () => {}
    )
    assert.equal(router.getBreakerStats()[0]?.state, 'closed')
  })

  it('guards attempted===0 fallback probe concurrently, refreshes cooldown on throw, and records post-header failure', async () => {
    const router = new GatewayRouter()
    const cfg: GatewayConfig = {
      port: 0,
      token: 't',
      authMode: 'token',
      defaultModel: 'm',
      smallModel: 'm',
      routes: {
        m: { module: 'workbuddy', targetModel: 'wb-1', label: 'M' },
        m2: { module: 'workbuddy', targetModel: 'wb-2', label: 'M2' },
      },
      failover: { enabled: true, crossModuleFailover: true, failureThreshold: 1, cooldownSeconds: 30 },
    }
    let probeCalls = 0
    let releaseProbe!: () => void
    const probeGate = new Promise<void>((r) => {
      releaseProbe = r
    })
    let mode: 'open-init' | 'throw-probe' | 'throw-after-header' = 'open-init'
    const fakeHost = {
      getModule: () => ({
        id: 'workbuddy',
        tryHandleRequest: async (_req: any, res: any): Promise<RouteAttemptResult> => {
          if (mode === 'open-init') {
            return { committed: false, status: 429, retryable: true, retryAfterMs: 30_000, message: '429' }
          }
          if (mode === 'throw-probe') {
            probeCalls++
            await probeGate
            throw new Error('probe exploded')
          }
          res.write('event: message_start\ndata: {}\n\n')
          throw new Error('mid stream failure')
        },
      }),
    } as any

    // 1. Open both breakers first
    const r0 = new MockServerResponse()
    await router.dispatchMessage(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      r0 as unknown as ServerResponse,
      { req: {} as any, headers: {}, log: () => {} },
      cfg,
      fakeHost,
      () => {}
    )
    assert.equal(router.getBreakerStats().every((b) => b.state === 'open'), true)

    // 2. Concurrent requests while all breakers are open: only 1 fallback probe runs, other gets 429 immediately
    mode = 'throw-probe'
    const r1 = new MockServerResponse()
    const r2 = new MockServerResponse()
    const p1 = router.dispatchMessage(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      r1 as unknown as ServerResponse,
      { req: {} as any, headers: {}, log: () => {} },
      cfg,
      fakeHost,
      () => {}
    )
    await new Promise((r) => setTimeout(r, 10))
    const p2 = router.dispatchMessage(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      r2 as unknown as ServerResponse,
      { req: {} as any, headers: {}, log: () => {} },
      cfg,
      fakeHost,
      () => {}
    )
    releaseProbe()
    await Promise.all([p1, p2])
    assert.equal(probeCalls, 1)
    assert.equal(r1.statusCode, 502)
    assert.equal(r2.statusCode, 429)
    assert.equal(router.getBreakerStats().find((b) => b.key === 'workbuddy:wb-1')?.failedRequests, 2)

    // 3. Throwing after headersSent must increment failedRequests via recordFailure
    const router2 = new GatewayRouter()
    mode = 'throw-after-header'
    const r3 = new MockServerResponse()
    await router2.dispatchMessage(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      r3 as unknown as ServerResponse,
      { req: {} as any, headers: {}, log: () => {} },
      cfg,
      fakeHost,
      () => {}
    )
    assert.equal(router2.getBreakerStats()[0]?.failedRequests, 1)
  })
})

describe('P2-3, P2-4 & Claude Desktop Lifecycle', () => {
  it('re-init WorkBuddyModule disposes previous shim cleanly without leaking port and shim returns 404 on unknown route', async () => {
    const wb = new WorkBuddyModule()
    await wb.init({ gatewayPort: 0, log: () => {}, dataDir: '' })
    const firstUrl = (wb as any).shimInstance.baseUrl()
    const token1 = (wb as any).shimInstance.token()
    const notFoundRes = await fetch(`${firstUrl}/no-such-route`, {
      headers: { Authorization: `Bearer ${token1}` },
    })
    assert.equal(notFoundRes.status, 404)

    await wb.init({ gatewayPort: 0, log: () => {}, dataDir: '' })
    const secondUrl = (wb as any).shimInstance.baseUrl()
    assert.notEqual(firstUrl, secondUrl)
    await assert.rejects(() => fetch(`${firstUrl}/healthz`, { signal: AbortSignal.timeout(500) }))
    await wb.dispose()
  })

  it('parses netstat LISTENING exact port & tasklist Claude.exe output accurately', () => {
    const netstat = [
      '  TCP    127.0.0.1:43119        0.0.0.0:0              LISTENING       1111',
      '  TCP    127.0.0.1:431190       0.0.0.0:0              LISTENING       2222',
      '  TCP    127.0.0.1:50000        127.0.0.1:43119        ESTABLISHED     3333',
      '  TCP    127.0.0.1:43119        0.0.0.0:0              LISTENING       4444',
    ].join('\n')
    assert.deepEqual(parseListeningPidsForPort(netstat, 43119, 4444), [1111])

    assert.equal(parseWindowsTasklistHasClaude('"Claude.exe","1234","Console","1","120,000 K"'), true)
    assert.equal(parseWindowsTasklistHasClaude('"claude.exe","5678","Console","1","40,000 K"'), true)
    assert.equal(parseWindowsTasklistHasClaude('INFO: No tasks are running which match the specified criteria.'), false)
  })

  it('follows Claude Desktop lifecycle: shuts down on exit, ignores indeterminate probe errors, and serializes withFileLock', async () => {
    const checks: Array<boolean | null> = [true, null, false, false]
    const pluginPolls = [
      { keys: ['agent-gateway@aaaynmmm-plugins'], registered: true, enabled: true, disabled: false },
      { keys: [], registered: false, enabled: false, disabled: true },
      { keys: ['agent-gateway@aaaynmmm-plugins'], registered: true, enabled: true, disabled: false },
    ]
    let exited = false
    let disabled = false
    const stop = createClaudeLifecycleMonitor({
      pollIntervalMs: 10,
      exitConfirmPolls: 2,
      initialRunning: true,
      checkProcess: async () => (checks.length > 0 ? checks.shift()! : false),
      checkPluginState: () =>
        pluginPolls.shift() ?? {
          keys: ['agent-gateway@aaaynmmm-plugins'],
          registered: true,
          enabled: true,
          disabled: false,
        },
      onClaudeExit: () => {
        exited = true
      },
      onPluginDisabled: () => {
        disabled = true
      },
    })
    await new Promise((r) => setTimeout(r, 150))
    stop()
    assert.equal(exited, true)
    assert.equal(disabled, false)

    // Stale/concurrent file lock serialization & CLI bin existence check
    const tmp = mkdtempSync(join(import.meta.dirname, '.tmp-lock-'))
    try {
      const lockPath = join(tmp, 'op.lock')
      mkdirSync(tmp, { recursive: true })
      const order: string[] = []
      await Promise.all([
        withFileLock(lockPath, async () => {
          order.push('1-start')
          await new Promise((r) => setTimeout(r, 30))
          order.push('1-end')
        }),
        withFileLock(lockPath, async () => {
          order.push('2-start')
          order.push('2-end')
        }),
      ])
      assert.deepEqual(order, ['1-start', '1-end', '2-start', '2-end'])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }

    assert.equal(existsSync(join(import.meta.dirname, '..', 'bin', 'agent-gateway.mjs')), true)
  })

  it('creates .bak on initial save, clamps thinkingBudget when max_tokens omitted, and sets 429 retryAfterMs on pre-start SSE error', async () => {
    const tmp = mkdtempSync(join(import.meta.dirname, '.tmp-singlebak-'))
    try {
      const cfgPath = join(tmp, 'config.json')
      saveGatewayConfig(
        {
          port: 43119,
          token: 'initial-only-token',
          authMode: 'token',
          defaultModel: 'm',
          smallModel: 'm',
          routes: {},
        },
        cfgPath
      )
      writeFileSync(cfgPath, '{corrupted', 'utf8')
      const recovered = loadGatewayConfig(cfgPath)
      assert.equal(recovered.token, 'initial-only-token')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }

    const mod = new AntigravityModule()
    await mod.init({ gatewayPort: 0, log: () => {}, dataDir: '' })
    const origTokenFn = antigravityAuth.getAccessToken
    const origFetch = globalThis.fetch
    let capturedBody: any = null

    antigravityAuth.getAccessToken = async () => 'tok-omit-max'
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes(':loadCodeAssist')) {
        return new Response(JSON.stringify({ cloudaicompanionProject: 'proj-omit' }), { status: 200 })
      }
      if (url.includes(':fetchAvailableModels')) {
        return new Response(
          JSON.stringify({
            agentModelSorts: [{ groups: [{ modelIds: ['gemini-3.8-flash-high'] }] }],
            models: { 'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash', maxOutputTokens: 4096 } },
          }),
          { status: 200 }
        )
      }
      capturedBody = JSON.parse(String(init?.body))
      return new Response(makeSseBody([{ error: { code: 8, message: 'pre-start quota' } }]), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as any

    try {
      const res = new MockServerResponse()
      const result = await mod.tryHandleRequest(
        {
          model: 'gemini-3.8-flash-high',
          thinking: { type: 'enabled', budget_tokens: 12000 },
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
        },
        res as unknown as ServerResponse,
        { req: {} as any, headers: {}, log: () => {} },
        'gemini-3.8-flash-high'
      )
      assert.ok(capturedBody.request.generationConfig.thinkingConfig.thinkingBudget < 4096)
      assert.equal(result.committed, false)
      if (!result.committed) {
        assert.equal(result.status, 429)
        assert.ok((result.retryAfterMs ?? 0) >= 30_000)
      }
    } finally {
      antigravityAuth.getAccessToken = origTokenFn
      globalThis.fetch = origFetch
      invalidateAntigravityModelCaches()
    }
  })
})
