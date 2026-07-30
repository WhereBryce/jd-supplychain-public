[CmdletBinding()]
param(
    [string]$CredentialPath = (Join-Path $env:LOCALAPPDATA 'JD-SupplyChain\fulfillment-pages-password.xml'),
    [ValidateRange(1, 10)][int]$SnapshotCount = 3
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Python = Join-Path $RepoRoot '.venv\Scripts\python.exe'
$Builder = Join-Path $PSScriptRoot 'build-fulfillment-data.py'

if (-not (Test-Path -LiteralPath $Python)) {
    throw '找不到公开站构建环境，请先运行 build-rdc-inventory.ps1'
}
if (-not (Test-Path -LiteralPath $CredentialPath)) {
    throw "未找到履约页加密密码文件：$CredentialPath"
}
$securePassword = Import-Clixml -LiteralPath $CredentialPath
if ($securePassword -isnot [Security.SecureString]) {
    throw "密码文件格式无效：$CredentialPath"
}

$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
    $env:FULFILLMENT_PAGES_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    & $Python -X utf8 $Builder `
        --password-env FULFILLMENT_PAGES_PASSWORD `
        --snapshot-count $SnapshotCount `
        --self-test
    if ($LASTEXITCODE -ne 0) {
        throw "加密履约数据构建失败，退出码$LASTEXITCODE"
    }
} finally {
    Remove-Item Env:FULFILLMENT_PAGES_PASSWORD -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}

Write-Host '加密履约数据已就绪；密码未写入仓库或命令参数。' -ForegroundColor Green