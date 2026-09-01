$ErrorActionPreference = 'Stop'

$TaskName = 'JD-Warehouse-Ratio-Pages-Publish'
$Runner = Join-Path $PSScriptRoot 'run-warehouse-ratio-publication.ps1'
$CredentialPath = Join-Path $env:LOCALAPPDATA 'JD-SupplyChain\warehouse-ratio-pages-password.xml'
if (-not (Test-Path -LiteralPath $Runner)) { throw "找不到发布入口：$Runner" }
if (-not (Test-Path -LiteralPath $CredentialPath)) { throw "找不到访问密码文件：$CredentialPath" }

$Action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Runner`"" `
    -WorkingDirectory $PSScriptRoot
$Triggers = @(
    New-ScheduledTaskTrigger -Daily -At '11:30'
    New-ScheduledTaskTrigger -Daily -At '16:30'
)
$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 45)
$Principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Triggers `
    -Settings $Settings `
    -Principal $Principal `
    -Description '每天检查最新JD库存切片和直送关系，更新加密仓比查询页' `
    -Force | Out-Null
Write-Host "已注册$TaskName：每天11:30、16:30检查更新" -ForegroundColor Green
