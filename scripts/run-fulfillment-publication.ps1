$ErrorActionPreference = 'Continue'

$LogDirectory = Join-Path $env:LOCALAPPDATA 'JD-SupplyChain\logs'
New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
$LogPath = Join-Path $LogDirectory ("fulfillment-pages-{0}.log" -f (Get-Date -Format 'yyyyMMdd'))
$Publisher = Join-Path $PSScriptRoot 'publish-fulfillment.ps1'

"[{0}] start" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') | Add-Content -LiteralPath $LogPath -Encoding utf8
& $Publisher *>> $LogPath
$code = $LASTEXITCODE
"[{0}] exit={1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $code | Add-Content -LiteralPath $LogPath -Encoding utf8
exit $code