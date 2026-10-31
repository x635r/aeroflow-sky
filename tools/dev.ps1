# 启动开发服务器
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot
Write-Host "AeroFlow Sky → http://127.0.0.1:5183" -ForegroundColor Cyan
& npx.cmd vite --port 5183 --host 127.0.0.1
