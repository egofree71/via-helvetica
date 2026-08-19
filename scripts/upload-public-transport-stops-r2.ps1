<#
Business context: publishes one verified immutable public-transport stop catalog
release to Cloudflare R2 through an existing rclone S3 remote. The browser JSON
is stored pre-compressed but exposed as `stops.json` with `Content-Encoding: br`;
`release.json` is uploaded last so published provenance never claims a complete release before the catalog object exists.
Credentials stay in rclone and never enter the repository.
#>

[CmdletBinding()]
param(
    [string]$Config = "public-transport-data.config.local.json",
    [string]$Source = "",
    [string]$Remote = "",
    [string]$Bucket = "",
    [string]$PublicRootUrl = "",
    [string]$PublicOrigin = "",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$VerifyLocalScript = Join-Path $PSScriptRoot "verify-public-transport-stops-release.mjs"
$VerifyPublishedScript = Join-Path $PSScriptRoot "verify-published-public-transport-stops.mjs"

function Resolve-ConfigPath {
    param([string]$Value, [string]$BaseDirectory)
    if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
    if ([System.IO.Path]::IsPathRooted($Value)) {
        return [System.IO.Path]::GetFullPath($Value)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $BaseDirectory $Value))
}

function Get-ConfigProperty {
    param([object]$Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $Property = $Object.PSObject.Properties[$Name]
    if ($null -eq $Property) { return $null }
    return $Property.Value
}

function Join-PublicUrl {
    param([string]$Root, [string]$RelativePath)
    return $Root.Trim().TrimEnd("/") + "/" + $RelativePath.Trim("/")
}

$ConfigPath = Resolve-ConfigPath -Value $Config -BaseDirectory $ProjectRoot
$Configuration = $null
if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
    try {
        $Configuration = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    }
    catch {
        throw "Cannot parse public-transport data configuration ${ConfigPath}: $_"
    }
}
elseif ($PSBoundParameters.ContainsKey("Config")) {
    throw "Public-transport data configuration not found: $ConfigPath"
}

$ConfigDirectory = if ($Configuration) { Split-Path -Parent $ConfigPath } else { $ProjectRoot }
$Publication = if ($Configuration) { Get-ConfigProperty -Object $Configuration -Name "publication" } else { $null }

if (-not $PSBoundParameters.ContainsKey("Source")) {
    $ConfiguredSource = Get-ConfigProperty -Object $Configuration -Name "releaseRoot"
    if ($ConfiguredSource) {
        $Source = Resolve-ConfigPath -Value ([string]$ConfiguredSource) -BaseDirectory $ConfigDirectory
    }
}
if (-not $PSBoundParameters.ContainsKey("Remote")) {
    $ConfiguredRemote = Get-ConfigProperty -Object $Publication -Name "remote"
    $Remote = if ($ConfiguredRemote) { [string]$ConfiguredRemote } else { "r2" }
}
if (-not $PSBoundParameters.ContainsKey("Bucket")) {
    $ConfiguredBucket = Get-ConfigProperty -Object $Publication -Name "bucket"
    $Bucket = if ($ConfiguredBucket) { [string]$ConfiguredBucket } else { "" }
}
if (-not $PSBoundParameters.ContainsKey("PublicRootUrl")) {
    $ConfiguredPublicRootUrl = Get-ConfigProperty -Object $Publication -Name "publicRootUrl"
    $PublicRootUrl = if ($ConfiguredPublicRootUrl) { [string]$ConfiguredPublicRootUrl } else { "" }
}
if (-not $PSBoundParameters.ContainsKey("PublicOrigin")) {
    $ConfiguredPublicOrigin = Get-ConfigProperty -Object $Publication -Name "publicOrigin"
    $PublicOrigin = if ($ConfiguredPublicOrigin) { [string]$ConfiguredPublicOrigin } else { "" }
}

