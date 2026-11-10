/**
 * perm-explainer —— 在系统权限卡片上，把那段说明换成分三行的中文解释。
 *
 * ============================================================================
 * 一、它要解决什么问题
 * ============================================================================
 * 系统权限卡片长这样：
 *
 *     Allow Claude to 运行此命令？
 *     ┌────────────────────────────────────────────┐
 *     │ 在系统临时目录 C:\... 中创建并立即删除文件  │  ← 这段是 description
 *     └────────────────────────────────────────────┘
 *     $ echo probe4 > ... && rm -f ... && echo done   ← 这是原命令
 *     [拒绝] [允许一次]
 *
 * 卡片顶部那段说明，来自 Bash 工具的 `description` 参数（由 Claude 自己写）。
 * 本插件把它替换成模型生成的三行中文：
 *     作用：这个操作具体做什么
 *     影响：会改动哪些东西
 *     风险：低/中/高，是否可逆
 *
 * 这样你仍然拿到完整的系统卡片（原命令、允许一次、始终允许都在），
 * 只是判断依据更清楚。
 *
 * ============================================================================
 * 二、为什么代码这么写（这部分是实测出来的，改了容易踩坑）
 * ============================================================================
 * 走过的弯路，别再重复：
 *
 *   1. 官方文档说 tool.check 返回的 reason 字段会在 ask 时显示 —— 实测不显示。
 *   2. 官方文档说 $.ui.notice(调用编号, 文字) 会在确认框下加一行 —— 实测
 *      调用返回成功，界面上什么也没有。
 *   3. 自己用 $.ui.ask 弹框 —— 能用，但那个框会**替代**系统卡片，
 *      于是「允许一次 / 始终允许」全没了，还多一次点击。
 *
 * 最终走通的是改写工具参数这条路：在 tool.call 里 `next({ ...e, description })`
 * 就能改掉卡片上那段说明。系统卡片原封不动，只是文字变了。
 *
 * 一个绕不开的时间顺序问题：
 *
 *   注释必须写在"判定之前"，而卡片是否出现要等"判定之后"才知道。
 *   换句话说，插件无法做到"看到卡片再补注释"。
 *   好在没出现卡片时，那段注释根本不会有人看到，代价只是白花一次模型调用。
 *   为了把这个代价压到最低，插件只对**高危命令**生成解释（见 RISKY_PATTERNS）：
 *   这类命令正是分类器最可能拦下来交给人审的，其余命令直接放行、零延迟。
 *
 * 四条实现上的硬约束：
 *
 *   A. tool.call 里参数是**平铺在 e 上**的（Bash 是 e.command、Edit 是 e.file_path），
 *      没有 e.input 字段。要问引擎判定时，得自己把这些参数摘出来，
 *      去掉 tool / tool_use_id / agentId / requestMeta / consent 这几个保留键。
 *
 *   B. 只有**带 description 字段的工具**（Bash、PowerShell）卡片上才有可替换的文字。
 *      Edit 的卡片显示的是新旧内容对照、Write 显示路径，都不需要也没法替换，
 *      所以那些工具直接放行。
 *
 *   C. 引擎查询返回的 ask 只是"交给模式裁决"，不等于"一定会弹卡片"。
 *      auto 模式下分类器常常直接放行 —— 这时卡片不会出现，注释也就没人看到。
 *      这是现象，不是故障，插件无法改变它。
 *
 *   D. 所以判断顺序是：先看命令是否高危（便宜）→ 再问引擎（便宜）→
 *      最后才调模型（贵）。任何一步不满足都直接放行。
 *
 * ============================================================================
 * 三、理解这份代码只需要三个概念
 * ============================================================================
 *   on(事件名, 处理函数)
 *       注册一个钩子。事件名是一根字符串，比如 'tool.call'。
 *
 *   处理函数的签名永远是 ( $, e, next )：
 *       $     = 引擎接口。$.model.complete(...) 调模型，$.tool.check(...) 问判定，
 *               $.fs.write(...) 写文件，都挂在这上面。
 *       e     = 本次事件的输入，只读的普通对象。tool.call 事件里，
 *               e.tool 是工具名，e.command / e.file_path 等是工具自己的参数，
 *               e.tool_use_id 是这次调用的编号。
 *       next  = "继续往下走"：执行排在后面的其他插件，然后执行引擎自己的行为
 *               （走权限判定 → 弹卡片 → 真正执行工具）。
 *               next({ ...e, description }) 表示改写参数后再往下走。
 *
 * 另外：钩子的耗时是有预算的（约 10 秒），但调用 $ 上的方法**不计时**，
 * 所以在这里调一次模型是安全的，不会被判超时。
 */

