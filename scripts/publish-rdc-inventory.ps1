[CmdletBinding()]
param(
    [string]$Source = 'C:\Users\yao.q.1\Procter and Gamble\JD CSC Slay - Documents\7. AI Order\Low Inventory Alert\RDC库存报告.xlsx',
    [string]$CredentialPath = (Join-Path $env:LOCALAPPDATA 'JD-SupplyChain\rdc-pages-password.xml'),
    [switch]$Force,
    [switch]$NoPush
)

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$RelativeOutput = 'data/rdc-inventory.enc.json'
$Output = Join-Path $RepoRoot 'data\rdc-inventory.enc.json'
$Builder = Join-Path $PSScriptRoot 'build-rdc-inventory.ps1'

function Invoke-Git {
    param([Parameter(Mandatory)][string[]]$Arguments)

    & git -C $RepoRoot @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') 失败，退出码 $LASTEXITCODE"
    }
}

if (-not (Test-Path -LiteralPath $Source)) {
    throw "RDC 库存报告不存在：$Source"
}

if (-not $NoPush) {
    $trackedChanges = @(& git -C $RepoRoot status --porcelain --untracked-files=no)
    if ($LASTEXITCODE -ne 0) {
        throw '无法读取 Git 工作区状态'
    }
    $unexpectedChanges = @($trackedChanges | Where-Object {
        $_.Length -lt 4 -or $_.Substring(3).Replace('\', '/') -ne $RelativeOutput
    })
    if ($unexpectedChanges) {
        throw "仓库存在 RDC 密文之外的未提交修改，自动发布已停止：`n$($unexpectedChanges -join "`n")"
    }

    Invoke-Git @('fetch', 'origin', 'main')
    $counts = (& git -C $RepoRoot rev-list --left-right --count origin/main...HEAD) -split '\s+'
    if ($LASTEXITCODE -ne 0 -or $counts.Count -lt 2) {
        throw '无法比较本地 main 与 origin/main'
    }
    $behind = [int]$counts[0]
    $ahead = [int]$counts[1]
    if ($behind -gt 0 -and $ahead -gt 0) {
        throw '本地 main 与 origin/main 已分叉，请人工处理后再恢复自动发布'
    }
    if ($behind -gt 0) {
        Invoke-Git @('pull', '--ff-only', 'origin', 'main')
    } elseif ($ahead -gt 0) {
        Write-Host "发现 $ahead 个未推送提交，先重试推送"
        Invoke-Git @('push', 'origin', 'main')
    }
}

$sourceItem = Get-Item -LiteralPath $Source
$needsBuild = $Force -or -not (Test-Path -LiteralPath $Output)
if (-not $needsBuild) {
    $outputItem = Get-Item -LiteralPath $Output
    $needsBuild = $sourceItem.LastWriteTimeUtc -gt $outputItem.LastWriteTimeUtc
}

if ($needsBuild) {
    if (-not (Test-Path -LiteralPath $CredentialPath)) {
        throw "未找到加密密码文件，请先运行 setup-rdc-publication.ps1：$CredentialPath"
    }
    $securePassword = Import-Clixml -LiteralPath $CredentialPath
    if ($securePassword -isnot [Security.SecureString]) {
        throw "密码文件格式无效：$CredentialPath"
    }

    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    try {
        $env:RDC_PAGES_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
        & $Builder -PasswordEnv 'RDC_PAGES_PASSWORD' -Source $Source -Output $Output
        if ($LASTEXITCODE -ne 0) {
            throw "RDC 密文构建失败，退出码 $LASTEXITCODE"
        }
    } finally {
        Remove-Item Env:RDC_PAGES_PASSWORD -ErrorAction SilentlyContinue
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
} else {
    Write-Host "无需更新：密文已覆盖源报告 $($sourceItem.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))"
}

if ($NoPush) {
    Write-Host '已完成本地密文构建；按 -NoPush 要求未提交或推送'
    exit 0
}

Invoke-Git @('add', '--', $RelativeOutput)
& git -C $RepoRoot diff --cached --quiet -- $RelativeOutput
if ($LASTEXITCODE -eq 0) {
    Write-Host '密文内容没有变化，无需提交'
    exit 0
}
if ($LASTEXITCODE -ne 1) {
    throw "无法检查待提交密文，退出码 $LASTEXITCODE"
}

Invoke-Git @('commit', '-m', 'data: 更新 RDC 加密库存', '--', $RelativeOutput)
Invoke-Git @('push', 'origin', 'main')
Write-Host 'RDC 加密库存已推送，GitHub Pages 将自动部署'