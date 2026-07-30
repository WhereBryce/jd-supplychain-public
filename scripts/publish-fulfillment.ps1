[CmdletBinding()]
param(
    [ValidateRange(1, 10)][int]$SnapshotCount = 3,
    [string]$SourceDirectory = 'C:\Users\yao.q.1\Procter and Gamble\JD PS 铁军 - Documents\17 SND\18. 代发治理\拆单或代发判断数据基础',
    [string]$StatePath = (Join-Path $env:LOCALAPPDATA 'JD-SupplyChain\fulfillment-pages-state.json'),
    [switch]$Force,
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
    'scripts/register-fulfillment-publication.ps1'
    'scripts/run-fulfillment-publication.ps1'
    'scripts/test-fulfillment-engine.js'
    'index.html'
    'README.md'
    '.gitignore'
)
$GitBase = @('-c', "safe.directory=$RepoRoot", '-C', $RepoRoot)

function Get-SourceFingerprint {
    $inventoryDirectory = Join-Path $SourceDirectory 'JD库存大表'
    $latest = Get-ChildItem -LiteralPath $inventoryDirectory -Filter '*.xlsx' -File |
        Where-Object Name -NotLike '~$*' |
        Sort-Object Name -Descending |
        Select-Object -First 1
    if (-not $latest) { throw "没有找到库存切片：$inventoryDirectory" }
    $paths = @(
        $latest.FullName
        (Join-Path $SourceDirectory '宝洁直送明细.xlsx')
        (Join-Path $SourceDirectory '11区域对应关系.xlsx')
        (Join-Path $SourceDirectory '轻货仓对应关系.xlsx')
    )
    $items = foreach ($path in $paths) {
        $item = Get-Item -LiteralPath $path
        [ordered]@{ path = $item.FullName; ticks = $item.LastWriteTimeUtc.Ticks; length = $item.Length }
    }
    return [ordered]@{ snapshot_count = $SnapshotCount; sources = @($items) }
}

function ConvertTo-StableJson {
    param([Parameter(Mandatory)]$Value)
    return $Value | ConvertTo-Json -Depth 5 -Compress
}

function Invoke-Git {
    param([Parameter(Mandatory)][string[]]$Arguments)
    & git @GitBase @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ')失败，退出码$LASTEXITCODE"
    }
}

function Write-PublicationState {
    $stateDirectory = Split-Path -Parent $StatePath
    New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
    $fingerprint | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $StatePath -Encoding utf8
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

$fingerprint = Get-SourceFingerprint
$needsBuild = $Force -or -not (Test-Path -LiteralPath (Join-Path $RepoRoot 'data\fulfillment-status.json'))
if (-not $needsBuild -and (Test-Path -LiteralPath $StatePath)) {
    try {
        $previous = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
        $needsBuild = (ConvertTo-StableJson $fingerprint) -ne (ConvertTo-StableJson $previous)
    } catch {
        $needsBuild = $true
    }
} elseif (-not $needsBuild) {
    $needsBuild = $true
}

if (-not $needsBuild) {
    Write-Host '履约数据源没有变化，无需重建或推送'
    exit 0
}

if (-not $NoPush) {
    Invoke-Git @('fetch', 'origin', 'main')
    $counts = (& git @GitBase rev-list --left-right --count origin/main...HEAD) -split '\s+'
    if ($LASTEXITCODE -ne 0 -or $counts.Count -lt 2) { throw '无法比较本地main与origin/main' }
    $behind = [int]$counts[0]
    $ahead = [int]$counts[1]
    if ($behind -gt 0 -and $ahead -gt 0) { throw '本地main与origin/main已分叉，请人工处理' }
    if ($behind -gt 0) {
        if ($changes) { throw '远端有更新且本地有未提交修改，自动发布已停止' }
        Invoke-Git @('pull', '--ff-only', 'origin', 'main')
    } elseif ($ahead -gt 0) {
        Invoke-Git @('-c', 'http.postBuffer=524288000', 'push', 'origin', 'main')
    }
}

& $Builder -SnapshotCount $SnapshotCount
if ($LASTEXITCODE -ne 0) { throw "履约密文构建失败，退出码$LASTEXITCODE" }
& node (Join-Path $PSScriptRoot 'test-fulfillment-engine.js')
if ($LASTEXITCODE -ne 0) { throw "浏览器履约引擎测试失败，退出码$LASTEXITCODE" }

$addArguments = @('add', '--') + $RelativeOutputs
Invoke-Git $addArguments
& git @GitBase diff --cached --quiet -- @RelativeOutputs
if ($LASTEXITCODE -eq 0) {
    if (-not $NoPush) { Write-PublicationState }
    Write-Host '履约工具没有变化，无需提交'
    exit 0
}
if ($LASTEXITCODE -ne 1) { throw '无法检查待提交履约文件' }

if ($NoPush) {
    Write-Host '履约工具已构建并暂存；按-NoPush要求未提交或推送'
    exit 0
}

$commitArguments = @('commit', '-m', 'data: 更新订单履约加密数据', '--') + $RelativeOutputs
Invoke-Git $commitArguments
Invoke-Git @('-c', 'http.postBuffer=524288000', 'push', 'origin', 'main')
Write-PublicationState
Write-Host '订单履约分析已推送，GitHub Pages将自动部署' -ForegroundColor Green