/**
 * Anthropic Messages ↔ Google Gemini / Antigravity 格式转换器。
 * 完善支持函数调用 (Tool Use / Function Calling) 及 JSON Schema 规范清洗。
 */

import type {
  AnthropicRequest,
  AnthropicTool,
} from '../../core/types.ts'

export interface GeminiPart {
  text?: string
  inlineData?: {
    mimeType: string
    data: string
  }
  functionCall?: {
    name: string
    args: Record<string, unknown>
  }
  functionResponse?: {
    name: string
    response: Record<string, unknown>
  }
  thought?: boolean | string
  thoughtSignature?: string
}

export interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

export interface GeminiRequest {
  contents: GeminiContent[]
  systemInstruction?: {
    parts: Array<{ text: string }>
  }
  generationConfig?: {
    temperature?: number
    maxOutputTokens?: number
    topP?: number
    thinkingConfig?: {
      thinkingBudget?: number
    }
  }
  tools?: Array<{
    functionDeclarations: Array<{
      name: string
      description?: string
      parameters: Record<string, unknown>
    }>
  }>
}

/**
 * 清洗 Anthropic JSON Schema，转换为 Google Gemini Protobuf Schema 严格兼容格式。
 * 彻底过滤 Gemini 不支持的 $schema, propertyNames, exclusiveMinimum, const, additionalProperties 等字段。
 */
export function cleanSchemaForGemini(schema: any): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} }
  }

  // 若出现 anyOf / oneOf（常见于可选类型 string | null 或联合类型），优先提取首个有效非 null 分支并保留说明
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const branches = (schema.anyOf ?? schema.oneOf) as any[]
    const nonNull = branches.find((b) => b && typeof b === 'object' && b.type !== 'null') ?? branches[0]
    if (nonNull && typeof nonNull === 'object') {
      const merged = {
        ...nonNull,
        ...(schema.description && !nonNull.description ? { description: schema.description } : {}),
      }
      return cleanSchemaForGemini(merged)
    }
  }

  const cleaned: Record<string, unknown> = {}

  // 1. 类型映射（兼容 JSON Schema 2020-12 类型数组如 ['string', 'null'] 与 'null'）
  let rawType = schema.type
  if (Array.isArray(rawType)) {
    const nonNull = rawType.find((t: unknown) => typeof t === 'string' && t.toLowerCase() !== 'null')
    rawType = typeof nonNull === 'string' ? nonNull : 'string'
  }
  if (typeof rawType === 'string') {
    const lowered = rawType.toLowerCase()
    cleaned.type = lowered === 'null' ? 'string' : lowered
  } else if (!rawType && schema.properties) {
    cleaned.type = 'object'
  }

  // 2. description
  if (typeof schema.description === 'string' && schema.description) {
    cleaned.description = schema.description
  }

  // 3. const / enum 处理
  if (schema.const !== undefined) {
    cleaned.enum = [String(schema.const)]
  } else if (Array.isArray(schema.enum)) {
    cleaned.enum = schema.enum.map(String)
  }

  // 4. properties 递归清洗
  if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
    const props: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(schema.properties)) {
      // 属性名必须合法
      if (k.startsWith('$')) continue
      props[k] = cleanSchemaForGemini(v)
    }
    cleaned.properties = props
  }

  // 5. required 数组过滤
  if (Array.isArray(schema.required)) {
    const validRequired = schema.required.filter(
      (item: any) => typeof item === 'string' && (!cleaned.properties || (cleaned.properties as any)[item] !== undefined)
    )
    if (validRequired.length > 0) {
      cleaned.required = validRequired
    }
  }

  // 6. items (用于 array；tuple 数组取首项清洗以兼容 Gemini 单 Schema 要求)
  if (Array.isArray(schema.items)) {
    cleaned.items = schema.items.length > 0 ? cleanSchemaForGemini(schema.items[0]) : { type: 'string' }
  } else if (schema.items) {
    cleaned.items = cleanSchemaForGemini(schema.items)
  }

  // 7. 数值边界转换
  if (typeof schema.minimum === 'number') {
    cleaned.minimum = schema.minimum
  } else if (typeof schema.exclusiveMinimum === 'number') {
    cleaned.minimum = schema.exclusiveMinimum
  }
  if (typeof schema.maximum === 'number') {
    cleaned.maximum = schema.maximum
  } else if (typeof schema.exclusiveMaximum === 'number') {
    cleaned.maximum = schema.exclusiveMaximum
  }

  // 确保根对象或含有 properties 的对象具备 type: 'object'
  if (!cleaned.type && cleaned.properties) {
    cleaned.type = 'object'
  }

  return cleaned
}

export interface GeminiConvertOptions {
  thoughtSignatureByToolId?: Map<string, string>
  fallbackThoughtSignature?: string
}