import type { EngineInterface, Register } from 'claude-code'

// ============================================================================
// 可调参数
// ============================================================================

/**
 * 用哪个模型来写解释。
 *
 * 必须写**完整的模型 id**，而且必须是这套环境允许列表里的 id。
 * 实测走过的弯路：
 *   - 'haiku'                → 拒绝：不是别名可用的场合
 *   - 'claude-haiku-5-5'     → 拒绝：not in this organization's allowlist
 *   - 'claude-sonnet-5-5'    → 拒绝：同上
 *   - 'claude-sonnet-5.5'    → 本会话正在使用的 id，一定在允许列表里
 * 换模型前请先确认它真的被允许，否则解释永远生成不出来。
 */
const MODEL = 'claude-sonnet-5.5'

/**
 * 备用模型：首选失败时再试一次。
 * 放的是连字符写法，用于网关哪天改了命名规则时还能兜住。
 * 被拒绝的调用是本地即时返回，不产生费用，多试一次代价很小。
 */
const FALLBACK_MODEL = 'claude-haiku-5.5'

/** 单次模型调用的超时（毫秒）。到点就放弃解释，卡片照常弹，只是文案是原来的。 */
const TIMEOUT_MS = 6000

/** 解释最多占多少 token。提示词要求"三行、120 字以内"，220 足够且防啰嗦。 */
const MAX_TOKENS = 220

/** 解释缓存的容量上限。同一条命令第二次出现时直接读缓存，既快又不花钱。 */
const CACHE_MAX = 100

/**
 * 给模型的"人设"和输出格式约束。
 * 固定文本，每次调用原样作为 system 提示词发过去，保证输出稳定：
 * 永远三行、永远中文、永远先说作用再说风险。
 */
const SYSTEM = [
  '你是命令安全审阅助手。用户即将批准 Claude Code 执行一个工具调用，你需要说清它将做什么。',
  '用简体中文回答，最多 3 行、120 字以内，严格按下面三行输出：',
  '作用：这个操作具体做什么',
  '影响：会改动哪些文件、目录、网络或系统状态',
  '风险：低/中/高 —— 一句话说明是否可逆、是否破坏性',
  '不要复述命令原文，不要输出 Markdown 标题或代码块，不要给建议。',
].join('\n')

/**
 * 需要解释的"高危命令"特征。
 *
 * 为什么要有这份清单：生成解释要调一次模型（约 1 秒），
 * 而卡片是否出现要等判定之后才知道。不筛的话，每条候选命令都要白花这 1 秒。
 * 这里列的都是破坏性、越权或影响系统状态的命令 ——
 * 也正是分类器最可能拦下来交给人审核的类型。
 *
 * 想增删请直接改这个数组：每条是一个正则，命中任意一条就算高危。
 * 匹配的是整条命令字符串，大小写不敏感。
 */
const RISKY_PATTERNS: readonly RegExp[] = [
  /\brm\b/i, // 删除文件
  /\brmdir\b/i, // 删除目录
  /\bdel\b/i, // Windows 删除
  /\bgit\s+push\b/i, // 推送代码
  /\bgit\s+reset\s+--hard\b/i, // 丢弃本地改动
  /\bsudo\b/i, // 提权执行
  /\bchmod\b/i, // 改文件权限
  /\bchown\b/i, // 改文件所有者
  /\bdd\b/i, // 块设备直写
  /\bmkfs\b/i, // 格式化
  /\bformat\b/i, // 格式化
  /\bshutdown\b/i, // 关机
  /\breboot\b/i, // 重启
  /\btaskkill\b/i, // 杀进程
  /\breg\s+(add|delete)\b/i, // 改注册表
  /\b(npm|pnpm|yarn)\s+(i|add|install)\b/i, // 装 JS 包
  /\bpip\s+install\b/i, // 装 Python 包
  /\bwinget\s+install\b/i, // 装 Windows 软件
  /\bchoco\s+install\b/i, // 装 Windows 软件
  /\b(curl|wget)\b[^|]*\|/i, // 下载后直接管道执行
  /\bdrop\s+(table|database)\b/i, // 删库
]

