$ErrorActionPreference = 'Stop'

$TaskName = 'JD-Fulfillment-Pages-Publish'
$Runner = Join-Path $PSScriptRoot 'run-fulfillment-publication.ps1'
$CredentialPath = Join-Path $env:LOCALAPPDATA 'JD-SupplyChain\fulfillment-pages-password.xml'
if (-not (Test-Path -LiteralPath $Runner)) { throw "找不到发布入口：$Runner" }
if (-not (Test-Path -LiteralPath $CredentialPath)) { throw "找不到履约页密码文件：$CredentialPath" }

$Action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Runner`"" `
    -WorkingDirectory $PSScriptRoot
$Trigger = New-ScheduledTaskTrigger -Daily -At '12:00'
$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$Principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Principal $Principal `
    -Description '每天12:00检查履约库存及基础关系；变化时重建加密数据并发布GitHub Pages' `
    -Force | Out-Null
Write-Host "已注册$TaskName：每天12:00检查一次" -ForegroundColor Green