/** 把 Anthropic 的消息流转换为 Gemini 格式 */
export function toGeminiRequest(
  req: AnthropicRequest,
  options: GeminiConvertOptions = {}
): GeminiRequest {
  const contents: GeminiContent[] = []
  // 维护 tool_use_id -> tool_name 映射，供下一轮 tool_result 查找真实函数名
  const toolIdToName = new Map<string, string>()

  // 预扫描所有已存在的 tool_use 记录
  for (const msg of req.messages ?? []) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'tool_use' && (part as any).id && (part as any).name) {
          toolIdToName.set((part as any).id, (part as any).name)
        }
      }
    }
  }

  // 1. 系统提示词转换（过滤空块，避免空数组或无 text 字段产生空/undefined systemInstruction）
  let systemInstruction: GeminiRequest['systemInstruction'] = undefined
  if (req.system) {
    const sysText = typeof req.system === 'string'
      ? req.system
      : req.system
          .filter((s: any) => s && typeof s.text === 'string' && s.text.length > 0)
          .map((s: any) => s.text)
          .join('\n\n')
    if (sysText.length > 0) {
      systemInstruction = {
        parts: [{ text: sysText }],
      }
    }
  }

  // 2. 对话历史转换（支持图片多模态，并按 Gemini 规范合并相邻同 role 消息）
  for (const msg of req.messages ?? []) {
    const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user'
    const parts: GeminiPart[] = []

    if (typeof msg.content === 'string') {
      if (msg.content) parts.push({ text: msg.content })
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text' && typeof (part as any).text === 'string') {
          if ((part as any).text) parts.push({ text: (part as any).text })
        } else if (part.type === 'image' && (part as any).source) {
          const src = (part as any).source
          if (src.type === 'base64' && typeof src.data === 'string' && src.data) {
            parts.push({
              inlineData: {
                mimeType: src.media_type || 'image/png',
                data: src.data,
              },
            })
          }
        } else if (part.type === 'tool_use') {
          const toolId = typeof (part as any).id === 'string' ? (part as any).id : ''
          const cachedSig = toolId ? options.thoughtSignatureByToolId?.get(toolId) : undefined
          const sig = cachedSig || (part as any).signature || options.fallbackThoughtSignature
          const fcPart: GeminiPart = {
            functionCall: {
              name: (part as any).name,
              args: (part as any).input ?? {},
            },
          }
          if (typeof sig === 'string' && sig) {
            fcPart.thoughtSignature = sig
          }
          parts.push(fcPart)
        } else if (part.type === 'tool_result') {
          const toolUseId = (part as any).tool_use_id
          const functionName = toolIdToName.get(toolUseId) || 'tool_result'
          let output: Record<string, unknown> = {}
          const c = (part as any).content
          const nestedImages: GeminiPart[] = []
          if (typeof c === 'string') {
            try {
              const parsed = JSON.parse(c)
              output =
                parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                  ? (parsed as Record<string, unknown>)
                  : { result: parsed }
            } catch {
              output = { result: c }
            }
          } else if (Array.isArray(c)) {
            const textParts: string[] = []
            for (const item of c) {
              if (!item || typeof item !== 'object') continue
              if (item.type === 'text' && typeof item.text === 'string' && item.text) {
                textParts.push(item.text)
              } else if (item.type === 'image' && item.source?.type === 'base64' && item.source.data) {
                nestedImages.push({
                  inlineData: {
                    mimeType: item.source.media_type || 'image/png',
                    data: item.source.data,
                  },
                })
              }
            }
            output = { result: textParts.join('\n') }
          } else if (c && typeof c === 'object') {
            output = c
          } else if (c !== undefined && c !== null) {
            output = { result: c }
          }

          if ((part as any).is_error === true) {
            output = { ...output, is_error: true }
          }

          parts.push({
            functionResponse: {
              name: functionName,
              response: output,
            },
          })
          for (const imgPart of nestedImages) {
            parts.push(imgPart)
          }
        }
      }
    }

    if (parts.length > 0) {
      const last = contents[contents.length - 1]
      if (last && last.role === role) {
        last.parts.push(...parts)
      } else {
        contents.push({ role, parts })
      }
    }
  }

  // 3. 生成配置
  const generationConfig: GeminiRequest['generationConfig'] = {}
  if (typeof req.temperature === 'number') generationConfig.temperature = req.temperature
  if (typeof req.max_tokens === 'number') generationConfig.maxOutputTokens = req.max_tokens
  if (req.thinking && req.thinking.budget_tokens) {
    generationConfig.thinkingConfig = {
      thinkingBudget: req.thinking.budget_tokens,
    }
  }

  // 4. 工具定义转换 (去重并执行深度 schema 清洗)
  let tools: GeminiRequest['tools'] = undefined
  if (req.tools && req.tools.length > 0) {
    const uniqueTools: AnthropicTool[] = []
    const seenToolNames = new Set<string>()
    for (const t of req.tools) {
      if (!t || typeof t.name !== 'string' || !t.name || seenToolNames.has(t.name)) continue
      seenToolNames.add(t.name)
      uniqueTools.push(t)
    }

    const functionDeclarations = uniqueTools.map((t: AnthropicTool) => ({
      name: t.name,
      description: t.description?.trim() || t.name,
      parameters: cleanSchemaForGemini(t.input_schema),
    }))

    if (functionDeclarations.length > 0) {
      tools = [{ functionDeclarations }]
    }
  }

  return {
    contents,
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
    ...(tools ? { tools } : {}),
  }
}
