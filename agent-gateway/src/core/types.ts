import type { IncomingMessage, ServerResponse } from 'node:http'

export interface AnthropicContentText {
  type: 'text'
  text: string
}

export interface AnthropicContentToolUse {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface AnthropicContentToolResult {
  type: 'tool_result'
  tool_use_id: string
  content?: string | Array<{ type: string; text?: string }>
  is_error?: boolean
}

export type AnthropicContentPart =
  | AnthropicContentText
  | AnthropicContentToolUse
  | AnthropicContentToolResult
  | { type: string; [key: string]: unknown }

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentPart[]
}

export interface AnthropicTool {
  name: string
  description?: string
  input_schema: {
    type: string
    properties?: Record<string, unknown>
    required?: string[]
    [key: string]: unknown
  }
}

export interface AnthropicRequest {
  model: string
  messages: AnthropicMessage[]
  system?: string | Array<{ type: string; text: string }>
  max_tokens?: number
  temperature?: number
  stream?: boolean
  tools?: AnthropicTool[]
  tool_choice?: { type: string; name?: string }
  thinking?: { type: string; budget_tokens?: number }
  [key: string]: unknown
}

export interface ModuleModelInfo {
  id: string
  name: string
  recommendedAlias?: string
  labelOverride: string
  description?: string
}

export interface ModuleStatus {
  online: boolean
  account?: string
  balance?: string | number
  details?: Record<string, unknown>
}

export interface ModuleContext {
  gatewayPort: number
  log: (msg: string) => void
  dataDir: string
}

export interface RequestContext {
  req: IncomingMessage
  headers: Record<string, string | string[] | undefined>
  clientKey?: string
  log: (msg: string) => void
}

export interface RouteConfig {
  module: string
  targetModel?: string
  label?: string
}

export interface GatewayConfig {
  port: number
  token: string
  authMode: 'token' | 'loopback'
  defaultModel: string
  smallModel: string
  routes: Record<string, RouteConfig>
  antigravity?: {
    apiKey?: string
    endpoint?: string
    defaultModel?: string
  }
  workbuddy?: {
    region?: 'cn' | 'global' | 'auto'
    channelPerturbation?: 'off' | 'failure' | 'always'
  }
  passthrough?: {
    deepseekBaseUrl?: string
    settingsBaseUrl?: string
  }
  failover?: {
    enabled?: boolean
    maxAttempts?: number
    failureThreshold?: number
    successThreshold?: number
    cooldownSeconds?: number
    crossModuleFailover?: boolean
  }
}

export type RouteAttemptResult =
  | { committed: true }
  | {
      committed: false
      status: number
      retryable: boolean
      retryAfterMs?: number
      errorType?: string
      message: string
    }

export interface GatewayModule {
  readonly id: string
  readonly name: string
  readonly description: string

  init(context: ModuleContext): Promise<void>
  listModels(): Promise<ModuleModelInfo[]>
  handleRequest(
    request: AnthropicRequest,
    res: ServerResponse,
    context: RequestContext,
    targetModel?: string
  ): Promise<void>
  tryHandleRequest?(
    request: AnthropicRequest,
    res: ServerResponse,
    context: RequestContext,
    targetModel?: string
  ): Promise<RouteAttemptResult>
  getStatus?(): Promise<ModuleStatus>
  dispose?(): Promise<void>
}
