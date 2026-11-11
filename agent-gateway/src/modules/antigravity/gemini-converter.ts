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
  functionCall?: {
    name: string
    args: Record<string, unknown>
  }
  functionResponse?: {
    name: string
    response: Record<string, unknown>
  }
  thought?: string
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

  const cleaned: Record<string, unknown> = {}

  // 1. 类型映射
  let type = schema.type
  if (typeof type === 'string') {
    type = type.toLowerCase()
    // Gemini 支持: object, string, number, integer, boolean, array
    cleaned.type = type
  } else if (!type && schema.properties) {
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

  // 6. items (用于 array)
  if (schema.items) {
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

/** 把 Anthropic 的消息流转换为 Gemini 格式 */
export function toGeminiRequest(req: AnthropicRequest): GeminiRequest {
  const contents: GeminiContent[] = []
  // 维护 tool_use_id -> tool_name 映射，供下一轮 tool_result 查找真实函数名
  const toolIdToName = new Map<string, string>()

  // 预扫描所有已存在的 tool_use 记录
  for (const msg of req.messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'tool_use' && (part as any).id && (part as any).name) {
          toolIdToName.set((part as any).id, (part as any).name)
        }
      }
    }
  }

  // 1. 系统提示词转换
  let systemInstruction: GeminiRequest['systemInstruction'] = undefined
  if (req.system) {
    const sysText = typeof req.system === 'string'
      ? req.system
      : req.system.map(s => s.text).join('\n\n')
    systemInstruction = {
      parts: [{ text: sysText }],
    }
  }

  // 2. 对话历史转换
  for (const msg of req.messages) {
    const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user'
    const parts: GeminiPart[] = []

    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content })
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text' && typeof (part as any).text === 'string') {
          parts.push({ text: (part as any).text })
        } else if (part.type === 'tool_use') {
          parts.push({
            functionCall: {
              name: (part as any).name,
              args: (part as any).input ?? {},
            },
          })
        } else if (part.type === 'tool_result') {
          const toolUseId = (part as any).tool_use_id
          const functionName = toolIdToName.get(toolUseId) || 'tool_result'
          let output: Record<string, unknown> = {}
          const c = (part as any).content
          if (typeof c === 'string') {
            try {
              output = JSON.parse(c)
            } catch {
              output = { result: c }
            }
          } else if (Array.isArray(c)) {
            output = { result: c.map(item => item.text ?? '').join('\n') }
          } else if (c && typeof c === 'object') {
            output = c
          }

          parts.push({
            functionResponse: {
              name: functionName,
              response: output,
            },
          })
        }
      }
    }

    if (parts.length > 0) {
      contents.push({ role, parts })
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

  // 4. 工具定义转换 (经过深度 schema 清洗，移除 $schema / propertyNames / const 等)
  let tools: GeminiRequest['tools'] = undefined
  if (req.tools && req.tools.length > 0) {
    const functionDeclarations = req.tools.map((t: AnthropicTool) => {
      const cleanedParams = cleanSchemaForGemini(t.input_schema)
      return {
        name: t.name,
        description: t.description || t.name,
        parameters: cleanedParams,
      }
    })

    tools = [{ functionDeclarations }]
  }

  return {
    contents,
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
    ...(tools ? { tools } : {}),
  }
}
