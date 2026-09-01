[CmdletBinding()]
param(
    [string]$CredentialPath = (Join-Path $env:LOCALAPPDATA 'JD-SupplyChain\warehouse-ratio-pages-password.xml'),
    [string]$StatePath = (Join-Path $env:LOCALAPPDATA 'JD-SupplyChain\warehouse-ratio-pages-state.json'),
    [string]$LockPath = (Join-Path $env:LOCALAPPDATA 'JD-SupplyChain\warehouse-ratio-pages-publish.lock'),
    [switch]$Force,
    [switch]$NoPush
)

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Builder = Join-Path $PSScriptRoot 'build-warehouse-ratio.ps1'
$Model = Join-Path $RepoRoot 'data\warehouse-ratio-model.enc.json'
$Status = Join-Path $RepoRoot 'data\warehouse-ratio-status.json'
$Outputs = @('data/warehouse-ratio-model.enc.json', 'data/warehouse-ratio-status.json')
$InventoryDirectory = 'C:\Users\yao.q.1\Procter and Gamble\JD PS 铁军 - Documents\17 SND\18. 代发治理\拆单或代发判断数据基础\JD库存大表'
$Direct = 'C:\Users\yao.q.1\Procter and Gamble\JD PS 铁军 - Documents\17 SND\18. 代发治理\拆单或代发判断数据基础\宝洁直送明细.xlsx'
$MappingDirectory = 'C:\Users\yao.q.1\repos\jd-supplychain-apps\apps\jd_11rdc_dc_mapping\output'
$GitBase = @('-c', "safe.directory=$RepoRoot", '-C', $RepoRoot)

function Invoke-Git {
    param([Parameter(Mandatory)][string[]]$Arguments)

    $stdoutPath = [IO.Path]::GetTempFileName()
    $stderrPath = [IO.Path]::GetTempFileName()
    try {
        $process = Start-Process `
            -FilePath 'git.exe' `
            -ArgumentList @($GitBase + $Arguments) `
            -Wait `
            -PassThru `
            -NoNewWindow `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath
        $exitCode = $process.ExitCode
        Get-Content -LiteralPath $stdoutPath -ErrorAction SilentlyContinue
        Get-Content -LiteralPath $stderrPath -ErrorAction SilentlyContinue
    } finally {
        Remove-Item -LiteralPath $stdoutPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
    }
    if ($exitCode -ne 0) {
        throw "git $($Arguments -join ' ') 失败，退出码 $exitCode"
    }
}

function Get-LatestDatedFile {
    param([string]$Directory, [string]$Filter)
    $file = Get-ChildItem -LiteralPath $Directory -Filter $Filter -File |
        Where-Object Name -NotLike '~$*' |
        Select-Object *, @{Name='SnapshotDate';Expression={
            if ($_.Name -match '20\d{6}') { $Matches[0] } else { '' }
        }} |
        Sort-Object SnapshotDate, LastWriteTimeUtc, Name -Descending |
        Select-Object -First 1
    if (-not $file) { throw "没有找到数据文件：$Directory\$Filter" }
    return $file
}

function Get-Fingerprint {
    $inventory = Get-LatestDatedFile $InventoryDirectory '下沉用-*.xlsx'
    $mapping = Get-LatestDatedFile $MappingDirectory 'JD_11RDC配送中心映射_*.csv'
    $directItem = Get-Item -LiteralPath $Direct
    return [ordered]@{
        inventory_name = $inventory.Name
        inventory_ticks = $inventory.LastWriteTimeUtc.Ticks
        inventory_length = $inventory.Length
        direct_ticks = $directItem.LastWriteTimeUtc.Ticks
        direct_length = $directItem.Length
        mapping_name = $mapping.Name
        mapping_ticks = $mapping.LastWriteTimeUtc.Ticks
        mapping_length = $mapping.Length
    }
}

function Enter-PublicationLock {
    $directory = Split-Path -Parent $LockPath
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    try {
        return [IO.File]::Open(
            $LockPath,
            [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite,
            [IO.FileShare]::None
        )
    } catch [IO.IOException] {
        throw '另一仓比发布任务正在运行'
    }
}

$publicationLock = Enter-PublicationLock
try {
    if (-not (Test-Path -LiteralPath $CredentialPath)) {
        throw "未找到加密密码文件：$CredentialPath"
    }

    if (-not $NoPush) {
        Invoke-Git @('fetch', 'origin', 'main')
        $local = (& git @GitBase rev-parse HEAD).Trim()
        $remote = (& git @GitBase rev-parse origin/main).Trim()
        if ($LASTEXITCODE -ne 0) { throw '无法比较本地与远端版本' }
        if ($local -ne $remote) {
            throw '本地 main 与 origin/main 不一致，请人工同步后再发布'
        }
    }

    $fingerprint = Get-Fingerprint
    $needsBuild = $Force -or -not (Test-Path -LiteralPath $Model) -or -not (Test-Path -LiteralPath $Status)
    if (-not $needsBuild -and (Test-Path -LiteralPath $StatePath)) {
        try {
            $previous = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
            foreach ($key in $fingerprint.Keys) {
                if ([string]$previous.$key -ne [string]$fingerprint[$key]) {
                    $needsBuild = $true
                    break
                }
            }
            $publishedStatus = Get-Content -LiteralPath $Status -Raw | ConvertFrom-Json
            if ($publishedStatus.fallback_active) { $needsBuild = $true }
        } catch {
            $needsBuild = $true
        }
    } elseif (-not $needsBuild) {
        $needsBuild = $true
    }

    if ($needsBuild) {
        $securePassword = Import-Clixml -LiteralPath $CredentialPath
        if ($securePassword -isnot [Security.SecureString]) {
            throw "密码文件格式无效：$CredentialPath"
        }
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
        try {
            $env:WAREHOUSE_RATIO_PAGES_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
            & $Builder `
                -PasswordEnv 'WAREHOUSE_RATIO_PAGES_PASSWORD' `
                -InventoryDirectory $InventoryDirectory `
                -Direct $Direct `
                -MappingDirectory $MappingDirectory
            if ($LASTEXITCODE -ne 0) {
                throw "仓比模型构建失败，退出码 $LASTEXITCODE"
            }
            $stateDirectory = Split-Path -Parent $StatePath
            New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
            $fingerprint | ConvertTo-Json | Set-Content -LiteralPath $StatePath -Encoding utf8
        } finally {
            Remove-Item Env:WAREHOUSE_RATIO_PAGES_PASSWORD -ErrorAction SilentlyContinue
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
    } else {
        Write-Host '数据源无变化，无需重建仓比模型'
    }

    if ($NoPush) {
        Write-Host '已完成本地构建；按 -NoPush 要求未提交或推送'
        exit 0
    }

    Invoke-Git (@('add', '--') + $Outputs)
    & git @GitBase diff --cached --quiet -- @Outputs
    if ($LASTEXITCODE -eq 0) {
        Write-Host '仓比密文没有变化，无需提交'
        exit 0
    }
    if ($LASTEXITCODE -ne 1) {
        throw '无法检查仓比待提交文件'
    }
    Invoke-Git @(
        'commit',
        '-m', 'data: 更新仓比查询加密数据',
        '-m', 'Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>',
        '--',
        $Outputs[0],
        $Outputs[1]
    )
    Invoke-Git @('push', 'origin', 'main')
    Write-Host '仓比加密数据已推送，GitHub Pages将自动部署' -ForegroundColor Green
} finally {
    $publicationLock.Dispose()
}
