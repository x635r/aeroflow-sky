# AeroFlow Sky 构建脚本
# 用法：powershell -ExecutionPolicy Bypass -File tools\build.ps1
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

Write-Host "=== AeroFlow Sky 构建 ===" -ForegroundColor Cyan
Write-Host "项目: $projectRoot"

if (-not (Test-Path 'node_modules')) {
    Write-Host "node_modules 缺失，尝试安装（本机可能无外网）…" -ForegroundColor Yellow
    & npm.cmd install --no-audit --no-fund
}

Write-Host "`n[1/3] 类型检查" -ForegroundColor Green
& npx.cmd tsc --noEmit
if ($LASTEXITCODE -ne 0) { throw "类型检查失败" }

Write-Host "`n[2/3] 单元测试" -ForegroundColor Green
& npx.cmd vitest run
if ($LASTEXITCODE -ne 0) { throw "测试失败" }

Write-Host "`n[3/3] 生产构建" -ForegroundColor Green
& npx.cmd vite build
if ($LASTEXITCODE -ne 0) { throw "构建失败" }

Write-Host "`n完成：dist/" -ForegroundColor Cyan
