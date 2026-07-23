param(
    [string]$PasswordEnv = '',
    [string]$Source = '',
    [string]$Output = ''
)

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$VenvPython = Join-Path $RepoRoot '.venv\Scripts\python.exe'
$Requirements = Join-Path $RepoRoot 'requirements-build.txt'
$Builder = Join-Path $PSScriptRoot 'build-rdc-inventory.py'

$Uv = Get-Command uv -ErrorAction SilentlyContinue
if (-not (Test-Path -LiteralPath $VenvPython)) {
    if ($Uv) {
        & $Uv.Source venv (Join-Path $RepoRoot '.venv')
    } else {
        $PathPython = Get-Command python -ErrorAction SilentlyContinue
        if (-not $PathPython) {
            throw '找不到 uv 或 Python，无法创建构建环境'
        }
        & $PathPython.Source -m venv (Join-Path $RepoRoot '.venv')
    }
    if ($LASTEXITCODE -ne 0) {
        throw "创建构建环境失败，退出码 $LASTEXITCODE"
    }
}

if ($Uv) {
    & $Uv.Source pip install --system-certs --python $VenvPython -r $Requirements
} else {
    & $VenvPython -m pip install --disable-pip-version-check -r $Requirements
}
if ($LASTEXITCODE -ne 0) {
    throw "安装构建依赖失败，退出码 $LASTEXITCODE"
}

$BuilderArguments = @('-X', 'utf8', $Builder, '--self-test')
if ($PasswordEnv) {
    $BuilderArguments += @('--password-env', $PasswordEnv)
}
if ($Source) {
    $BuilderArguments += @('--source', $Source)
}
if ($Output) {
    $BuilderArguments += @('--output', $Output)
}

& $VenvPython @BuilderArguments
if ($LASTEXITCODE -ne 0) {
    throw "生成加密库存失败，退出码 $LASTEXITCODE"
}

$GeneratedOutput = if ($Output) { $Output } else { Join-Path $RepoRoot 'data\rdc-inventory.enc.json' }
$SizeMb = [math]::Round((Get-Item -LiteralPath $GeneratedOutput).Length / 1MB, 2)
Write-Host "加密库存已就绪：$GeneratedOutput ($SizeMb MB)" -ForegroundColor Green
Write-Host '请确认密码后再提交并推送。不要提交源 Excel 或密码。' -ForegroundColor Yellow