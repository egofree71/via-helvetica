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

function Get-ConfigProperty {
    param(
        [object]$Object,
        [string]$Name
    )

    if ($null -eq $Object) {
        return $null
    }
    $Property = $Object.PSObject.Properties[$Name]
    if ($null -eq $Property) {
        return $null
    }
    return $Property.Value
}

function Normalize-ReleaseIdentifier {
    param(
        [object]$Value,
        [string]$Name
    )

    $Text = if ($null -eq $Value) { "" } else { [string]$Value }
    $Text = $Text.Trim()
    if ([string]::IsNullOrWhiteSpace($Text)) {
        throw "Routing-data configuration field $Name must be a non-empty string."
    }
    if ($Text.Contains("/") -or $Text.Contains("\")) {
        throw "Routing-data configuration field $Name must contain one path segment."
    }
    return $Text
}

function Join-PublicUrl {
    param(
        [string]$Root,
        [string]$ReleasePath
    )

    if ([string]::IsNullOrWhiteSpace($Root)) {
        return ""
    }
    return $Root.Trim().TrimEnd("/") + "/" + $ReleasePath.Trim("/")
}

$Publication = if ($null -ne $Configuration) { Get-ConfigProperty -Object $Configuration -Name "publication" } else { $null }
$ConfigDirectory = Split-Path -Parent $ConfigPath
$ReleasePath = ""
$DerivedBinaryReleaseRoot = ""

$DatasetIdValue = Get-ConfigProperty -Object $Configuration -Name "datasetId"
$FormatIdValue = Get-ConfigProperty -Object $Configuration -Name "formatId"
$DataRootValue = Get-ConfigProperty -Object $Configuration -Name "dataRoot"
$UsesDerivedLayout = $null -ne $DatasetIdValue -or $null -ne $FormatIdValue -or $null -ne $DataRootValue

if ($UsesDerivedLayout) {
    $DatasetId = Normalize-ReleaseIdentifier -Value $DatasetIdValue -Name "datasetId"
    $FormatId = Normalize-ReleaseIdentifier -Value $FormatIdValue -Name "formatId"
    $Scope = Normalize-ReleaseIdentifier -Value (Get-ConfigProperty -Object $Configuration -Name "scope") -Name "scope"
    if ($null -eq $DataRootValue -or [string]::IsNullOrWhiteSpace([string]$DataRootValue)) {
        throw "Routing-data configuration field dataRoot is required with datasetId and formatId."
    }

    $DataRoot = Resolve-ConfigPath -Value ([string]$DataRootValue) -BaseDirectory $ConfigDirectory
    $ReleasePath = "$DatasetId/$FormatId/$Scope"
    $DerivedBinaryReleaseRoot = Join-Path $DataRoot ("releases/" + $ReleasePath)
}

if (-not $PSBoundParameters.ContainsKey("Remote")) {
    $ConfiguredRemote = Get-ConfigProperty -Object $Publication -Name "remote"
    $Remote = if ($ConfiguredRemote) { [string]$ConfiguredRemote } else { "r2" }
}
if (-not $PSBoundParameters.ContainsKey("Bucket")) {
    $ConfiguredBucket = Get-ConfigProperty -Object $Publication -Name "bucket"
    $Bucket = if ($ConfiguredBucket) { [string]$ConfiguredBucket } else { "via-helvetica-routing-data" }
}
if (-not $PSBoundParameters.ContainsKey("Prefix")) {
    $ConfiguredPrefix = Get-ConfigProperty -Object $Publication -Name "prefix"
    $Prefix = if ($ConfiguredPrefix) { [string]$ConfiguredPrefix } else { $ReleasePath }
}
if (-not $PSBoundParameters.ContainsKey("Source")) {
    $ConfiguredSource = Get-ConfigProperty -Object $Configuration -Name "binaryReleaseRoot"
    if ($ConfiguredSource) {
        $Source = Resolve-ConfigPath -Value ([string]$ConfiguredSource) -BaseDirectory $ConfigDirectory
    }
    elseif (-not [string]::IsNullOrWhiteSpace($DerivedBinaryReleaseRoot)) {
        $Source = [System.IO.Path]::GetFullPath($DerivedBinaryReleaseRoot)
    }
}
if (-not $PSBoundParameters.ContainsKey("PublicBaseUrl")) {
    $ConfiguredPublicBaseUrl = Get-ConfigProperty -Object $Publication -Name "publicBaseUrl"
    if ($ConfiguredPublicBaseUrl) {
        $PublicBaseUrl = [string]$ConfiguredPublicBaseUrl
    }
    else {
        $PublicRootUrl = Get-ConfigProperty -Object $Publication -Name "publicRootUrl"
        $PublicBaseUrl = Join-PublicUrl -Root ([string]$PublicRootUrl) -ReleasePath $ReleasePath
    }
}
if (-not $PSBoundParameters.ContainsKey("PublicOrigin")) {
    $ConfiguredPublicOrigin = Get-ConfigProperty -Object $Publication -Name "publicOrigin"
    $PublicOrigin = if ($ConfiguredPublicOrigin) { [string]$ConfiguredPublicOrigin } else { "" }
}
if (-not $PSBoundParameters.ContainsKey("PublicSampleCount")) {
    $ConfiguredSampleCount = Get-ConfigProperty -Object $Publication -Name "publicSampleCount"
    $PublicSampleCount = if ($ConfiguredSampleCount) { [int]$ConfiguredSampleCount } else { 50 }
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
    throw "datasetId, formatId, and scope must define the publication prefix, or -Prefix must be supplied."
}
if ([string]::IsNullOrWhiteSpace($Source)) {
    throw "dataRoot must derive binaryReleaseRoot, or -Source must be supplied."
}
if ($ExpectedCellCount -lt 0) {
    throw "ExpectedCellCount cannot be negative."
}
if ($PublicSampleCount -le 0) {
    throw "PublicSampleCount must be positive."
}
if (-not $DryRun -and [string]::IsNullOrWhiteSpace($PublicBaseUrl)) {
    throw "publication.publicRootUrl or PublicBaseUrl is required for a real publication."
}
if (-not $DryRun -and [string]::IsNullOrWhiteSpace($PublicOrigin)) {
    throw "publication.publicOrigin or PublicOrigin is required for a real publication so CORS is always verified."
}
if (-not $DryRun) {
    [System.Uri]$PublicOriginUri = $null
    if (
        -not [System.Uri]::TryCreate($PublicOrigin.Trim(), [System.UriKind]::Absolute, [ref]$PublicOriginUri) -or
        ($PublicOriginUri.Scheme -ne "http" -and $PublicOriginUri.Scheme -ne "https") -or
        $PublicOriginUri.UserInfo -ne "" -or
        $PublicOriginUri.AbsolutePath -ne "/" -or
        $PublicOriginUri.Query -ne "" -or
        $PublicOriginUri.Fragment -ne ""
    ) {
        throw "publication.publicOrigin or PublicOrigin must be an HTTP(S) origin without a path, query, or fragment."
    }
    $PublicOrigin = $PublicOriginUri.GetLeftPart([System.UriPartial]::Authority)
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

    if ($ExpectedCellCount -eq 0) {
        $ManifestPath = Join-Path $SourcePath "manifest.json"
        try {
            $LocalManifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
            $ExpectedCellCount = [int]$LocalManifest.nonEmptyCellCount
        }
        catch {
            throw "Cannot read nonEmptyCellCount from ${ManifestPath}: $_"
        }
        if ($ExpectedCellCount -le 0) {
            throw "Local manifest nonEmptyCellCount must be positive."
        }
    }

    Write-Host "Preparing publication-only manifest and integrity metadata for $ExpectedCellCount cells..."
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
    # Metadata is immutable because the release identity is part of its URL. A
    # corrected dataset must use a new release path rather than overwrite this one.
    $ImmutableJsonUploadHeaders = @(
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
        @ImmutableJsonUploadHeaders `
        @CommonArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Integrity inventory upload failed."
    }

    # The manifest is the release-visibility switch and must remain the final write.
    Write-Host "Publishing manifest last..."
    & rclone copyto `
        "$PublicationMetadataPath/manifest.json" `
        "$Destination/manifest.json" `
        @ImmutableJsonUploadHeaders `
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
            "--sample-count", $PublicSampleCount,
            "--origin", $PublicOrigin
        )
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
