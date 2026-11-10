import type { EngineInterface, Register } from 'claude-code'

/**
 * 默认读取位置；可在 /config 的插件选项里改（plugin.json 的 userConfig.balanceFile）。
 * 这个文件由 claude-workbuddy 网关写入，里面只有币种与金额，没有任何密钥。
 */
const DEFAULT_BALANCE_FILE = 'C:/Users/11830/.workbuddy-claude/deepseek-balance.json'

/** 读一次余额文件，把「¥110.00」这样的结果钉在底部状态栏。 */
async function refresh($: EngineInterface, file: string): Promise<void> {
  let line = '—'
  try {
    const text = await $.fs.read(file)
    const data = JSON.parse(text) as { currency?: string; total?: string }
    if (typeof data.total === 'string' && data.total !== '') {
      line = `${data.currency === 'USD' ? '$' : '¥'}${data.total}`
    }
  } catch {
    // 还没有数据：显示破折号。
  }
  $.ui.status(line)
}

export const register: Register = (on, options) => {
  const configured = options['balanceFile']
  const file = typeof configured === 'string' && configured.trim() !== ''
    ? configured.trim()
    : DEFAULT_BALANCE_FILE

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await refresh($, file)
    // 余额只在网关写完文件后变化，一分钟读一次文件足够。
    $.clock.every(60_000, () => {
      void refresh($, file)
    })
    return started
  })

  // 每轮结束补一次：这一轮如果走了 DeepSeek，网关刚更新过余额文件。
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    void refresh($, file)
    return done
  })
}
