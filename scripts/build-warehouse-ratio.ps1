[CmdletBinding()]
param(
    [string]$PasswordEnv = 'WAREHOUSE_RATIO_PAGES_PASSWORD',
    [string]$InventoryDirectory = '',
    [string]$Direct = '',
    [string]$MappingDirectory = ''
)

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Python = Join-Path $RepoRoot '.venv\Scripts\python.exe'
$Requirements = Join-Path $RepoRoot 'requirements-build.txt'
$Builder = Join-Path $PSScriptRoot 'build-warehouse-ratio.py'
$Uv = Get-Command uv -ErrorAction SilentlyContinue

if (-not (Test-Path -LiteralPath $Python)) {
    if ($Uv) {
        & $Uv.Source venv (Join-Path $RepoRoot '.venv')
    } else {
        $PathPython = Get-Command python -ErrorAction Stop
        & $PathPython.Source -m venv (Join-Path $RepoRoot '.venv')
    }
    if ($LASTEXITCODE -ne 0) {
        throw "创建构建环境失败，退出码 $LASTEXITCODE"
    }
}

if ($Uv) {
    & $Uv.Source pip install --quiet --system-certs --python $Python -r $Requirements
} else {
    & $Python -m pip install --quiet --disable-pip-version-check -r $Requirements
}
if ($LASTEXITCODE -ne 0) {
    throw "安装构建依赖失败，退出码 $LASTEXITCODE"
}

$Arguments = @('-X', 'utf8', $Builder, '--password-env', $PasswordEnv, '--self-test')
if ($InventoryDirectory) { $Arguments += @('--inventory-dir', $InventoryDirectory) }
if ($Direct) { $Arguments += @('--direct', $Direct) }
if ($MappingDirectory) { $Arguments += @('--mapping-dir', $MappingDirectory) }

& $Python @Arguments
if ($LASTEXITCODE -ne 0) {
    throw "仓比加密模型构建失败，退出码 $LASTEXITCODE"
}
