$ErrorActionPreference = 'Stop'

$LogDirectory = Join-Path $env:LOCALAPPDATA 'JD-SupplyChain\logs'
New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
$LogFile = Join-Path $LogDirectory "rdc-pages-$((Get-Date).ToString('yyyyMMdd-HHmmss')).log"
$Publisher = Join-Path $PSScriptRoot 'publish-rdc-inventory.ps1'

"=== $(Get-Date -Format o) ===" | Out-File -LiteralPath $LogFile -Encoding utf8
try {
    & $Publisher *>> $LogFile
    $exitCode = $LASTEXITCODE
    "=== exit $exitCode @ $(Get-Date -Format o) ===" | Out-File -LiteralPath $LogFile -Append -Encoding utf8
    exit $exitCode
} catch {
    $_ | Out-String | Out-File -LiteralPath $LogFile -Append -Encoding utf8
    "=== exit 1 @ $(Get-Date -Format o) ===" | Out-File -LiteralPath $LogFile -Append -Encoding utf8
    exit 1
}