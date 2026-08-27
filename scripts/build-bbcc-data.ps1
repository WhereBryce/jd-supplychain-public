[CmdletBinding()]
param([string]$CredentialPath = (Join-Path $env:LOCALAPPDATA 'JD-SupplyChain\bbcc-pages-password.xml'))
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Python = 'C:\Users\yao.q.1\repos\jd-supplychain-apps\.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $Python)) { throw "找不到BBCC私有应用Python环境：$Python" }
if (-not (Test-Path -LiteralPath $CredentialPath)) { throw "未找到BBCC页加密密码文件：$CredentialPath" }
$securePassword = Import-Clixml -LiteralPath $CredentialPath
if ($securePassword -isnot [Security.SecureString]) { throw "密码文件格式无效：$CredentialPath" }
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $env:BBCC_PAGES_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  & $Python -X utf8 (Join-Path $PSScriptRoot 'build-bbcc-data.py') --password-env BBCC_PAGES_PASSWORD --self-test
  if ($LASTEXITCODE -ne 0) { throw "加密BBCC数据构建失败，退出码$LASTEXITCODE" }
} finally {
  Remove-Item Env:BBCC_PAGES_PASSWORD -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
Write-Host '加密BBCC数据已就绪；密码未写入仓库或命令参数。' -ForegroundColor Green
