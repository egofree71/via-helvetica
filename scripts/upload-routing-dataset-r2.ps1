<#
Business context: publishes one verified, immutable routing dataset to a
Cloudflare R2 bucket through an existing rclone S3 remote. Only Brotli objects
are uploaded. R2 serves them with `Content-Encoding: br`, so browser Fetch
returns validated raw v3 bytes without a browser-specific decompression API.

Cell objects are uploaded and checksum-checked before `manifest.json`, which
remains the release-visibility switch. Machine-local paths and non-secret R2
settings come from routing-data.config.local.json unless command-line values
override them. Credentials remain exclusively in rclone.
#>

[CmdletBinding()]
param(
    [string]$Config = "routing-data.config.local.json",
    [string]$Remote = "",
    [string]$Bucket = "",
    [string]$Prefix = "",
    [string]$Source = "",
    [int]$ExpectedCellCount = 0,
    [string]$PublicBaseUrl = "",
    [string]$PublicOrigin = "",
    [int]$PublicSampleCount = 0,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$VerifyLocalScript = Join-Path $PSScriptRoot "verify-routing-dataset.mjs"
$PreparePublicationScript = Join-Path $PSScriptRoot "prepare-routing-publication.mjs"
$VerifyPublishedScript = Join-Path $PSScriptRoot "verify-published-routing-dataset.mjs"

function Resolve-ConfigPath {
    param(
        [string]$Value,
        [string]$BaseDirectory
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return ""
    }
    if ([System.IO.Path]::IsPathRooted($Value)) {
        return [System.IO.Path]::GetFullPath($Value)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $BaseDirectory $Value))
}

$ConfigPath = Resolve-ConfigPath -Value $Config -BaseDirectory $ProjectRoot
$Configuration = $null
if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
    try {
        $Configuration = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    }
    catch {
        throw "Cannot parse routing-data configuration ${ConfigPath}: $_"
    }
}
elseif ($PSBoundParameters.ContainsKey("Config")) {
    throw "Routing-data configuration not found: $ConfigPath"
}

$Publication = if ($null -ne $Configuration) { $Configuration.publication } else { $null }
$ConfigDirectory = Split-Path -Parent $ConfigPath

if (-not $PSBoundParameters.ContainsKey("Remote")) {
    $Remote = if ($null -ne $Publication -and $Publication.remote) { [string]$Publication.remote } else { "r2" }
}
if (-not $PSBoundParameters.ContainsKey("Bucket")) {
    $Bucket = if ($null -ne $Publication -and $Publication.bucket) { [string]$Publication.bucket } else { "via-helvetica-routing-data" }
}
if (-not $PSBoundParameters.ContainsKey("Prefix")) {
    $Prefix = if ($null -ne $Publication -and $Publication.prefix) { [string]$Publication.prefix } else { "swisstlm3d-2026/format-v3/ch" }
}
if (-not $PSBoundParameters.ContainsKey("Source")) {
    if ($null -ne $Configuration -and $Configuration.binaryReleaseRoot) {
        $Source = Resolve-ConfigPath -Value ([string]$Configuration.binaryReleaseRoot) -BaseDirectory $ConfigDirectory
    }
}
if (-not $PSBoundParameters.ContainsKey("ExpectedCellCount")) {
    $ExpectedCellCount = if ($null -ne $Publication -and $Publication.expectedCellCount) { [int]$Publication.expectedCellCount } else { 7529 }
}
if (-not $PSBoundParameters.ContainsKey("PublicBaseUrl")) {
    $PublicBaseUrl = if ($null -ne $Publication -and $Publication.publicBaseUrl) { [string]$Publication.publicBaseUrl } else { "" }
}
if (-not $PSBoundParameters.ContainsKey("PublicOrigin")) {
    $PublicOrigin = if ($null -ne $Publication -and $Publication.publicOrigin) { [string]$Publication.publicOrigin } else { "https://viahelvetica.ch" }
}
if (-not $PSBoundParameters.ContainsKey("PublicSampleCount")) {
    $PublicSampleCount = if ($null -ne $Publication -and $Publication.publicSampleCount) { [int]$Publication.publicSampleCount } else { 50 }
}

