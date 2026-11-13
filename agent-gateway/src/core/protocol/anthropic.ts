/**
 * Anthropic Messages API 与 OpenAI chat-completions 之间的双向转换。
 *
 * Claude Code 只会说 Anthropic 的 /v1/messages 协议，而本机 WorkBuddy 插件的
 * 回环 shim 只会说 OpenAI 的 /v1/chat/completions 协议。这个模块负责两件事：
 *
 *  1. 把 Claude Code 发来的 Anthropic 请求体，翻译成 shim 能接受的 OpenAI 请求体；
 *  2. 把 shim 返回的 OpenAI SSE 流，翻译回 Claude Code 认识的 Anthropic SSE 事件。
 *
 * 翻译时丢掉的字段都是有意为之，并且每一处都在下面写了原因：cache_control 是
 * Anthropic 的提示缓存标记，上游没有这个概念；thinking 块来自 Claude 自己，
 * 上游模型不认识它，原样回传只会制造无效 token。
 */

import { randomBytes } from 'node:crypto'
import type { ServerResponse } from 'node:http'

/** Anthropic 内容块的宽松类型；未知类型按“忽略”处理。 */
export interface AnthBlock {
  type: string
  text?: string
  source?: { type?: string; media_type?: string; data?: string; url?: string }
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
  thinking?: string
  data?: string
  title?: string
}

/** Anthropic 消息。 */
export interface AnthMessage {
  role: 'user' | 'assistant' | string
  content: string | AnthBlock[] | null
}

/** Anthropic 工具定义。 */
export interface AnthTool {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

/** Anthropic /v1/messages 请求体里本网关关心的字段。 */
export interface AnthRequest {
  model?: string
  max_tokens?: number
  system?: string | AnthBlock[]
  messages?: AnthMessage[]
  tools?: AnthTool[]
  tool_choice?: unknown
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  stream?: boolean
  thinking?: unknown
  metadata?: unknown
}

/** OpenAI 侧的粗略类型；只用到我们真正读写的字段。 */
interface OaiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | unknown[] | null
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

/** 转换结果：OpenAI 请求体，外加若干条“翻译时丢了什么”的说明。 */
export interface ConvertedRequest {
  body: Record<string, unknown>
  warnings: string[]
}

/** 把 Anthropic 的内容数组统一成数组形态。 */
function blocksOf(content: string | AnthBlock[] | null | undefined): AnthBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (Array.isArray(content)) return content
  return []
}

/** 把 Anthropic 的 base64/url 图片来源翻译成 OpenAI 的 image_url。 */
function imageUrlOf(source: AnthBlock['source'] | undefined): string | undefined {
  if (source === undefined) return undefined
  if (source.type === 'base64' && typeof source.data === 'string') {
    const media = source.media_type ?? 'image/png'
    return `data:${media};base64,${source.data}`
  }
  if ((source.type === 'url' || source.type === undefined) && typeof source.url === 'string') {
    return source.url
  }
  return undefined
}

/**
 * 把一条 tool_result 的内容压平成“文本 + 图片列表”。
 *
 * OpenAI 的 tool 角色只接受字符串内容，所以文本直接拼接；如果结果里带截图，
 * 这些图片由调用方作为一条紧随其后的 user 消息补发，而不是塞进 tool 消息里。
 */
function flattenToolResult(block: AnthBlock): { text: string; images: string[] } {
  const raw = block.content
  if (typeof raw === 'string') return { text: raw, images: [] }
  if (!Array.isArray(raw)) return { text: raw === undefined || raw === null ? '' : String(raw), images: [] }
  const texts: string[] = []
  const images: string[] = []
  for (const part of raw as AnthBlock[]) {
    if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text)
    else if (part.type === 'image') {
      const url = imageUrlOf(part.source)
      if (url !== undefined) images.push(url)
    } else if (part.type === 'document') {
      texts.push('[document omitted: the WorkBuddy gateway cannot forward file blocks]')
    }
  }
  return { text: texts.join('\n'), images }
}

