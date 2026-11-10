/**
 * perm-explainer —— 权限卡片弹出后，在它上面再弹一个解释框。
 *
 * ============================================================================
 * 一、它要解决什么问题
 * ============================================================================
 * Claude Code 要执行高危命令时，会弹一张权限卡片，但卡片上给你的
 * 往往只有一串命令原文，你得读懂才知道要不要批准。
 *
 * 这个插件在卡片已经弹出、等你做决定的时候，再弹一个小框盖在它上面：
 *     作用：这个操作具体做什么
 *     影响：会改动哪些东西
 *     风险：低/中/高，是否可逆
 * 你看完关掉它，再在下面的卡片上做决定。卡片本身一个按钮都没少。
 *
 * ============================================================================
 * 二、关键机制：先让卡片出现，再弹框（这是本文件的核心）
 * ============================================================================
 * 难点在于时间顺序：
 *   - 想改卡片上的文字，必须在权限判定**之前**把参数写好，那时还不知道卡片会不会出现；
 *   - 想"看到卡片再补东西"，又必须等判定**之后**。
 *
 * 解法是利用 tool.call 钩子的"挂起"能力：
 *
 *     const running = next(e)        // ① 开始往下走，卡片可能在这一步弹出并等待
 *     ...                            // ② 此时钩子还没返回，调用处于挂起状态
 *     await $.ui.ask(...)            // ③ 趁这段时间弹解释框，盖在卡片上
 *     return running                 // ④ 最后才把结果交回去
 *
 * 官方文档明确支持这种写法：钩子可以在调用 next 之前或之后 await，
 * 工具调用会一直挂起。而且钩子等待 $ 上的方法**不计入超时预算**。
 *
 * 怎么判断"卡片真的弹出来了，而不是已经自动放行"：用竞速。
 *   - 如果 next(e) 很快就有了结果 → 说明没等人，命令直接执行完了 → 不弹框
 *   - 如果解释生成完了 next(e) 还悬着 → 说明有人在等你点卡片 → 弹框
 * 这样就不会去打扰那些 auto 模式自动放行的命令。
 *
 * ============================================================================
 * 三、走过的弯路（别再重复）
 * ============================================================================
 *   1. 官方文档说 tool.check 返回的 reason 字段会在 ask 时显示 —— 实测不显示。
 *   2. 官方文档说 $.ui.notice(调用编号, 文字) 会在确认框下加一行 —— 实测
 *      调用返回成功，界面上什么也没有。
 *   3. 在 tool.check 里提前弹 $.ui.ask —— 那个框会**替代**系统卡片，
 *      「允许一次 / 始终允许」全没了。所以必须等卡片先出现。
 *   4. 在 tool.call 里改写 description —— 可行，但必须在判定前完成，
 *      无法知道会不会有卡片，会给自动放行的命令白花一次模型调用。
 *
 * ============================================================================
 * 四、理解这份代码只需要三个概念
 * ============================================================================
 *   on(事件名, 处理函数)
 *       注册一个钩子。事件名是一根字符串，比如 'tool.call'。
 *
 *   处理函数的签名永远是 ( $, e, next )：
 *       $     = 引擎接口。$.model.complete(...) 调模型，$.ui.ask(...) 弹框，
 *               $.fs.write(...) 写文件，都挂在这上面。
 *       e     = 本次事件的输入，只读的普通对象。tool.call 事件里，
 *               e.tool 是工具名，e.command / e.file_path 等是工具自己的参数。
 *       next  = "继续往下走"：执行排在后面的其他插件，然后执行引擎自己的行为
 *               （走权限判定 → 弹卡片 → 真正执行工具）。返回它的 Promise 即可。
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

/** 单次模型调用的超时（毫秒）。到点就放弃解释，卡片照常可以操作。 */
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
 * 这里列的是破坏性、越权或影响系统状态的命令 ——
 * 也正是分类器最可能拦下来交给人审核的类型。
 *
 * 想增删请直接改这个数组：每条是一个正则，命中任意一条就算高危。
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
 * 取参数时要排除，否则会把引擎字段当成命令参数。
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
 * 命令可能很长（比如一行几千字符的 bash -c），原文塞给模型既慢又贵。
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

    if (!r.isAnswered) return { why: r.reason }
    const text = r.text.trim()
    return text ? { text } : { why: '空回复' }
  } catch (err) {
    return { why: err instanceof Error ? err.message.slice(0, 120) : '调用异常' }
  }
}

/**
 * 生成解释：先用首选模型，失败再自动换备用模型试一次。
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
  on('tool.call', async ($, e, next) => {
    const args = toolArgs(e as unknown as Record<string, unknown>)

    // 不是命令类工具（没有 command 字段），不处理
    const command = typeof args.command === 'string' ? args.command : ''
    if (command === '') return next(e)

    // 不是高危命令，不值得花一次模型调用
    if (!looksRisky(command)) return next(e)

    // ---- 第一步：先让引擎往下走，卡片会在这里弹出并等待 ----
    // 注意这里**故意不立刻 return**，钩子会一直挂起，
    // 权限卡片就停在屏幕上等人做决定。
    const running = next(e)

    // 记录这次调用有没有结束。结束了就说明没有人被问、命令直接跑完了
    // （auto 模式下分类器放行就是这种情况），那就没必要再弹解释框。
    let settled = false
    const markSettled = (): void => {
      settled = true
    }
    void running.then(markSettled, markSettled)

    // ---- 第二步：趁卡片还在，生成解释 ----
    const r = await getExplanation($, e.tool, args)

    // 竞速判断：解释写完时调用已经结束 → 根本没有卡片 → 不打扰
    if (settled) {
      await logLine($, `tool.call ${e.tool}：调用已结束，未出现卡片，跳过解释框`)
      return running
    }

    if (r.text === undefined) {
      await logLine($, `tool.call ${e.tool}：解释生成失败（${r.why ?? '未知'}）`)
      return running
    }

    // ---- 第三步：卡片还在等，弹解释框盖在它上面 ----
    // 这个框只用来读，不代替决定：看完关掉，下面的卡片还等你点。
    // $.ui.ask 至少要有两个选项，所以给「知道了 / 关闭」，两个都只是关闭。
    // 如果弹出失败（比如当前环境没人能回答），就安静地跳过。
    try {
      await $.ui.ask(`${r.text}\n\n看完关掉这个框，再在下面的权限卡片上做决定。`, [
        '知道了',
        '关闭',
      ])
      await logLine($, `tool.call ${e.tool}：解释框已显示`)
    } catch (err) {
      await logLine(
        $,
        `tool.call ${e.tool}：解释框弹出失败（${err instanceof Error ? err.message : String(err)}）`,
      )
    }

    // ---- 第四步：把结果交回去 ----
    return running
  }).catch(async ($, e, next) => {
    // 钩子内部抛了意料之外的错：记一笔，然后原样交给下层。
    // 安全第一：宁可少一段解释，也不能因为插件出错而误放行或误拦截。
    await logLine($, `tool.call ${e.tool}：钩子内部异常，已原样放行`)
    return next(e)
  })
}
