# 完整卸载 WorkBuddy for Claude Code。
#
# 做的事：
#   1. 停止后台网关；
#   2. 移除“启动”文件夹里的自启动脚本；
#   3. 把 ANTHROPIC_* 环境变量按安装记录还原（不碰你自己配的其它键）；
#   4. 删除安装时写入的两个斜杠命令；
#   5. 保留 ~/.workbuddy-claude（令牌、日志、安装记录），除非显式传 -Purge。

param([switch]$Purge)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$homeDir = Join-Path $env:USERPROFILE '.workbuddy-claude'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source

Write-Host '=== 卸载 WorkBuddy for Claude Code ===' -ForegroundColor Cyan

# 1. 停止网关
$statusPath = Join-Path $homeDir 'status.json'
if (Test-Path $statusPath) {
  try {
    $status = Get-Content $statusPath -Raw | ConvertFrom-Json
    if ($status.pid -and $status.pid -ne 0) {
      Stop-Process -Id $status.pid -Force -ErrorAction SilentlyContinue
      Write-Host "已停止网关进程 $($status.pid)"
    }
  } catch {
    Write-Host '读取状态文件失败，跳过停止进程。'
  }
}
# VBS 启动器可能还在看护：结束它，避免它把网关重新拉起来
Get-CimInstance Win32_Process -Filter "Name = 'wscript.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*start-gateway.vbs*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# 2. 自启动
$autostart = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\ClaudeWorkBuddyGateway.vbs'
if (Test-Path $autostart) {
  Remove-Item $autostart -Force
  Write-Host '已移除登录自启动。'
}

# 2.5 还原桌面 App 的 provider 配置（只有本工具改过才会有备份）
$backupDir = Join-Path $homeDir 'app-provider-backups'
if ($node -and (Test-Path $backupDir)) {
  try {
    & $node (Join-Path $root 'scripts\app-provider.mjs') restore
    Write-Host '已把桌面 App 的模型提供方还原到安装前。'
  } catch {
    Write-Host '还原桌面 App 配置失败，请手工检查 configLibrary。'
  }
}

# 3. 还原 Claude Code 设置
if ($node) {
  & $node (Join-Path $root 'scripts\settings.mjs') uninstall
} else {
  Write-Host '找不到 node.exe，跳过设置还原；请手工删除 ~/.claude/settings.json 里的 ANTHROPIC_* 键。'
}

# 4. 斜杠命令
foreach ($name in @('workbuddy-status.md', 'workbuddy-models.md')) {
  $path = Join-Path $env:USERPROFILE ".claude\commands\$name"
  if (Test-Path $path) {
    Remove-Item $path -Force
    Write-Host "已删除命令 $name"
  }
}

# 5. 运行数据
if ($Purge -and (Test-Path $homeDir)) {
  Remove-Item $homeDir -Recurse -Force
  Write-Host '已删除 ~/.workbuddy-claude。'
} elseif (Test-Path $homeDir) {
  Write-Host '已保留 ~/.workbuddy-claude（令牌、日志、安装记录）；要一并删除请加 -Purge。'
}

Write-Host ''
Write-Host '卸载完成。新开的 Claude Code 会话会恢复使用原生 Claude 模型。' -ForegroundColor Green