/** 只有纯文本时压成字符串，上游模型对字符串形式的 content 兼容性最好。 */
function collapseParts(parts: unknown[]): string | unknown[] {
  const allText = parts.every(part => typeof part === 'object' && part !== null && (part as { type?: string }).type === 'text')
  if (allText) return parts.map(part => (part as { text: string }).text).join('\n')
  return parts
}

/**
 * 把 Anthropic 请求体翻译成 OpenAI 请求体。
 *
 * `model` 由调用方决定，因为模型名的映射（claude-* → WorkBuddy 模型 id）属于
 * 网关的配置，不属于协议翻译。
 */
export function toOpenAIRequest(input: AnthRequest, model: string): ConvertedRequest {
  const warnings: string[] = []
  const messages: OaiMessage[] = []

  // Anthropic 的 system 可以是字符串或内容块数组；OpenAI 只接受一条 system 消息。
  const systemBlocks = blocksOf(input.system as string | AnthBlock[] | undefined)
  const systemText = systemBlocks
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n\n')
  if (systemText !== '') messages.push({ role: 'system', content: systemText })

  for (const message of input.messages ?? []) {
    const blocks = blocksOf(message.content)

    if (message.role === 'assistant') {
      let text = ''
      const toolCalls: NonNullable<OaiMessage['tool_calls']> = []
      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') text += block.text
        else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id ?? `toolu_${randomBytes(8).toString('hex')}`,
            type: 'function',
            function: { name: block.name ?? '', arguments: JSON.stringify(block.input ?? {}) },
          })
        }
        // thinking / redacted_thinking：上游模型不认识 Anthropic 的思考块，
        // 原样回传只会让模型把签名当成正文，所以这里直接丢弃。
      }
      const out: OaiMessage = { role: 'assistant', content: text }
      if (toolCalls.length > 0) out.tool_calls = toolCalls
      messages.push(out)
      continue
    }

    // user：文本与图片累积成一条消息；tool_result 必须拆成独立的 tool 消息，
    // 且顺序上要紧跟在带 tool_calls 的 assistant 消息之后，所以遇到它就先冲刷。
    let pending: unknown[] = []
    const flushUser = (): void => {
      if (pending.length === 0) return
      messages.push({ role: 'user', content: collapseParts(pending) })
      pending = []
    }
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') {
        pending.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        const url = imageUrlOf(block.source)
        if (url !== undefined) pending.push({ type: 'image_url', image_url: { url } })
        else warnings.push('an image block had no usable source and was dropped')
      } else if (block.type === 'tool_result') {
        flushUser()
        const { text, images } = flattenToolResult(block)
        messages.push({
          role: 'tool',
          tool_call_id: block.tool_use_id ?? '',
          content: text === '' ? '(the tool produced no output)' : text,
        })
        if (images.length > 0) {
          messages.push({ role: 'user', content: images.map(url => ({ type: 'image_url', image_url: { url } })) })
        }
      } else if (block.type === 'document') {
        pending.push({ type: 'text', text: '[document omitted: the WorkBuddy gateway cannot forward file blocks]' })
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        // 同 assistant 分支：丢弃。
      } else if (typeof block.text === 'string') {
        pending.push({ type: 'text', text: block.text })
      }
    }
    flushUser()
  }

  const body: Record<string, unknown> = { model, messages, stream: true }
  if (typeof input.max_tokens === 'number') body['max_tokens'] = input.max_tokens
  if (typeof input.temperature === 'number') body['temperature'] = input.temperature
  if (typeof input.top_p === 'number') body['top_p'] = input.top_p
  if (Array.isArray(input.stop_sequences) && input.stop_sequences.length > 0) body['stop'] = input.stop_sequences

  if (Array.isArray(input.tools) && input.tools.length > 0) {
    body['tools'] = input.tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.input_schema ?? { type: 'object', properties: {} },
      },
    }))
    const choice = input.tool_choice as { type?: string; name?: string } | undefined
    if (choice?.type === 'auto') body['tool_choice'] = 'auto'
    else if (choice?.type === 'any') body['tool_choice'] = 'required'
    else if (choice?.type === 'none') body['tool_choice'] = 'none'
    else if (choice?.type === 'tool' && typeof choice.name === 'string') {
      body['tool_choice'] = { type: 'function', function: { name: choice.name } }
    }
  }

  return { body, warnings }
}

