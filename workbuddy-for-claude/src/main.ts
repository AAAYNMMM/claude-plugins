/**
 * claude-workbuddy 的入口：把插件已有的 WorkBuddy 上游能力接成 Claude Code 能用的
 * 本地网关。
 *
 * 进程启动后依次做四件事：
 *  1. 读取（首次运行则生成）配置与本地令牌；
 *  2. 按区域建立凭据仓库、模型目录与上游客户端；
 *  3. 启动插件自带的回环 shim（OpenAI 协议）；
 *  4. 启动本项目的 Anthropic 网关（Claude Code 协议），并把端口写进状态文件。
 *
 * 命令：
 *   node dist/server.js serve      前台运行网关（默认命令）
 *   node dist/server.js status     打印账号、积分与目录概况
 *   node dist/server.js models     列出目录里的模型
 *   node dist/server.js doctor     逐项检查凭据、目录、上游连通性
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkBuddyCredentialStore } from '../vendor/src/auth.ts'
import { deriveCatalog, WorkBuddyCatalog } from '../vendor/src/catalog.ts'
import { createWorkBuddyShim } from '../vendor/src/shim.ts'
import { WorkBuddyUpstreamClient } from '../vendor/src/upstream.ts'
import { createGateway } from './gateway.ts'
import type { Route } from './gateway.ts'

/** 配置文件的形状；首次运行时由 {@link loadConfig} 补齐缺省值并写回。 */
interface Config {
  /** 网关监听的端口；Claude Code 的 ANTHROPIC_BASE_URL 用的就是它。 */
  port: number
  /** 本地令牌；同机进程必须出示它才能借用账号。 */
  token: string
  /** 使用哪个区域的账号：cn、global，或 auto（哪个区域已登录就用哪个）。 */
  region: 'cn' | 'global' | 'auto'
  /** Claude Code 请求里出现 claude-* 模型名时要用的 WorkBuddy 模型 id。 */
  defaultModel: string
  /** 轻量任务（标题、摘要）用的模型 id；留空则与 defaultModel 相同。 */
  smallModel: string
  /** 渠道指纹扰动策略，与插件设置里的同名开关语义一致。 */
  channelPerturbation: 'off' | 'failure' | 'always'
  /**
   * 鉴权模式。
   *
   * `token` 供终端 Claude Code 使用：必须出示本地令牌。
   * `loopback` 供桌面 App 使用：App 的密钥是应用私有加密的，网关读不到，
   * 因此只能接受“回环 + 非空凭据”，并把该凭据原样转发给 DeepSeek。
   */
  auth: 'token' | 'loopback'
  /** DeepSeek 的 Anthropic 兼容端点，`provider: "deepseek"` 的路由转发到这里。 */
  deepseekBaseUrl: string
  /** 模型名到提供方的路由表；键就是 Claude Code 发送的 model 字段。 */
  routes: Record<string, Route>
}

/**
 * 首次运行时写入的路由表。
 *
 * `claude-sonnet-5.5` 是桌面 App 现在用的模型名，保留它走 DeepSeek，原有体验不变；
 * 其余几条是 WorkBuddy 模型在 Claude 模型名下的“别名”，靠 label 在 App 的
 * 模型列表里显示成可读的名字。想调整时直接改 config.json 再重启网关。
 */
const DEFAULT_ROUTES: Record<string, Route> = {
  'claude-sonnet-5.5': { provider: 'deepseek', label: 'DeepSeek · Sonnet' },
  'claude-opus-5-5': { provider: 'workbuddy', model: 'deepseek-v4-pro', label: 'WB · DeepSeek V4 Pro' },
  'claude-sonnet-5-5': { provider: 'workbuddy', model: 'kimi-k3-1', label: 'WB · Kimi K3' },
  'claude-haiku-5-5': { provider: 'workbuddy', model: 'deepseek-v4.1-flash', label: 'WB · DeepSeek Flash' },
  'claude-fable-5-2': { provider: 'workbuddy', model: 'glm-5.3', label: 'WB · GLM 5.3' },
}

