/**
 * Anthropic Messages ↔ Google Gemini / Antigravity 格式转换器。
 * 完善支持函数调用 (Tool Use / Function Calling) 及 JSON Schema 规范清洗。
 */

import { createHash } from 'node:crypto'
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
  fileData?: {
    mimeType: string
    fileUri: string
  }
  functionCall?: {
    id?: string
    name: string
    args: Record<string, unknown>
  }
  functionResponse?: {
    id?: string
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
    topK?: number
    stopSequences?: string[]
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
  toolConfig?: {
    functionCallingConfig: {
      mode: 'AUTO' | 'ANY' | 'NONE'
      allowedFunctionNames?: string[]
    }
  }
}

export function hashThinkingText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function resolveLocalRef(
  ref: string,
  rootSchema: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!ref.startsWith('#/')) return undefined
  const segments = ref.slice(2).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
  let cur: unknown = rootSchema
  for (const seg of segments) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur && typeof cur === 'object' && !Array.isArray(cur)
    ? (cur as Record<string, unknown>)
    : undefined
}

function mergeAllOfSchemas(branches: unknown[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  const mergedProps: Record<string, unknown> = {}
  const mergedRequired = new Set<string>()
  let hasProps = false

  for (const branch of branches) {
    if (!branch || typeof branch !== 'object' || Array.isArray(branch)) continue
    const b = branch as Record<string, unknown>
    if (b.type && !merged.type) merged.type = b.type
    if (typeof b.description === 'string' && b.description && !merged.description) {
      merged.description = b.description
    }
    if (b.properties && typeof b.properties === 'object' && !Array.isArray(b.properties)) {
      hasProps = true
      Object.assign(mergedProps, b.properties)
    }
    if (Array.isArray(b.required)) {
      for (const r of b.required) {
        if (typeof r === 'string') mergedRequired.add(r)
      }
    }
    if (b.items && !merged.items) merged.items = b.items
    if (Array.isArray(b.enum) && !merged.enum) merged.enum = b.enum
  }

  if (hasProps) merged.properties = mergedProps
  if (mergedRequired.size > 0) merged.required = Array.from(mergedRequired)
  return merged
}

/**
 * 清洗 Anthropic JSON Schema，转换为 Google Gemini Protobuf Schema 严格兼容格式。
 * 彻底过滤 Gemini 不支持的 $schema, propertyNames, exclusiveMinimum, const, additionalProperties 等字段。
 */
export function cleanSchemaForGemini(
  schema: any,
  rootSchema?: Record<string, unknown>,
  visitedRefs?: Set<string>
): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} }
  }

  const root = rootSchema ?? (schema as Record<string, unknown>)

  // 展开局部 $ref（如 #/$defs/Foo 或 #/definitions/Foo），带循环引用保护
  if (typeof schema.$ref === 'string' && schema.$ref.startsWith('#/')) {
    const seen = visitedRefs ?? new Set<string>()
    if (!seen.has(schema.$ref)) {
      const target = resolveLocalRef(schema.$ref, root)
      if (target) {
        const nextSeen = new Set(seen)
        nextSeen.add(schema.$ref)
        const merged = {
          ...target,
          ...(typeof schema.description === 'string' && schema.description && !target.description
            ? { description: schema.description }
            : {}),
        }
        return cleanSchemaForGemini(merged, root, nextSeen)
      }
    }
  }

  // 合并 allOf 联合约束
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const { allOf, ...rest } = schema
    const combined = mergeAllOfSchemas([rest, ...allOf])
    return cleanSchemaForGemini(combined, root, visitedRefs)
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
      return cleanSchemaForGemini(merged, root, visitedRefs)
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
      props[k] = cleanSchemaForGemini(v, root, visitedRefs)
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
    cleaned.items = schema.items.length > 0
      ? cleanSchemaForGemini(schema.items[0], root, visitedRefs)
      : { type: 'string' }
  } else if (schema.items) {
    cleaned.items = cleanSchemaForGemini(schema.items, root, visitedRefs)
  } else if (cleaned.type === 'array') {
    cleaned.items = { type: 'string' }
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

function convertMediaSourceToPart(source: any, defaultMime: string): GeminiPart | null {
  if (!source || typeof source !== 'object') return null
  if (source.type === 'base64' && typeof source.data === 'string' && source.data) {
    return {
      inlineData: {
        mimeType: source.media_type || defaultMime,
        data: source.data,
      },
    }
  }
  if (source.type === 'text' && typeof source.data === 'string' && source.data) {
    return { text: source.data }
  }
  if ((source.type === 'url' || source.type === undefined) && typeof source.url === 'string' && source.url) {
    const dataMatch = source.url.match(/^data:([^;]+);base64,(.+)$/)
    if (dataMatch) {
      return {
        inlineData: {
          mimeType: dataMatch[1] || defaultMime,
          data: dataMatch[2],
        },
      }
    }
    return {
      fileData: {
        mimeType: source.media_type || defaultMime,
        fileUri: source.url,
      },
    }
  }
  return null
}

function resolveThinkingBudget(req: AnthropicRequest): number | undefined {
  const thinking = req.thinking
  if (!thinking || typeof thinking !== 'object') return undefined
  if (thinking.type === 'disabled') return undefined
  if (typeof thinking.budget_tokens === 'number' && thinking.budget_tokens > 0) {
    return thinking.budget_tokens
  }
  if (thinking.type === 'adaptive' || thinking.type === 'enabled') {
    const effort = typeof req.output_config?.effort === 'string' ? req.output_config.effort.toLowerCase() : ''
    if (effort === 'low') return 1024
    if (effort === 'medium') return 4096
    if (effort === 'high') return 8192
    if (effort === 'max' || effort === 'xhigh') return 16384
    return 4096
  }
  return undefined
}

export interface GeminiConvertOptions {
  thoughtSignatureByToolId?: Map<string, string>
  thoughtSignatureByThinkingHash?: Map<string, string>
  allowClientThinkingSignature?: boolean
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

  // 2. 对话历史转换（支持图片/文档多模态与带签名的思考块，并按 Gemini 规范合并相邻同 role 消息）
  for (const msg of req.messages ?? []) {
    const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user'
    const parts: GeminiPart[] = []
    let deferredToolParts: GeminiPart[] = []

    const flushDeferredToolParts = () => {
      if (deferredToolParts.length === 0) return
      parts.push(...deferredToolParts)
      deferredToolParts = []
    }

    if (typeof msg.content === 'string') {
      if (msg.content) parts.push({ text: msg.content })
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (!part || typeof part !== 'object') continue

        if (part.type === 'thinking') {
          flushDeferredToolParts()
          const thinkingText = typeof (part as any).thinking === 'string' ? (part as any).thinking : ''
          if (thinkingText) {
            const cachedSig = options.thoughtSignatureByThinkingHash?.get(hashThinkingText(thinkingText))
            const clientSig =
              options.allowClientThinkingSignature && typeof (part as any).signature === 'string'
                ? (part as any).signature
                : ''
            const sig = cachedSig || clientSig
            if (sig) {
              parts.push({ thought: true, text: thinkingText, thoughtSignature: sig })
            }
          }
        } else if (part.type === 'redacted_thinking') {
          // redacted_thinking 无明文 text 可直接映射为 Gemini Part，跳过
          continue
        } else if (part.type === 'text' && typeof (part as any).text === 'string') {
          flushDeferredToolParts()
          if ((part as any).text) parts.push({ text: (part as any).text })
        } else if (part.type === 'image') {
          flushDeferredToolParts()
          const mediaPart = convertMediaSourceToPart((part as any).source, 'image/png')
          if (mediaPart) parts.push(mediaPart)
        } else if (part.type === 'document') {
          flushDeferredToolParts()
          const docPart = convertMediaSourceToPart((part as any).source, 'application/pdf')
          if (docPart) parts.push(docPart)
        } else if (part.type === 'tool_use') {
          flushDeferredToolParts()
          const toolId = typeof (part as any).id === 'string' ? (part as any).id.trim() : ''
          const cachedSig = toolId ? options.thoughtSignatureByToolId?.get(toolId) : undefined
          const sig = cachedSig || (part as any).signature || options.fallbackThoughtSignature
          const rawInput = (part as any).input
          const args =
            rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
              ? (rawInput as Record<string, unknown>)
              : {}
          const fcPart: GeminiPart = {
            functionCall: {
              ...(toolId ? { id: toolId } : {}),
              name: typeof (part as any).name === 'string' ? (part as any).name : '',
              args,
            },
          }
          if (typeof sig === 'string' && sig) {
            fcPart.thoughtSignature = sig
          }
          parts.push(fcPart)
        } else if (part.type === 'tool_result') {
          const toolUseId = typeof (part as any).tool_use_id === 'string' ? (part as any).tool_use_id.trim() : ''
          const functionName = (toolUseId && toolIdToName.get(toolUseId)) || 'tool_result'
          let output: Record<string, unknown> = {}
          const c = (part as any).content
          const nestedMedia: GeminiPart[] = []
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
              } else if (item.type === 'image') {
                const mediaPart = convertMediaSourceToPart(item.source, 'image/png')
                if (mediaPart) nestedMedia.push(mediaPart)
              } else if (item.type === 'document') {
                const docPart = convertMediaSourceToPart(item.source, 'application/pdf')
                if (docPart) {
                  if (docPart.text) textParts.push(docPart.text)
                  else nestedMedia.push(docPart)
                }
              } else {
                try {
                  textParts.push(JSON.stringify(item))
                } catch {}
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
              ...(toolUseId ? { id: toolUseId } : {}),
              name: functionName,
              response: output,
            },
          })
          // 保持所有 functionResponse 连续紧邻，再统一附加工具返回的多模态媒体块
          if (nestedMedia.length > 0) {
            deferredToolParts.push(...nestedMedia)
          }
        }
      }
      flushDeferredToolParts()
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
  if (typeof req.top_p === 'number') generationConfig.topP = req.top_p
  if (typeof req.top_k === 'number') generationConfig.topK = req.top_k
  if (Array.isArray(req.stop_sequences) && req.stop_sequences.length > 0) {
    const stops = req.stop_sequences.filter((s): s is string => typeof s === 'string' && s.length > 0)
    if (stops.length > 0) generationConfig.stopSequences = stops
  }
  const thinkingBudget = resolveThinkingBudget(req)
  if (thinkingBudget !== undefined) {
    generationConfig.thinkingConfig = { thinkingBudget }
  }

  // 4. 工具定义与 tool_choice 转换 (去重并执行深度 schema 清洗)
  let tools: GeminiRequest['tools'] = undefined
  let toolConfig: GeminiRequest['toolConfig'] = undefined
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

      const choice = req.tool_choice
      if (choice && typeof choice === 'object') {
        if (choice.type === 'auto') {
          toolConfig = { functionCallingConfig: { mode: 'AUTO' } }
        } else if (choice.type === 'any') {
          toolConfig = { functionCallingConfig: { mode: 'ANY' } }
        } else if (choice.type === 'none') {
          toolConfig = { functionCallingConfig: { mode: 'NONE' } }
        } else if (choice.type === 'tool' && typeof choice.name === 'string' && choice.name) {
          toolConfig = {
            functionCallingConfig: {
              mode: 'ANY',
              allowedFunctionNames: [choice.name],
            },
          }
        }
      }
    }
  }

  return {
    contents,
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
    ...(tools ? { tools } : {}),
    ...(toolConfig ? { toolConfig } : {}),
  }
}
