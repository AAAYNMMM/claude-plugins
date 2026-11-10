# 临时停用：只从 Claude Code 设置里移除 ANTHROPIC_* 环境变量，网关和自启动都保留。
# 想恢复时运行 enable.ps1。

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw '找不到 node.exe。' }

& $node (Join-Path $root 'scripts\settings.mjs') disable
Write-Host '已停用：新开的 Claude Code 会话将使用原生 Claude 模型。运行 enable.ps1 可恢复。' -ForegroundColor Yellow
