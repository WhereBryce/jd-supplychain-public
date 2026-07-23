[CmdletBinding()]
param(
    [string]$CredentialPath = (Join-Path $env:LOCALAPPDATA 'JD-SupplyChain\rdc-pages-password.xml'),
    [string]$TaskName = 'JD-RDC-Pages-Publish'
)

$ErrorActionPreference = 'Stop'

function ConvertTo-PlainText {
    param([Parameter(Mandatory)][Security.SecureString]$Value)

    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

$password = Read-Host '设置 RDC 查询访问密码（至少 12 位）' -AsSecureString
$confirmation = Read-Host '再次输入密码' -AsSecureString
$plainPassword = ConvertTo-PlainText $password
$plainConfirmation = ConvertTo-PlainText $confirmation
try {
    if ($plainPassword.Length -lt 12) {
        throw '密码至少需要 12 位'
    }
    if ($plainPassword -cne $plainConfirmation) {
        throw '两次输入的密码不一致'
    }
} finally {
    $plainPassword = $null
    $plainConfirmation = $null
}

$CredentialDirectory = Split-Path -Parent $CredentialPath
New-Item -ItemType Directory -Path $CredentialDirectory -Force | Out-Null
$password | Export-Clixml -LiteralPath $CredentialPath -Force

$Runner = Join-Path $PSScriptRoot 'run-rdc-publication.ps1'
$PowerShell = (Get-Command pwsh.exe -ErrorAction Stop).Source
$Action = New-ScheduledTaskAction `
    -Execute $PowerShell `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Runner`""
$Triggers = @(
    New-ScheduledTaskTrigger -Daily -At '11:15'
    New-ScheduledTaskTrigger -Daily -At '18:15'
)
$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 45)
$UserId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$Principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Triggers `
    -Settings $Settings `
    -Principal $Principal `
    -Description '检测最新 RDC 库存报告，加密后发布到 JD Supply Chain GitHub Pages' `
    -Force | Out-Null

Write-Host "密码已使用 Windows 用户级加密保存：$CredentialPath" -ForegroundColor Green
Write-Host "计划任务已注册：$TaskName（每天 11:15、18:15）" -ForegroundColor Green