/** 本程序自己的数据目录。 */
const HOME = join(homedir(), '.workbuddy-claude')
const CONFIG_PATH = join(HOME, 'config.json')
const STATUS_PATH = join(HOME, 'status.json')
const LOG_PATH = join(HOME, 'gateway.log')
const LOG_KEEP_BYTES = 2 * 1024 * 1024

/** 写一行带时间戳的日志：既进日志文件，也进控制台。 */
function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`
  try {
    mkdirSync(HOME, { recursive: true })
    // 日志超过上限就整体截断，避免一个长期运行的后台进程把磁盘写满。
    try {
      const existing = readFileSync(LOG_PATH, 'utf8')
      if (existing.length > LOG_KEEP_BYTES) writeFileSync(LOG_PATH, '')
    } catch {
      // 文件还不存在：下面 append 会创建它。
    }
    appendFileSync(LOG_PATH, line)
  } catch {
    // 日志写不进去不应该影响网关本身。
  }
  process.stdout.write(line)
}

/**
 * 读取配置；文件缺失或字段缺失时补上缺省值。
 *
 * `persist` 默认为真，会把补全后的配置写回磁盘。状态栏那条路径会高频执行，
 * 必须传 false：每次重绘都写一次配置文件既浪费也可能和其它写入打架。
 */
function loadConfig(persist = true): Config {
  mkdirSync(HOME, { recursive: true })
  let raw: Partial<Config> = {}
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<Config>
  } catch {
    // 首次运行，或文件被手工改坏：用缺省值重建。
  }
  const config: Config = {
    port: typeof raw.port === 'number' && raw.port > 0 && raw.port < 65536 ? raw.port : 43119,
    token: typeof raw.token === 'string' && raw.token.length >= 16 ? raw.token : randomBytes(32).toString('base64url'),
    region: raw.region === 'cn' || raw.region === 'global' ? raw.region : 'auto',
    defaultModel: typeof raw.defaultModel === 'string' ? raw.defaultModel : '',
    smallModel: typeof raw.smallModel === 'string' ? raw.smallModel : '',
    channelPerturbation: raw.channelPerturbation === 'off' || raw.channelPerturbation === 'always' ? raw.channelPerturbation : 'failure',
    auth: raw.auth === 'loopback' ? 'loopback' : 'token',
    deepseekBaseUrl: typeof raw.deepseekBaseUrl === 'string' && raw.deepseekBaseUrl.startsWith('https://')
      ? raw.deepseekBaseUrl
      : 'https://api.deepseek.com/anthropic',
    routes: raw.routes !== null && typeof raw.routes === 'object' && !Array.isArray(raw.routes) && Object.keys(raw.routes).length > 0
      ? raw.routes as Record<string, Route>
      : DEFAULT_ROUTES,
  }
  if (persist) writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`)
  return config
}

/** 把配置写回磁盘（安装脚本与 status 命令会读它）。 */
function saveConfig(config: Config): void {
  mkdirSync(HOME, { recursive: true })
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`)
}

/** 运行期的状态快照；安装脚本与 `/workbuddy` 命令靠它找到网关。 */
interface StatusFile {
  pid: number
  port: number
  url: string
  region: string
  startedAt: string
}

function writeStatus(status: StatusFile): void {
  mkdirSync(HOME, { recursive: true })
  writeFileSync(STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`)
}

/** 判断网关是否已经在别的进程里跑着。 */
async function gatewayAlreadyRunning(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch {
    return false
  }
}

/** 两个区域的凭据仓库；用哪个区域由 config.region 决定。 */
function storesFor(client: WorkBuddyUpstreamClient): Record<'cn' | 'global', WorkBuddyCredentialStore> {
  return {
    cn: new WorkBuddyCredentialStore({ region: 'cn', refresh: credential => client.refreshToken(credential) }),
    global: new WorkBuddyCredentialStore({ region: 'global', refresh: credential => client.refreshToken(credential) }),
  }
}

