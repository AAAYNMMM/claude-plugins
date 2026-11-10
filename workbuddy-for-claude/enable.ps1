# 重新启用：把 ANTHROPIC_* 环境变量写回 Claude Code 设置，并确保网关在运行。

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$homeDir = Join-Path $env:USERPROFILE '.workbuddy-claude'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw '找不到 node.exe。' }

$config = Get-Content (Join-Path $homeDir 'config.json') -Raw | ConvertFrom-Json

$running = $false
try {
  $health = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://127.0.0.1:$($config.port)/health"
  $running = $health.StatusCode -eq 200
} catch { $running = $false }

if (-not $running) {
  $launcher = Join-Path $homeDir 'start-gateway.vbs'
  if (-not (Test-Path $launcher)) {
    $server = Join-Path $root 'dist\server.js'
    $vbs = @"
Set sh = CreateObject("WScript.Shell")
node = "$node"
srv = "$server"
cmd = Chr(34) & node & Chr(34) & " " & Chr(34) & srv & Chr(34)
Do
  code = sh.Run(cmd & " serve", 0, True)
  If code = 0 Then Exit Do
  WScript.Sleep 5000
Loop
"@
    Set-Content -Path $launcher -Value $vbs -Encoding ASCII
  }
  Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$launcher`"" -WindowStyle Hidden
  Start-Sleep -Seconds 3
}

& $node (Join-Path $root 'scripts\settings.mjs') enable
Write-Host '已启用：新开的 Claude Code 会话将使用 WorkBuddy 模型。' -ForegroundColor Green
