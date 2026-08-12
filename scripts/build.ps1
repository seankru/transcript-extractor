# Build a submission zip for one of the extensions in this monorepo.
#
# Usage:
#   .\scripts\build.ps1 -Name stream
#   .\scripts\build.ps1 -Name substack
#   .\scripts\build.ps1 -Name youtube
#
# Output: dist\<name>-transcript-extractor-v<version>.zip, where <version> is
# read from extensions\<name>\manifest.json.

param(
    [Parameter(Mandatory)][string]$Name
)

$root      = Split-Path -Parent $PSScriptRoot
$extDir    = Join-Path $root "extensions\$Name"
$manifest  = Join-Path $extDir 'manifest.json'

if (-not (Test-Path $manifest)) {
    throw "No manifest at $manifest. Expected extensions\$Name\manifest.json."
}

$manifestObj = Get-Content $manifest -Raw | ConvertFrom-Json
$version     = $manifestObj.version
if (-not $version) { throw "manifest.json missing 'version' field." }

$distDir = Join-Path $root 'dist'
if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir | Out-Null }

$zipPath = Join-Path $distDir "$Name-transcript-extractor-v$version.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

# Zip just the extension's own contents (NOT the README, NOT the screenshots/
# folder — those aren't part of the loadable extension surface).
$included = @('manifest.json', 'popup.html', 'popup.js', 'icons')
$paths = $included |
    ForEach-Object { Join-Path $extDir $_ } |
    Where-Object   { Test-Path $_ }

if ($paths.Count -eq 0) { throw "No extension files found under $extDir." }

Compress-Archive -Path $paths -DestinationPath $zipPath -Force

$bytes = (Get-Item $zipPath).Length
Write-Host "Built $zipPath ($bytes bytes)"
