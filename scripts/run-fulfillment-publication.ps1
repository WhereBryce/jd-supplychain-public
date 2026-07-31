$ErrorActionPreference = 'Stop'

$LogDirectory = Join-Path $env:LOCALAPPDATA 'JD-SupplyChain\logs'
New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
$LogPath = Join-Path $LogDirectory ("fulfillment-pages-{0}.log" -f (Get-Date -Format 'yyyyMMdd'))
$OutputLogPath = Join-Path $LogDirectory ("fulfillment-pages-{0}.output.tmp" -f $PID)
$ErrorLogPath = Join-Path $LogDirectory ("fulfillment-pages-{0}.error.tmp" -f $PID)
$Publisher = Join-Path $PSScriptRoot 'publish-fulfillment.ps1'

"[{0}] start" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') | Add-Content -LiteralPath $LogPath -Encoding utf8
$arguments = @(
	'-NoProfile'
	'-ExecutionPolicy'
	'Bypass'
	'-File'
	$Publisher
)
try {
	$process = Start-Process `
		-FilePath 'powershell.exe' `
		-ArgumentList $arguments `
		-Wait `
		-PassThru `
		-NoNewWindow `
		-RedirectStandardOutput $OutputLogPath `
		-RedirectStandardError $ErrorLogPath
	$code = $process.ExitCode
} catch {
	$_ | Out-String | Add-Content -LiteralPath $LogPath -Encoding utf8
	$code = 1
} finally {
	if (Test-Path -LiteralPath $OutputLogPath) {
		Get-Content -LiteralPath $OutputLogPath | Add-Content -LiteralPath $LogPath -Encoding utf8
		Remove-Item -LiteralPath $OutputLogPath -Force
	}
	if (Test-Path -LiteralPath $ErrorLogPath) {
		Get-Content -LiteralPath $ErrorLogPath | Add-Content -LiteralPath $LogPath -Encoding utf8
		Remove-Item -LiteralPath $ErrorLogPath -Force
	}
	"[{0}] exit={1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $code | Add-Content -LiteralPath $LogPath -Encoding utf8
}
exit $code