/** 挑一个区域的账号：显式指定的区域优先，auto 时按“有登录”判断。 */
async function chooseRegion(
  stores: Record<'cn' | 'global', WorkBuddyCredentialStore>,
  configured: Config['region'],
): Promise<'cn' | 'global'> {
  if (configured !== 'auto') return configured
  if ((await stores.cn.current().catch(() => undefined)) !== undefined) return 'cn'
  if ((await stores.global.current().catch(() => undefined)) !== undefined) return 'global'
  return 'cn'
}

/** 从目录里挑一个默认模型：优先用配置里点名的，其次按常见能力排序。 */
const MODEL_PREFERENCE = [
  'deepseek-v4.1',
  'deepseek-v4.1-flash',
  'glm-5.3',
  'glm-5.3-flash',
  'kimi-k2.6',
  'hy3',
]

function pickDefaultModel(ids: readonly string[], configured: string): string {
  if (configured !== '' && ids.includes(configured)) return configured
  for (const preferred of MODEL_PREFERENCE) if (ids.includes(preferred)) return preferred
  return ids[0] ?? configured
}

/** 打印一张模型表，供安装脚本与 `models` 命令使用。 */
function printModels(models: readonly { id: string; name?: string; creditMultiplier?: number; contextWindow?: number }[]): void {
  for (const model of models) {
    const multiplier = typeof model.creditMultiplier === 'number' ? `x${model.creditMultiplier}` : 'x?'
    const context = typeof model.contextWindow === 'number' ? `${Math.round(model.contextWindow / 1000)}k` : '?'
    process.stdout.write(`${model.id}\t${multiplier}\t${context}\t${model.name ?? ''}\n`)
  }
}

/** 组装运行所需的全部部件。 */
async function buildRuntime(config: Config): Promise<{
  region: 'cn' | 'global'
  client: WorkBuddyUpstreamClient
  store: WorkBuddyCredentialStore
  catalog: WorkBuddyCatalog
  resolveModel: (requested: string | undefined) => string
}> {
  const client = new WorkBuddyUpstreamClient(
    message => log(`upstream: ${message}`),
    {},
    {},
  )
  const stores = storesFor(client)
  const region = await chooseRegion(stores, config.region)
  if (region !== config.region && config.region === 'auto') {
    // 只在 auto 模式下把解析结果记下来，方便诊断“为什么用的是这个区”。
    log(`region: auto resolved to ${region}`)
  }
  const store = stores[region]
  const catalog = new WorkBuddyCatalog(region)

  const resolveModel = (requested: string | undefined): string => {
    const live = catalog.current().map(model => model.id)
    if (typeof requested === 'string' && requested !== '' && live.includes(requested)) return requested
    if (config.defaultModel !== '' && live.includes(config.defaultModel)) return config.defaultModel
    return pickDefaultModel(live, '') || (requested ?? '')
  }

  return { region, client, store, catalog, resolveModel }
}

/** 刷新一次模型目录；失败只记日志，保留上一份可用的目录。 */
async function refreshCatalog(
  client: WorkBuddyUpstreamClient,
  store: WorkBuddyCredentialStore,
  catalog: WorkBuddyCatalog,
): Promise<void> {
  try {
    const credential = await store.current()
    if (credential === undefined) {
      log('catalog: no credential, keeping the fallback roster')
      return
    }
    const roster = await client.fetchModels(credential)
    catalog.set(deriveCatalog(roster, new Set()))
    log(`catalog: refreshed ${roster.length} models`)
  } catch (error: unknown) {
    log(`catalog: refresh failed: ${String(error)}`)
  }
}