/**
 * 工具调用对象里属于"引擎保留"的键，不是工具自己的参数。
 * 问引擎判定时要把它们去掉，否则参数校验会失败。
 */
const RESERVED_KEYS = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent'])

/**
 * 诊断日志的文件名，写在插件自己所在的目录里（由 $.plugin.root 定位）。
 * 写成文件名而不是绝对路径，换电脑、换用户名都不用改。
 * 仓库的 .gitignore 已经忽略了 *.log，不会误提交。
 */
const LOG_FILE = 'perm-explainer.log'

/** 命令 → 解释文本 的缓存。模块级变量，插件重载后清空，无所谓。 */
const CACHE = new Map<string, string>()

/**
 * 往诊断日志末尾追加一行，只保留最近 200 行。
 * 界面上发生什么很难观察，钩子有没有执行更是完全看不见，
 * 所以每次触发都记一笔，事后读文件就能定位问题。
 * 写日志失败时静默忽略 —— 日志是辅助手段，绝不能影响主流程。
 */
async function logLine($: EngineInterface, message: string): Promise<void> {
  try {
    const path = `${$.plugin.root}/${LOG_FILE}`
    const prev = await $.fs.read(path).catch(() => '')
    const lines = prev.split('\n').filter(line => line !== '').slice(-200)
    lines.push(`${new Date().toISOString()} ${message}`)
    await $.fs.write(path, lines.join('\n') + '\n')
  } catch {
    // 日志写不进去就算了
  }
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 从 tool.call 的事件对象里，取出工具自己的参数（去掉引擎保留键）。
 * 用途：$.tool.check 要求传 { tool, input }，input 必须是工具参数本身。
 */
function toolArgs(e: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  for (const key of Object.keys(e)) {
    if (!RESERVED_KEYS.has(key)) args[key] = e[key]
  }
  return args
}

/**
 * 判断这条命令是否属于"值得花一次模型调用去解释"的高危命令。
 * 命中 RISKY_PATTERNS 里任意一条即算。
 */
function looksRisky(command: string): boolean {
  return RISKY_PATTERNS.some(pattern => pattern.test(command))
}

/**
 * 把一段字符串压成一行、并截断到 n 个字符。
 * 命令可能很长（比如一行几千字符的 bash -c），原文塞给模型既慢又贵，
 * 而且换行会把"三行输出"的格式搅乱，所以统一压成单行。
 */
function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

/**
 * 把工具参数压成一小段人话喂给模型。
 * 本插件只处理命令类工具，所以主要就是把 command 和原 description 拼起来。
 */
function compact(tool: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>
  const str = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '')
  return `命令：${clip(str('command'), 800)}\nClaude 原来的说明：${clip(str('description'), 200)}`
}

/**
 * 调一次模型，返回 { text } 或 { why }。
 *
 * 用两个可选字段而不是"成功返回字符串、失败抛异常"，
 * 是为了让调用方不必写 try/catch，模型出问题也不会让权限流程崩掉。
 */
type Explanation = { text?: string; why?: string }

async function callModel(
  $: EngineInterface,
  model: string,
  tool: string,
  desc: string,
): Promise<Explanation> {
  try {
    const r = await $.model.complete({
      model, // 用哪个模型（完整 id）
      system: SYSTEM, // 人设与格式约束
      prompt: `工具：${tool}\n参数：\n${desc}`, // 真正要解释的内容
      effort: 'low', // 这是简单的描述任务，低强度又快又省
      maxTokens: MAX_TOKENS, // 输出上限
      timeoutMs: TIMEOUT_MS, // 超时就放弃
    })

    // 结果是联合类型：要么 isAnswered=true 带 text，
    // 要么 isAnswered=false 带 reason（api-error / empty-reply / aborted）。
    if (!r.isAnswered) return { why: r.reason }
    const text = r.text.trim()
    return text ? { text } : { why: '空回复' }
  } catch (err) {
    return { why: err instanceof Error ? err.message.slice(0, 120) : '调用异常' }
  }
}

/**
 * 生成解释：先用首选模型，失败再自动换备用模型试一次。
 * 这样即使网关的允许列表变了，功能也不会彻底失效。
 */