/** 粗略估算 token 数：中日韩字符按 1 个 token 计，其余按 4 个字符 1 个 token 计。 */
export function estimateTokens(text: string): number {
  let tokens = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    tokens += code > 0x2e80 ? 1 : 0.25
  }
  return Math.max(1, Math.ceil(tokens))
}

/** 估算 Anthropic 请求体的输入 token 数，供 count_tokens 与 message_start 使用。 */
export function estimateRequestTokens(input: AnthRequest): number {
  let text = ''
  const systemBlocks = blocksOf(input.system as string | AnthBlock[] | undefined)
  for (const block of systemBlocks) if (typeof block.text === 'string') text += block.text
  for (const message of input.messages ?? []) {
    for (const block of blocksOf(message.content)) {
      if (typeof block.text === 'string') text += block.text
      else if (block.type === 'tool_use') text += JSON.stringify(block.input ?? {})
      else if (block.type === 'tool_result') text += JSON.stringify(block.content ?? '')
    }
  }
  for (const tool of input.tools ?? []) text += `${tool.name}${tool.description ?? ''}${JSON.stringify(tool.input_schema ?? {})}`
  return estimateTokens(text)
}

/** 把 Anthropic 错误体写成 Claude Code 能识别的格式。 */
export function errorPayload(type: string, message: string): string {
  return JSON.stringify({ type: 'error', error: { type, message } })
}

/** HTTP 状态码到 Anthropic 错误类型的映射。 */
export function errorTypeForStatus(status: number): string {
  if (status === 400 || status === 422) return 'invalid_request_error'
  if (status === 401) return 'authentication_error'
  if (status === 403) return 'permission_error'
  if (status === 404) return 'not_found_error'
  if (status === 413) return 'request_too_large'
  if (status === 429) return 'rate_limit_error'
  if (status === 503 || status === 529) return 'overloaded_error'
  return 'api_error'
}

/**
 * 一条 OpenAI SSE 里的增量汇总出来的状态。
 *
 * 流式与一次性响应共用这个结构：流式时它决定何时开关 Anthropic 内容块，
 * 非流式时它就是最终消息的内容来源。
 */
interface ToolCallState {
  id: string
  name: string
  started: boolean
  pending: string
  blockIndex: number
}

/** 把一个 HTTP 响应按 SSE 行拆开；返回每一条 data 载荷。 */
async function* sseData(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      if (line.startsWith('data:')) yield line.slice(5).trim()
      index = buffer.indexOf('\n')
    }
  }
  buffer += decoder.decode()
  const tail = buffer.replace(/\r$/, '')
  if (tail.startsWith('data:')) yield tail.slice(5).trim()
}

/** 把上游的 finish_reason 翻译成 Anthropic 的 stop_reason。 */
function stopReasonOf(finishReason: string, sawToolCall: boolean): string {
  if (sawToolCall || finishReason === 'tool_calls') return 'tool_use'
  if (finishReason === 'length') return 'max_tokens'
  return 'end_turn'
}

/** 流式转换的落笔对象；两个实现（SSE 直写、非流式汇总）共用同一套状态机。 */
interface Sink {
  messageStart(usage: { input_tokens: number; output_tokens: number }): void
  openText(): void
  openTool(state: ToolCallState): void
  textDelta(text: string): void
  toolDelta(state: ToolCallState, partial: string): void
  closeBlock(): void
  messageDelta(stopReason: string, usage: { input_tokens: number; output_tokens: number }): void
  messageStop(): void
}

/** 直接把 Anthropic SSE 事件写到 HTTP 响应里。 */
class SseSink implements Sink {
  private blockOpen = false

  constructor(private readonly res: ServerResponse, private readonly model: string) {}