/** DeepSeek 余额的缓存文件；只存查询结果，永远不含密钥。 */
const DEEPSEEK_BALANCE_PATH = join(HOME, 'deepseek-balance.json')
/** 两次余额查询之间的最短间隔：5 分钟。 */
const DEEPSEEK_BALANCE_TTL_MS = 5 * 60_000

/** 最近一次查到的 DeepSeek 余额。 */
let deepSeekBalance: {
  currency: string
  total: string
  available: boolean
  updatedAt: string
  /** 上游返回的全部币种，界面上显示的那条是其中选出来的。 */
  balances: { currency: string; total: string }[]
} | undefined
let deepSeekBalanceQueriedAtMs = 0

/**
 * 顺手查一次 DeepSeek 余额，查完立刻丢掉 Key。
 *
 * 安全边界（这是本功能唯一触碰 Key 的地方）：
 *  - Key 只是这个函数的参数，函数返回后不再被任何变量引用；
 *  - 不写盘、不写日志、不进配置；
 *  - 只调用只读的 `GET /user/balance`，它不做模型推理、不产生 token，
 *    所以不消耗余额。代码里没有任何"为了查余额去发一次聊天请求"的路径。
 */
async function refreshDeepSeekBalance(deepseekBaseUrl: string, key: string): Promise<void> {
  if (Date.now() - deepSeekBalanceQueriedAtMs < DEEPSEEK_BALANCE_TTL_MS) return
  deepSeekBalanceQueriedAtMs = Date.now()
  try {
    const origin = new URL(deepseekBaseUrl).origin
    const response = await fetch(`${origin}/user/balance`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      // 只记状态码，绝不记 Key。
      log(`deepseek: balance query failed with HTTP ${response.status}`)
      return
    }
    const data = await response.json() as {
      is_available?: boolean
      balance_infos?: { currency?: string; total_balance?: string }[]
    }
    // 上游可能同时给出 CNY 与 USD 两条，其中一条常是 0。全部留下，并优先选非零的那条，
    // 否则界面上会出现「余额 0」这种看着像出错的结果。
    const balances = (Array.isArray(data.balance_infos) ? data.balance_infos : [])
      .filter(info => typeof info?.total_balance === 'string')
      .map(info => ({
        currency: typeof info.currency === 'string' ? info.currency : 'CNY',
        total: info.total_balance as string,
      }))
    if (balances.length === 0) return
    const chosen = balances.find(balance => Number.parseFloat(balance.total) > 0) ?? balances[0]
    if (chosen === undefined) return
    deepSeekBalance = {
      currency: chosen.currency,
      total: chosen.total,
      available: data.is_available === true,
      updatedAt: new Date().toISOString(),
      balances,
    }
    log(`deepseek: balance ${chosen.currency} ${chosen.total} (${balances.length} currencies)`)
    writeFileSync(DEEPSEEK_BALANCE_PATH, `${JSON.stringify(deepSeekBalance, null, 2)}\n`)
  } catch {
    // 查询失败就保留上一次的结果；不重试、不记录 Key。
  }
}

/** `deepseek-balance` 命令：打印缓存里的余额，不触发任何上游请求。 */
function printDeepSeekBalance(): void {
  try {
    const data = JSON.parse(readFileSync(DEEPSEEK_BALANCE_PATH, 'utf8')) as {
      currency?: string
      total?: string
      updatedAt?: string
      balances?: { currency?: string; total?: string }[]
    }
    const all = Array.isArray(data.balances) && data.balances.length > 0
      ? data.balances
      : [{ currency: data.currency, total: data.total }]
    for (const entry of all) {
      const symbol = entry.currency === 'USD' ? '$' : '¥'
      const mark = entry.currency === data.currency && entry.total === data.total ? '  ← 显示中' : ''
      process.stdout.write(`${entry.currency ?? '?'} ${symbol}${entry.total ?? '—'}${mark}\n`)
    }
    process.stdout.write(`更新于 ${data.updatedAt ?? '—'}\n`)
  } catch {
    process.stdout.write('还没有 DeepSeek 余额数据：先在桌面 App 里发一次走 DeepSeek 的请求。\n')
  }
}

