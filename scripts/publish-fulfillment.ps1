[CmdletBinding()]
param(
    [ValidateRange(1, 10)][int]$SnapshotCount = 3,
    [switch]$NoPush
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Builder = Join-Path $PSScriptRoot 'build-fulfillment-data.ps1'
$RelativeOutputs = @(
    'pages/fulfillment-decision.html'
    'assets/fulfillment-decision.css'
    'assets/fulfillment-decision.js'
    'assets/fulfillment-engine.js'
    'data/fulfillment-status.json'
    'data/fulfillment-snapshots'
    'scripts/build-fulfillment-data.py'
    'scripts/build-fulfillment-data.ps1'
    'scripts/publish-fulfillment.ps1'
    'scripts/test-fulfillment-engine.js'
    'index.html'
    'README.md'
    '.gitignore'
)
$GitBase = @('-c', "safe.directory=$RepoRoot", '-C', $RepoRoot)

function Invoke-Git {
    param([Parameter(Mandatory)][string[]]$Arguments)
    & git @GitBase @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ')失败，退出码$LASTEXITCODE"
    }
}

function Test-AllowedPath {
    param([Parameter(Mandatory)][string]$Path)
    $normalized = $Path.Replace('\', '/')
    foreach ($allowed in $RelativeOutputs) {
        if ($normalized -eq $allowed -or $normalized.StartsWith("$allowed/")) {
            return $true
        }
    }
    return $false
}

$changes = @(& git @GitBase status --porcelain)
if ($LASTEXITCODE -ne 0) { throw '无法读取Git工作区状态' }
$unexpected = @($changes | Where-Object {
    $_.Length -lt 4 -or -not (Test-AllowedPath $_.Substring(3).Trim('"'))
})
if ($unexpected) {
    throw "仓库存在履约工具范围外的未提交修改：`n$($unexpected -join "`n")"
}

& $Builder -SnapshotCount $SnapshotCount
if ($LASTEXITCODE -ne 0) { throw "履约密文构建失败，退出码$LASTEXITCODE" }
& node (Join-Path $PSScriptRoot 'test-fulfillment-engine.js')
if ($LASTEXITCODE -ne 0) { throw "浏览器履约引擎测试失败，退出码$LASTEXITCODE" }

$addArguments = @('add', '--') + $RelativeOutputs
Invoke-Git $addArguments
& git @GitBase diff --cached --quiet -- @RelativeOutputs
if ($LASTEXITCODE -eq 0) {
    Write-Host '履约工具没有变化，无需提交'
    exit 0
}
if ($LASTEXITCODE -ne 1) { throw '无法检查待提交履约文件' }

if ($NoPush) {
    Write-Host '履约工具已构建并暂存；按-NoPush要求未提交或推送'
    exit 0
}

$commitArguments = @('commit', '-m', 'feat: 发布加密订单履约分析工具', '--') + $RelativeOutputs
Invoke-Git $commitArguments
Invoke-Git @('push', 'origin', 'main')
Write-Host '订单履约分析已推送，GitHub Pages将自动部署' -ForegroundColor Green