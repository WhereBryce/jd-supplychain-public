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

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][object[]]$Arguments
    )

    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $FilePath @Arguments 2>&1 | ForEach-Object { Write-Host $_ }
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    return [int]$exitCode
}

if (-not (Test-Path -LiteralPath $Python)) {
    if ($Uv) {
        $exitCode = Invoke-NativeCommand -FilePath $Uv.Source -Arguments @(
            'venv',
            (Join-Path $RepoRoot '.venv')
        )
    } else {
        $PathPython = Get-Command python -ErrorAction Stop
        $exitCode = Invoke-NativeCommand -FilePath $PathPython.Source -Arguments @(
            '-m',
            'venv',
            (Join-Path $RepoRoot '.venv')
        )
    }
    if ($exitCode -ne 0) {
        throw "创建构建环境失败，退出码 $exitCode"
    }
}

if ($Uv) {
    $exitCode = Invoke-NativeCommand -FilePath $Uv.Source -Arguments @(
        'pip',
        'install',
        '--quiet',
        '--system-certs',
        '--python',
        $Python,
        '-r',
        $Requirements
    )
} else {
    $exitCode = Invoke-NativeCommand -FilePath $Python -Arguments @(
        '-m',
        'pip',
        'install',
        '--quiet',
        '--disable-pip-version-check',
        '-r',
        $Requirements
    )
}
if ($exitCode -ne 0) {
    throw "安装构建依赖失败，退出码 $exitCode"
}

$Arguments = @('-X', 'utf8', $Builder, '--password-env', $PasswordEnv, '--self-test')
if ($InventoryDirectory) { $Arguments += @('--inventory-dir', $InventoryDirectory) }
if ($Direct) { $Arguments += @('--direct', $Direct) }
if ($MappingDirectory) { $Arguments += @('--mapping-dir', $MappingDirectory) }

$exitCode = Invoke-NativeCommand -FilePath $Python -Arguments $Arguments
if ($exitCode -ne 0) {
    throw "仓比加密模型构建失败，退出码 $exitCode"
}