/**
 * 状态缓存。
 *
 * 状态栏会被高频调用，而积分要打一次上游。没有缓存的话，每次重绘都会换来一次
 * 上游请求；60 秒的缓存既让状态栏秒开，也避免把积分接口打穿。
 */
let statusCache: { at: number; value: Record<string, unknown> } | undefined
const STATUS_CACHE_MS = 60_000

/** 带缓存的状态读取；TTL 内直接返回上一次的结果。 */
async function readStatusCached(
  region: 'cn' | 'global',
  client: WorkBuddyUpstreamClient,
  store: WorkBuddyCredentialStore,
  catalog: WorkBuddyCatalog,
): Promise<Record<string, unknown>> {
  if (statusCache !== undefined && Date.now() - statusCache.at < STATUS_CACHE_MS) return statusCache.value
  const value = await readStatus(region, client, store, catalog)
  statusCache = { at: Date.now(), value }
  return value
}

/** 读取账号与积分，供 status 命令和网关的只读状态接口使用。 */
async function readStatus(
  region: 'cn' | 'global',
  client: WorkBuddyUpstreamClient,
  store: WorkBuddyCredentialStore,
  catalog: WorkBuddyCatalog,
): Promise<Record<string, unknown>> {
  const credential = await store.current().catch(() => undefined)
  if (credential === undefined) {
    return { region, signedIn: false, models: catalog.current().length }
  }
  let credits: number | undefined
  let creditsError: string | undefined
  try {
    credits = (await client.fetchCredits(credential)).total
  } catch (error: unknown) {
    creditsError = String(error)
  }
  return {
    region,
    signedIn: true,
    account: credential.displayName ?? credential.enterpriseUserName ?? credential.nickname ?? credential.uin ?? credential.uid,
    domain: credential.domain,
    expiresAt: new Date(credential.expiresAtMs).toISOString(),
    credits,
    ...(creditsError === undefined ? {} : { creditsError }),
    models: catalog.current().length,
  }
}

/** serve 命令：拉起 shim 与网关，并一直运行到进程被停止。 */
async function serve(config: Config): Promise<void> {
  if (await gatewayAlreadyRunning(config.port)) {
    log(`gateway: already running on port ${config.port}; nothing to do`)
    return
  }
  const runtime = await buildRuntime(config)
  await refreshCatalog(runtime.client, runtime.store, runtime.catalog)
  log(`gateway: region ${runtime.region}, ${runtime.catalog.current().length} models in the roster`)

  const shim = createWorkBuddyShim({
    store: runtime.store,
    client: runtime.client,
    catalog: runtime.catalog,
    logger: { warn: (...args: unknown[]) => log(`shim: ${args.map(String).join(' ')}`), error: (...args: unknown[]) => log(`shim: ${args.map(String).join(' ')}`) },
    channelPerturbation: config.channelPerturbation,
  })
  await shim.ready
  log(`shim: listening at ${shim.baseUrl()}`)

  const gateway = createGateway({
    port: config.port,
    token: config.token,
    authMode: config.auth,
    deepseekBaseUrl: config.deepseekBaseUrl,
    shimBaseUrl: () => shim.baseUrl(),
    shimToken: () => shim.token(),
    routes: () => config.routes,
    workbuddyModels: () => runtime.catalog.current().map(model => model.id),
    resolveModel: runtime.resolveModel,
    status: () => readStatusCached(runtime.region, runtime.client, runtime.store, runtime.catalog),
    onDeepSeekKey: key => {
      void refreshDeepSeekBalance(config.deepseekBaseUrl, key)
    },
    log,
  })
  await gateway.ready
  log(`gateway: listening at http://127.0.0.1:${gateway.port()}`)
  writeStatus({
    pid: process.pid,
    port: gateway.port(),
    url: `http://127.0.0.1:${gateway.port()}`,
    region: runtime.region,
    startedAt: new Date().toISOString(),
  })

  // 目录每 10 分钟刷新一次：上游会新增或下线模型，而 Claude Code 只在启动时读一次列表。
  const timer = setInterval(() => {
    void refreshCatalog(runtime.client, runtime.store, runtime.catalog)
  }, 10 * 60_000)
  timer.unref()

  let stopping = false
  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    log('gateway: shutting down')
    clearInterval(timer)
    await gateway.close().catch(() => {})
    await shim.close().catch(() => {})
    try {
      writeStatus({ pid: 0, port: config.port, url: `http://127.0.0.1:${config.port}`, region: runtime.region, startedAt: '' })
    } catch {
      // 写不进去就算了，进程已经要退出了。
    }
    process.exit(0)
  }
  process.on('SIGINT', () => void stop())
  process.on('SIGTERM', () => void stop())
  // Windows 上关闭控制台窗口发的是 SIGHUP，不一定有 SIGTERM，所以也接上。
  process.on('SIGHUP', () => void stop())
}

