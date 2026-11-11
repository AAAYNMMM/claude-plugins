/**
 * Claude 桌面端配置管理脚本：
 * - apply: 备份原本配置，并将 Claude 桌面端切换为本地网关
 * - restore: 完整还原用户原本的配置（无论之前配的是 DeepSeek API Key 还是官方账号）
 * - show: 查看当前配置
 */

import { existsSync, readFileSync } from 'node:fs'
import {
  applyGatewayToClaude,
  getActiveClaudeProviderPath,
  loadGatewayConfig,
  ORIGINAL_PROVIDER_BACKUP,
  restoreOriginalClaudeProvider,
} from '../src/core/config.ts'

const command = process.argv[2] ?? 'show'

function redact(obj) {
  const clone = { ...obj }
  for (const k of Object.keys(clone)) {
    if (/key|token|secret/i.test(k)) clone[k] = '<redacted>'
  }
  return clone
}

try {
  if (command === 'show') {
    const activePath = getActiveClaudeProviderPath()
    if (!activePath) {
      process.stdout.write('未检测到 Claude 桌面端配置。\n')
      process.exit(0)
    }
    const current = JSON.parse(readFileSync(activePath, 'utf8'))
    const hasOriginalBackup = existsSync(ORIGINAL_PROVIDER_BACKUP)
    process.stdout.write(`当前配置文件: ${activePath}\n`)
    process.stdout.write(`原始配置备份状态: ${hasOriginalBackup ? '已备份 (随时可一键还原)' : '未备份'}\n`)
    process.stdout.write(`当前生效提供方: ${current.inferenceProvider ?? '默认'}\n`)
    process.stdout.write(`网关地址: ${current.inferenceGatewayBaseUrl ?? '未配置'}\n`)
    process.stdout.write(`模型数量: ${current.inferenceModels?.length ?? 0}\n`)
  } else if (command === 'apply') {
    const config = loadGatewayConfig()
    const { activePath, modelCount } = applyGatewayToClaude(config.routes, config.port)
    process.stdout.write(`\n✓ 成功将网关接入 Claude 桌面端！\n`)
    process.stdout.write(`  配置文件: ${activePath}\n`)
    process.stdout.write(`  已注入模型数: ${modelCount} 个\n`)
    process.stdout.write(`  原始代理配置已独立妥善备份，关闭网关时将 100% 完整还原。\n`)
    process.stdout.write(`  提示: 请重启 Claude 桌面端以加载新模型列表。\n\n`)
  } else if (command === 'restore') {
    const { activePath } = restoreOriginalClaudeProvider()
    process.stdout.write(`\n✓ 成功关闭网关，已完整还原您原本的代理/账号配置！\n`)
    process.stdout.write(`  配置文件: ${activePath}\n`)
    process.stdout.write(`  提示: 请重启 Claude 桌面端生效。\n\n`)
  } else {
    process.stderr.write('用法: node scripts/app-provider.mjs apply|restore|show\n')
    process.exit(1)
  }
} catch (err) {
  process.stderr.write(`操作失败: ${err.message}\n`)
  process.exit(1)
}