if (-not (Get-Command rclone -ErrorAction SilentlyContinue)) {
    throw "rclone was not found. Install and configure an R2-compatible S3 remote first."
}
if ([string]::IsNullOrWhiteSpace($Source)) { throw "releaseRoot or -Source is required." }
if ([string]::IsNullOrWhiteSpace($Remote)) { throw "publication.remote or -Remote is required." }
if ([string]::IsNullOrWhiteSpace($Bucket)) { throw "publication.bucket or -Bucket is required." }
if (-not $DryRun -and [string]::IsNullOrWhiteSpace($PublicRootUrl)) {
    throw "publication.publicRootUrl or -PublicRootUrl is required for a real publication."
}
if (-not $DryRun -and [string]::IsNullOrWhiteSpace($PublicOrigin)) {
    throw "publication.publicOrigin or -PublicOrigin is required for public CORS verification."
}

$SourcePath = (Resolve-Path -LiteralPath $Source).Path
$ManifestPath = Join-Path $SourcePath "release.json"
$CompressedCatalogPath = Join-Path $SourcePath "stops.json.br"
if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
    throw "Release manifest not found: $ManifestPath"
}
if (-not (Test-Path -LiteralPath $CompressedCatalogPath -PathType Leaf)) {
    throw "Brotli catalog not found: $CompressedCatalogPath"
}

try {
    $Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
}
catch {
    throw "Cannot parse release manifest ${ManifestPath}: $_"
}

foreach ($Name in @("datasetId", "formatId", "scope", "object", "catalogSha256")) {
    $Value = Get-ConfigProperty -Object $Manifest -Name $Name
    if ([string]::IsNullOrWhiteSpace([string]$Value)) {
        throw "Release manifest field $Name must be a non-empty string."
    }
}
if ([string]$Manifest.object -ne "stops.json") {
    throw "Release manifest object must be stops.json."
}

$ReleasePath = "$($Manifest.datasetId)/$($Manifest.formatId)/$($Manifest.scope)"
$Destination = "${Remote}:${Bucket}/$ReleasePath"
$PublicBaseUrl = if ([string]::IsNullOrWhiteSpace($PublicRootUrl)) { "" } else { Join-PublicUrl -Root $PublicRootUrl -RelativePath $ReleasePath }

$CommonArguments = @(
    "--s3-no-check-bucket",
    "--immutable",
    "--progress"
)
if ($DryRun) { $CommonArguments += "--dry-run" }

$CatalogHeaders = @(
    "--header-upload", "Content-Encoding: br",
    "--header-upload", "Content-Type: application/json; charset=utf-8",
    "--header-upload", "Cache-Control: public, max-age=31536000, immutable"
)
$JsonHeaders = @(
    "--header-upload", "Content-Type: application/json; charset=utf-8",
    "--header-upload", "Cache-Control: public, max-age=31536000, immutable"
)

Write-Host "Verifying the complete local public-transport release..."
& node $VerifyLocalScript --source $SourcePath
if ($LASTEXITCODE -ne 0) { throw "Local public-transport stop release verification failed." }

Write-Host "Publishing immutable public-transport stop release $ReleasePath"
Write-Host "Uploading Brotli catalog first..."
& rclone copyto `
    $CompressedCatalogPath `
    "$Destination/stops.json" `
    @CatalogHeaders `
    @CommonArguments
if ($LASTEXITCODE -ne 0) { throw "Public-transport stop catalog upload failed." }

# release.json is intentionally last: a partial upload never publishes provenance
# claiming completeness before the catalog object exists. Application rollout is
# still controlled separately by the configured immutable catalog URL.
Write-Host "Publishing release manifest last..."
& rclone copyto `
    $ManifestPath `
    "$Destination/release.json" `
    @JsonHeaders `
    @CommonArguments
if ($LASTEXITCODE -ne 0) { throw "Public-transport release manifest upload failed." }

if ($DryRun) {
    Write-Host "Dry run completed for $Destination"
    exit 0
}

Write-Host "Verifying the release through its public URL..."
& node $VerifyPublishedScript `
    --base-url $PublicBaseUrl `
    --source $SourcePath `
    --origin $PublicOrigin
if ($LASTEXITCODE -ne 0) { throw "Public public-transport stop release verification failed." }

Write-Host "Public-transport stop catalog published to $Destination"
Write-Host "Application catalog URL: $PublicBaseUrl/stops.json"