/** status 命令：打印当前能读到的事实，不启动任何监听。 */
async function printStatus(config: Config): Promise<void> {
  const runtime = await buildRuntime(config)
  await refreshCatalog(runtime.client, runtime.store, runtime.catalog)
  const status = await readStatus(runtime.region, runtime.client, runtime.store, runtime.catalog)
  process.stdout.write(`${JSON.stringify({ ...status, gatewayPort: config.port }, null, 2)}\n`)
}

/** models 命令：列出目录里的模型。 */
async function printModelList(config: Config): Promise<void> {
  const runtime = await buildRuntime(config)
  await refreshCatalog(runtime.client, runtime.store, runtime.catalog)
  printModels(runtime.catalog.current())
}

/** doctor 命令：逐项检查，把能修和不能修分开说。 */
async function doctor(config: Config): Promise<void> {
  const runtime = await buildRuntime(config)
  const credential = await runtime.store.current().catch(() => undefined)
  process.stdout.write(`region detected: ${runtime.region}\n`)
  process.stdout.write(`credential: ${credential === undefined ? 'NOT FOUND — sign in with the WorkBuddy desktop app' : `found (${credential.domain})`}\n`)
  await refreshCatalog(runtime.client, runtime.store, runtime.catalog)
  process.stdout.write(`catalog: ${runtime.catalog.current().length} models\n`)
  process.stdout.write(`default model: ${config.defaultModel === '' ? '(auto) ' + runtime.resolveModel(undefined) : config.defaultModel}\n`)
  process.stdout.write(`gateway port: ${config.port} (${await gatewayAlreadyRunning(config.port) ? 'running' : 'not running'})\n`)
  process.stdout.write(`config: ${CONFIG_PATH}\n`)
  process.stdout.write(`log: ${LOG_PATH}\n`)
}

/** 读 stdin 上的会话 JSON；没有输入时很快返回 undefined。 */
async function readStdinJson(): Promise<Record<string, unknown> | undefined> {
  if (process.stdin.isTTY) return undefined
  return await new Promise(resolve => {
    let text = ''
    let finished = false
    const done = (value: Record<string, unknown> | undefined): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => done(undefined), 200)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => { text += chunk })
    process.stdin.on('end', () => {
      try {
        done(JSON.parse(text) as Record<string, unknown>)
      } catch {
        done(undefined)
      }
    })
    process.stdin.on('error', () => done(undefined))
  })
}

/**
 * 状态栏：一行「模型 · WB 账号 · 积分」。
 *
 * Claude Code 每次重绘都会调用它，所以这里只查本机网关（不回源上游），
 * 且最多等 400ms；网关没起来时也必须立刻给出文字，不能把界面拖住。
 */
