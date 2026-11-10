/**
 * 冒烟测试：直接向本地网关发 Anthropic 请求，验证三类典型流量。
 *
 * 用法：node scripts/smoke.mjs [text|tool|nostream|count]
 * 网关必须已经在运行（node dist/server.js serve）。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const config = JSON.parse(readFileSync(join(homedir(), '.workbuddy-claude', 'config.json'), 'utf8'))
const base = `http://127.0.0.1:${config.port}`
const headers = { 'content-type': 'application/json', 'x-api-key': config.token }

/** 发请求并在需要时把 SSE 解析成事件列表。 */
async function call(body) {
  const response = await fetch(`${base}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!response.ok) {
    console.error(`HTTP ${response.status}: ${await response.text()}`)
    process.exit(1)
  }
  if (body.stream === false) return { json: await response.json() }
  const text = await response.text()
  const events = []
  for (const block of text.split('\n\n')) {
    const name = /^event: (.+)$/m.exec(block)
    const data = /^data: (.+)$/m.exec(block)
    if (name !== null && data !== null) events.push({ name: name[1], data: JSON.parse(data[1]) })
  }
  return { events }
}

/** 从事件流里拼出正文与工具调用，便于人眼检查。 */
function summarize(events) {
  let text = ''
  const tools = []
  let stopReason = ''
  for (const event of events) {
    if (event.name === 'content_block_delta' && event.data.delta.type === 'text_delta') text += event.data.delta.text
    if (event.name === 'content_block_start' && event.data.content_block.type === 'tool_use') {
      tools.push({ id: event.data.content_block.id, name: event.data.content_block.name })
    }
    if (event.name === 'message_delta') stopReason = event.data.delta.stop_reason
  }
  return { text, tools, stopReason }
}

const which = process.argv[2] ?? 'text'

if (which === 'text') {
  const { events } = await call({ model: process.env.SMOKE_MODEL ?? 'claude-sonnet-5-5', max_tokens: 100, stream: true, messages: [{ role: 'user', content: '用一句话解释什么是递归。' }] })
  console.log(summarize(events))
} else if (which === 'tool') {
  const { events } = await call({
    model: process.env.SMOKE_MODEL ?? 'claude-sonnet-5-5',
    max_tokens: 300,
    stream: true,
    tools: [{
      name: 'get_weather',
      description: 'Get the current weather for a city',
      input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    }],
    messages: [{ role: 'user', content: '北京现在天气怎么样？必须调用 get_weather 工具来查。' }],
  })
  console.log(summarize(events))
  console.log('raw events:', JSON.stringify(events.filter(e => e.data.content_block?.type === 'tool_use' || e.data.delta?.type === 'input_json_delta')))
} else if (which === 'nostream') {
  const { json } = await call({ model: process.env.SMOKE_MODEL ?? 'claude-sonnet-5-5', max_tokens: 100, stream: false, messages: [{ role: 'user', content: '用一句话介绍你自己。' }] })
  console.log(json)
} else if (which === 'loop') {
  // 多轮工具回合：先让模型发起调用，再把工具结果回传，验证 role:"tool" 的翻译。
  const tools = [{
    name: 'get_weather',
    description: 'Get the current weather for a city',
    input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  }]
  const first = await call({
    model: process.env.SMOKE_MODEL ?? 'claude-sonnet-5-5',
    max_tokens: 300,
    stream: true,
    tools,
    messages: [{ role: 'user', content: '北京现在天气怎么样？必须调用 get_weather 工具来查。' }],
  })
  const summary = summarize(first.events)
  const toolUse = first.events.find(e => e.data.content_block?.type === 'tool_use')?.data.content_block
  if (toolUse === undefined) {
    console.log('first turn produced no tool call', summary)
    process.exit(1)
  }
  const input = first.events
    .filter(e => e.data.delta?.type === 'input_json_delta')
    .map(e => e.data.delta.partial_json)
    .join('')
  console.log('first turn:', summary.tools)
  const second = await call({
    model: process.env.SMOKE_MODEL ?? 'claude-sonnet-5-5',
    max_tokens: 300,
    stream: true,
    tools,
    messages: [
      { role: 'user', content: '北京现在天气怎么样？必须调用 get_weather 工具来查。' },
      { role: 'assistant', content: [{ type: 'tool_use', id: toolUse.id, name: toolUse.name, input: JSON.parse(input) }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: [{ type: 'text', text: '晴，22 摄氏度' }] }] },
    ],
  })
  console.log('second turn:', summarize(second.events))
} else if (which === 'fingerprint') {
  // Claude Code 的真实系统提示开头：上游有针对它的渠道校验，这里验证还能不能通过。
  const { events } = await call({
    model: process.env.SMOKE_MODEL ?? 'claude-sonnet-5-5',
    max_tokens: 100,
    stream: true,
    system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
    messages: [{ role: 'user', content: '回答一个字：好' }],
  })
  console.log(summarize(events))
} else if (which === 'count') {
  const response = await fetch(`${base}/v1/messages/count_tokens`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: process.env.SMOKE_MODEL ?? 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'hello world' }] }),
  })
  console.log(await response.json())
} else {
  console.error('usage: node scripts/smoke.mjs [text|tool|nostream|count]')
}