if (-not (Get-Command rclone -ErrorAction SilentlyContinue)) {
    throw "rclone was not found. Install and configure an R2-compatible S3 remote first."
}
if ([string]::IsNullOrWhiteSpace($Remote)) {
    throw "publication.remote must be configured or supplied with -Remote."
}
if ([string]::IsNullOrWhiteSpace($Bucket)) {
    throw "publication.bucket must be configured or supplied with -Bucket."
}
if ([string]::IsNullOrWhiteSpace($Prefix)) {
    throw "publication.prefix must be configured or supplied with -Prefix."
}
if ([string]::IsNullOrWhiteSpace($Source)) {
    throw "binaryReleaseRoot must be configured or supplied with -Source."
}
if ($ExpectedCellCount -le 0) {
    throw "ExpectedCellCount must be positive."
}
if ($PublicSampleCount -le 0) {
    throw "PublicSampleCount must be positive."
}
if (-not $DryRun -and [string]::IsNullOrWhiteSpace($PublicBaseUrl)) {
    throw "PublicBaseUrl is required for a real publication so the public release is verified."
}

$SourcePath = (Resolve-Path -LiteralPath $Source).Path
$NormalizedPrefix = $Prefix.Trim("/")
$Destination = "${Remote}:${Bucket}/$NormalizedPrefix"
$PublicationMetadataPath = Join-Path ([System.IO.Path]::GetTempPath()) "via-helvetica-routing-publication-$PID"
$CommonArguments = @(
    "--s3-no-check-bucket",
    "--immutable",
    "--transfers", "16",
    "--checkers", "32",
    "--progress"
)
if ($DryRun) {
    $CommonArguments += "--dry-run"
}

try {
    Write-Host "Verifying the complete local routing release..."
    & node $VerifyLocalScript --root $SourcePath
    if ($LASTEXITCODE -ne 0) {
        throw "Local routing release verification failed."
    }

    Write-Host "Preparing publication-only manifest and integrity metadata..."
    & node $PreparePublicationScript `
        --source $SourcePath `
        --output $PublicationMetadataPath `
        --expected-cell-count $ExpectedCellCount
    if ($LASTEXITCODE -ne 0) {
        throw "Publication metadata preparation failed."
    }

    $CellUploadHeaders = @(
        "--header-upload", "Content-Encoding: br",
        "--header-upload", "Content-Type: application/octet-stream",
        "--header-upload", "Cache-Control: public, max-age=31536000, immutable"
    )
    $JsonUploadHeaders = @(
        "--header-upload", "Content-Type: application/json; charset=utf-8",
        "--header-upload", "Cache-Control: public, max-age=31536000, immutable"
    )

    Write-Host "Uploading immutable Brotli cell objects..."
    & rclone copy "$SourcePath/cells" "$Destination/cells" `
        --include "*.bin.br" `
        @CellUploadHeaders `
        @CommonArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Cell upload failed."
    }

    if ($DryRun) {
        Write-Host "Dry run: skipping remote checks and public URL verification."
    }
    else {
        Write-Host "Checking remote cell sizes and checksums before publishing metadata..."
        & rclone check "$SourcePath/cells" "$Destination/cells" `
            --s3-no-check-bucket `
            --include "*.bin.br" `
            --one-way `
            --checkers 32
        if ($LASTEXITCODE -ne 0) {
            throw "Remote cell checksum verification failed."
        }
    }

    Write-Host "Uploading the publication integrity inventory..."
    & rclone copyto `
        "$PublicationMetadataPath/integrity.json" `
        "$Destination/integrity.json" `
        @JsonUploadHeaders `
        @CommonArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Integrity inventory upload failed."
    }

    # The manifest is the release-visibility switch and must remain the final write.
    Write-Host "Publishing manifest last..."
    & rclone copyto `
        "$PublicationMetadataPath/manifest.json" `
        "$Destination/manifest.json" `
        @JsonUploadHeaders `
        @CommonArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Manifest upload failed."
    }

    if (-not $DryRun) {
        Write-Host "Verifying the release through its public URL..."
        $VerifyArguments = @(
            $VerifyPublishedScript,
            "--base-url", $PublicBaseUrl,
            "--source", $SourcePath,
            "--sample-count", $PublicSampleCount
        )
        if (-not [string]::IsNullOrWhiteSpace($PublicOrigin)) {
            $VerifyArguments += @("--origin", $PublicOrigin)
        }
        & node @VerifyArguments
        if ($LASTEXITCODE -ne 0) {
            throw "Public routing release verification failed."
        }
    }

    if ($DryRun) {
        Write-Host "Dry run completed for $Destination"
    }
    else {
        Write-Host "Routing dataset published to $Destination"
    }
}
finally {
    Remove-Item $PublicationMetadataPath -Recurse -Force -ErrorAction SilentlyContinue
}