async function printStatusLine(config: Config): Promise<void> {
  // --compact：只输出余额数字，供状态栏这种空间有限的位置使用。
  const compact = process.argv.includes('--compact')
  const input = await readStdinJson()
  const model = input?.['model'] as { display_name?: string; id?: string } | undefined
  let text = compact ? '离线' : 'WB · 网关未运行'
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/v1/workbuddy/status`, {
      headers: { authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(400),
    })
    if (response.ok) {
      const status = await response.json() as { signedIn?: boolean; account?: string; credits?: number }
      if (status.signedIn === true) {
        const credits = typeof status.credits === 'number' ? status.credits.toFixed(2) : '积分不可用'
        text = compact
          ? (typeof status.credits === 'number' ? credits : '—')
          : `WB ${status.account ?? ''} · ${credits}`.trim()
      } else {
        text = compact ? '未登录' : 'WB 未登录'
      }
    }
  } catch {
    // 网关没起来：保留默认文案。
  }
  const label = typeof model?.display_name === 'string' ? model.display_name : model?.id
  process.stdout.write(`${label === undefined ? '' : `${label} · `}${text}\n`)
}

/** 重启网关：结束当前进程，等看护脚本拉起；看护不在时自己拉起一个。 */
async function restartGateway(config: Config): Promise<void> {
  let pid = 0
  try {
    pid = (JSON.parse(readFileSync(STATUS_PATH, 'utf8')) as { pid?: number }).pid ?? 0
  } catch {
    pid = 0
  }
  if (pid !== 0) {
    try {
      process.kill(pid)
    } catch {
      // 进程已经不在了。
    }
  }
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    if (await gatewayAlreadyRunning(config.port)) {
      process.stdout.write('网关已重启\n')
      return
    }
  }
  const server = fileURLToPath(import.meta.url)
  const child = spawn(process.execPath, [server, 'serve'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  process.stdout.write('网关已手动拉起\n')
}

/** 入口：按命令行第一个参数分派。 */
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'serve'
  // 状态栏只读配置，不写回：这条命令每次界面重绘都会执行。
  const config = loadConfig(command !== 'statusline')

  if (command === 'models') {
    await printModelList(config)
    return
  }
  if (command === 'status') {
    await printStatus(config)
    return
  }
  if (command === 'doctor') {
    await doctor(config)
    return
  }
  if (command === 'statusline') {
    await printStatusLine(config)
    return
  }
  if (command === 'restart') {
    await restartGateway(config)
    return
  }
  if (command === 'deepseek-balance') {
    printDeepSeekBalance()
    return
  }
  if (command === 'set') {
    // `set defaultModel <id>` / `set smallModel <id>` / `set port <n>` / `set region <cn|global|auto>`
    const key = process.argv[3]
    const value = process.argv[4]
    if (key === 'defaultModel' || key === 'smallModel') {
      config[key] = value ?? ''
    } else if (key === 'region') {
      if (value !== 'cn' && value !== 'global' && value !== 'auto') throw new Error('region must be cn, global or auto')
      config.region = value
    } else if (key === 'port') {
      const port = Number(value)
      if (!Number.isInteger(port) || port <= 0 || port >= 65536) throw new Error('port must be an integer between 1 and 65535')
      config.port = port
    } else if (key === 'auth') {
      if (value !== 'token' && value !== 'loopback') throw new Error('auth must be token or loopback')
      config.auth = value
    } else {
      throw new Error('usage: set defaultModel|smallModel|region|port|auth <value>')
    }
    saveConfig(config)
    process.stdout.write(`${key} = ${String(config[key as keyof Config])}\n`)
    return
  }
  if (command === 'serve') {
    await serve(config)
    return
  }
  throw new Error(`unknown command: ${command} (expected serve, status, models, doctor, statusline, restart, deepseek-balance or set)`)
}

main().catch((error: unknown) => {
  log(`fatal: ${String(error)}`)
  process.exitCode = 1
})