async function explain(
  $: EngineInterface,
  tool: string,
  desc: string,
): Promise<Explanation> {
  const first = await callModel($, MODEL, tool, desc)
  if (first.text) return first

  const second = await callModel($, FALLBACK_MODEL, tool, desc)
  if (second.text) return second

  return {
    why: `首选模型失败：${first.why ?? '未知'}；备用模型失败：${second.why ?? '未知'}`,
  }
}

/**
 * 带缓存的解释入口。
 *
 * 缓存键 = 工具名 + '\u0000' + 压缩后的参数。
 * 用 \u0000 这种不可能出现在正常文本里的字符做分隔符，
 * 是为了避免"工具名和参数拼起来恰好撞车"。
 */
async function getExplanation(
  $: EngineInterface,
  tool: string,
  input: unknown,
): Promise<Explanation> {
  const desc = compact(tool, input)
  const key = `${tool}\u0000${desc}`

  const hit = CACHE.get(key)
  if (hit !== undefined) return { text: hit } // 命中缓存，零延迟零成本

  const r = await explain($, tool, desc)

  if (r.text) {
    if (CACHE.size >= CACHE_MAX) {
      const oldest = CACHE.keys().next()
      if (!oldest.done) CACHE.delete(oldest.value)
    }
    CACHE.set(key, r.text)
  }
  return r
}

// ============================================================================
// 注册钩子
// ============================================================================

/**
 * 插件被加载时，引擎会调用这个函数一次。
 * on 就是上面说的"注册钩子"，options 是本插件 manifest 里声明的配置项（本插件没用）。
 */
export const register: Register = on => {
  // --------------------------------------------------------------------------
  // 唯一的钩子：tool.call
  // --------------------------------------------------------------------------
  // 触发时机：Claude 发起一次工具调用时，比权限判定更早。
  // 判断顺序刻意从便宜到贵，任何一步不满足就立刻放行：
  //   1. 这个工具有 description 字段吗？（Edit/Write 没有，直接放过）
  //   2. 这条命令高危吗？（不在清单里就放过，零延迟）
  //   3. 引擎这次会问你吗？（不会就放过）
  //   4. 以上都成立才调模型，写完解释再交给引擎
  on('tool.call', async ($, e, next) => {
    const fields = e as unknown as Record<string, unknown>
    const args = toolArgs(fields)

    // 第 1 步：只有带 description 的工具，卡片上才有可替换的文字
    if (typeof args.description !== 'string') return next(e)

    // 第 2 步：不在高危清单里的命令，不值得花一次模型调用
    const command = typeof args.command === 'string' ? args.command : ''
    if (!looksRisky(command)) {
      await logLine($, `tool.call ${e.tool}：命令不在高危清单，跳过解释`)
      return next(e)
    }

    // 第 3 步：问引擎这次会不会问你
    // $.tool.check 是"只询问、不执行"的查询，返回 { decision, rule?, setting? }。
    // 注意参数要传工具自己的参数（args），不是 e.input —— e 上没有 input 字段。
    let decision: string
    try {
      decision = (await $.tool.check({ tool: e.tool, input: args })).decision
    } catch (err) {
      await logLine(
        $,
        `tool.check 查询失败：${err instanceof Error ? err.message : String(err)}`,
      )
      return next(e)
    }

    await logLine($, `tool.call ${e.tool}：高危命令，查询判定 ${decision}`)
    if (decision !== 'ask') return next(e)

    // 第 4 步：生成解释
    const r = await getExplanation($, e.tool, args)
    await logLine(
      $,
      `tool.call ${e.tool}：解释${r.text ? '生成成功' : `生成失败（${r.why ?? '未知'}）`}`,
    )

    // 生成失败就保持原来的说明，卡片照常弹，不打扰你
    if (r.text === undefined) return next(e)

    // ---- 改写说明，再交给引擎 ----
    // 这是唯一真正改变界面的动作：卡片顶部那段文字换成了三行解释。
    // 命令原文、允许一次、始终允许，全部原样保留。
    return next({ ...(e as Record<string, unknown>), description: r.text } as typeof e)
  }).catch(async ($, e, next) => {
    // 钩子内部抛了意料之外的错：记一笔，然后原样交给下层。
    // 安全第一：宁可少一段解释，也不能因为插件出错而误放行或误拦截。
    await logLine($, `tool.call ${e.tool}：钩子内部异常，已原样放行`)
    return next(e)
  })
}
