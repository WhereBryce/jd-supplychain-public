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
$Triggers = 0..47 | ForEach-Object {
    New-ScheduledTaskTrigger -Daily -At ([datetime]::Today.AddMinutes(5 + 30 * $_))
}
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
    -Trigger $Triggers `
    -Settings $Settings `
    -Principal $Principal `
    -Description '每30分钟检查履约库存及基础关系；变化时重建加密数据并发布GitHub Pages' `
    -Force | Out-Null
Write-Host "已注册$TaskName：每日00:05起每30分钟检查一次" -ForegroundColor Green