  private event(name: string, data: unknown): void {
    this.res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  messageStart(usage: { input_tokens: number; output_tokens: number }): void {
    this.event('message_start', {
      type: 'message_start',
      message: {
        id: `msg_${randomBytes(12).toString('hex')}`,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...usage, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    })
  }

  openText(): void {
    this.event('content_block_start', { type: 'content_block_start', index: this.nextIndex(), content_block: { type: 'text', text: '' } })
    this.blockOpen = true
  }

  openTool(state: ToolCallState): void {
    this.event('content_block_start', {
      type: 'content_block_start',
      index: this.nextIndex(),
      content_block: { type: 'tool_use', id: state.id, name: state.name, input: {} },
    })
    this.blockOpen = true
  }

  textDelta(text: string): void {
    this.event('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'text_delta', text } })
  }

  toolDelta(_state: ToolCallState, partial: string): void {
    this.event('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'input_json_delta', partial_json: partial } })
  }

  closeBlock(): void {
    if (!this.blockOpen) return
    this.event('content_block_stop', { type: 'content_block_stop', index: this.index })
    this.blockOpen = false
  }

  messageDelta(stopReason: string, usage: { input_tokens: number; output_tokens: number }): void {
    this.event('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } })
  }

  messageStop(): void {
    this.event('message_stop', { type: 'message_stop' })
  }

  private index = -1

  private nextIndex(): number {
    this.index += 1
    return this.index
  }
}

/** 非流式响应：把同一套事件累积成一条完整消息。 */
class CollectSink implements Sink {
  blocks: ({ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: string })[] = []
  stopReason = 'end_turn'
  usage = { input_tokens: 0, output_tokens: 0 }
  private index = -1

  messageStart(usage: { input_tokens: number; output_tokens: number }): void {
    this.usage = usage
  }

  openText(): void {
    this.index += 1
    this.blocks.push({ type: 'text', text: '' })
  }

  openTool(state: ToolCallState): void {
    this.index += 1
    this.blocks.push({ type: 'tool_use', id: state.id, name: state.name, input: '' })
  }

  textDelta(text: string): void {
    const block = this.blocks[this.index]
    if (block?.type === 'text') block.text += text
  }

  toolDelta(_state: ToolCallState, partial: string): void {
    const block = this.blocks[this.index]
    if (block?.type === 'tool_use') block.input += partial
  }

  closeBlock(): void {}

  messageDelta(stopReason: string, usage: { input_tokens: number; output_tokens: number }): void {
    this.stopReason = stopReason
    this.usage = usage
  }

  messageStop(): void {}

  finalMessage(model: string): Record<string, unknown> {
    const content = this.blocks.map(block => {
      if (block.type === 'text') return { type: 'text', text: block.text }
      let input: unknown = {}
      try {
        input = JSON.parse(block.input === '' ? '{}' : block.input)
      } catch {
        input = {}
      }
      return { type: 'tool_use', id: block.id, name: block.name, input }
    })
    return {
      id: `msg_${randomBytes(12).toString('hex')}`,
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: this.stopReason,
      stop_sequence: null,
      usage: { ...this.usage, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }
  }
}

/**
 * 驱动状态机的唯一入口：读 OpenAI SSE，按 Anthropic 的规矩开关内容块。
 *
 * OpenAI 的 tool_calls 是按 index 并行的增量，而 Anthropic 的内容块必须一条
 * 一条串行出现，所以遇到“另一个工具”或“正文”时，先关掉当前块再开新块。
 */
async function drive(body: AsyncIterable<Uint8Array>, sink: Sink, inputTokens: number, onWarning: (text: string) => void): Promise<void> {
  const tools = new Map<number, ToolCallState>()
  let current: 'text' | 'tool' | undefined
  let currentTool: number | undefined
  let finishReason = ''
  let usage = { input_tokens: inputTokens, output_tokens: 0 }
  let started = false
  let emitted = false
  let lastToolBlock = -1

  const ensureStart = (): void => {
    if (started) return
    started = true
    sink.messageStart(usage)
  }

  const closeCurrent = (): void => {
    if (current === undefined) return
    sink.closeBlock()
    current = undefined
    currentTool = undefined
  }

  ensureStart()

  for await (const payload of sseData(body)) {
    if (payload === '[DONE]') break
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(payload) as Record<string, unknown>
    } catch {
      onWarning(`skipped a malformed upstream frame: ${payload.slice(0, 200)}`)
      continue
    }
    if (typeof frame['error'] === 'object' && frame['error'] !== null) {
      const error = frame['error'] as { message?: string }
      throw new Error(error.message ?? 'upstream reported an error mid-stream')
    }
    // 上游有些帧把 usage 显式写成 null，不能只判断 undefined。
    const rawUsage = frame['usage'] as { prompt_tokens?: number; completion_tokens?: number } | null | undefined
    if (rawUsage !== undefined && rawUsage !== null) {
      if (typeof rawUsage.prompt_tokens === 'number') usage.input_tokens = rawUsage.prompt_tokens
      if (typeof rawUsage.completion_tokens === 'number') usage.output_tokens = rawUsage.completion_tokens
    }
    const choices = frame['choices'] as { delta?: Record<string, unknown>; finish_reason?: string }[] | undefined
    if (!Array.isArray(choices) || choices.length === 0) continue
    const choice = choices[0]
    if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') finishReason = choice.finish_reason
    const delta = choice.delta ?? {}

    // 正文增量：如果当前开的是工具块，先关掉它，Anthropic 不接受穿插。
    const content = delta['content']
    if (typeof content === 'string' && content !== '') {
      if (current !== 'text') {
        closeCurrent()
        sink.openText()
        current = 'text'
      }
      sink.textDelta(content)
      emitted = true
    }

    // 工具增量：每个 OpenAI index 对应一个 Anthropic tool_use 块。
    const rawCalls = delta['tool_calls']
    if (Array.isArray(rawCalls)) {
      for (const call of rawCalls as { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]) {
        const index = typeof call.index === 'number' ? call.index : 0
        let state = tools.get(index)
        if (state === undefined) {
          state = { id: call.id ?? `toolu_${randomBytes(8).toString('hex')}`, name: '', started: false, pending: '', blockIndex: -1 }
          tools.set(index, state)
        }
        if (typeof call.id === 'string' && call.id !== '') state.id = call.id
        if (typeof call.function?.name === 'string' && call.function.name !== '') state.name = call.function.name
        const args = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
        // 名字还没到就先攒参数；Anthropic 的 content_block_start 必须带名字。
        if (!state.started) {
          state.pending += args
          if (state.name !== '') {
            closeCurrent()
            sink.openTool(state)
            state.started = true
            state.blockIndex = ++lastToolBlock
            current = 'tool'
            currentTool = index
            if (state.pending !== '') {
              sink.toolDelta(state, state.pending)
              state.pending = ''
            }
            emitted = true
          }
        } else {
          if (current !== 'tool' || currentTool !== index) {
            // 上游让两个工具交叉出现：Anthropic 只能串行，所以把前一个块关掉。
            closeCurrent()
            current = 'tool'
            currentTool = index
            // 重新打开同一个工具的运行块：参数继续追加到同一个 tool_use 内容块里，
            // 但 Anthropic 的块一旦关了就不能续，这里只能开一个同名新块。
            sink.openTool(state)
            state.blockIndex = ++lastToolBlock
          }
          if (args !== '') sink.toolDelta(state, args)
          emitted = true
        }
      }
    }
  }

  closeCurrent()
  if (!emitted) {
    // 一个字都没有：Anthropic 也要求至少一个空文本块，否则客户端会认为消息为空。
    sink.openText()
    closeCurrent()
  }
  sink.messageDelta(stopReasonOf(finishReason, tools.size > 0), usage)
  sink.messageStop()
}

/** 把 shim 返回的 OpenAI SSE 流式翻译成 Anthropic SSE 并直接写回客户端。 */
export async function streamAnthropic(
  body: AsyncIterable<Uint8Array>,
  res: ServerResponse,
  model: string,
  inputTokens: number,
  onWarning: (text: string) => void,
): Promise<void> {
  await drive(body, new SseSink(res, model), inputTokens, onWarning)
}

/** 把 shim 返回的 OpenAI SSE 汇总成一条完整的 Anthropic 消息（非流式请求用）。 */
export async function collectAnthropic(
  body: AsyncIterable<Uint8Array>,
  model: string,
  inputTokens: number,
  onWarning: (text: string) => void,
): Promise<Record<string, unknown>> {
  const sink = new CollectSink()
  await drive(body, sink, inputTokens, onWarning)
  return sink.finalMessage(model)
}
