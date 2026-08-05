<#
.SYNOPSIS
  Transcribe a Substack inline-body video from an authed Edge tab.

.DESCRIPTION
  Drives the full pipeline:
    1. .driver/resolve-substack-video.mjs   (Playwright CDP probe)
    2. yt-dlp                                (HLS -> MP4, via transcribe.py)
    3. transcribe.py                         (faster-whisper)

  Prerequisites:
    - Edge running with CDP enabled, signed in to the Substack publication.
      Start it via:  pwsh .driver/launch-edge.ps1
    - Node + Playwright installed (resolver uses chromium.connectOverCDP).
    - yt-dlp on PATH:  pip install -U yt-dlp
    - faster-whisper on PATH:  pip install -U faster-whisper
    - The post tab is open in Edge.

.PARAMETER Tab
  A fragment of the open tab's URL (e.g. the post slug). Used to locate the
  authed tab among open Edge tabs.

.PARAMETER Model
  Whisper model size. tiny|base|small|medium|large-v3. Default: small.

.PARAMETER OutputDir
  Directory to write the .vtt and .md files. Default: a temp dir under $env:TEMP.

.PARAMETER Name
  Basename for output files (without extension). Default: 'video'.

.PARAMETER KeepVideo
  Retain the downloaded .mp4 after transcription. By default it is deleted.

.PARAMETER Language
  ISO language code for transcription (e.g. 'en'). Default: auto-detect.

.EXAMPLE
  pwsh .\transcribe-from-tab.ps1 -Tab "example-post" -Model small
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory, Position = 0)]
  [string]$Tab,

  [ValidateSet('tiny', 'base', 'small', 'medium', 'large-v3')]
  [string]$Model = 'small',

  [string]$OutputDir,

  [string]$Name = 'video',

  [switch]$KeepVideo,

  [string]$Language
)

$ErrorActionPreference = 'Stop'

# Locate sibling scripts.
$scriptDir = $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
$resolver = Join-Path $repoRoot '.driver\resolve-substack-video.mjs'
$transcribe = Join-Path $scriptDir 'transcribe.py'

if (-not (Test-Path $resolver)) {
  throw "Resolver not found at $resolver"
}
if (-not (Test-Path $transcribe)) {
  throw "transcribe.py not found at $transcribe"
}

# Find a node executable. Prefer the standard install; fall back to PATH.
$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $node)) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "node not found. Install Node.js or add it to PATH."
  }
  $node = $cmd.Source
}

Write-Host "[transcribe-from-tab] Resolving Mux URL via Playwright..." -ForegroundColor Cyan
$probeOutput = & $node $resolver $Tab
if ($LASTEXITCODE -ne 0) {
  Write-Error "Resolver failed with exit code $LASTEXITCODE"
  exit $LASTEXITCODE
}

$probe = $probeOutput | ConvertFrom-Json
if (-not $probe.muxUrl) {
  Write-Error "Resolver returned no muxUrl. Output was:`n$probeOutput"
  exit 1
}

Write-Host "[transcribe-from-tab] Resolved post: $($probe.title)" -ForegroundColor DarkGray
Write-Host "[transcribe-from-tab] Downloading and transcribing (model=$Model)..." -ForegroundColor Cyan

# Build argument list for transcribe.py.
$pyArgs = @(
  $transcribe,
  '--url', $probe.muxUrl,
  '--name', $Name,
  '--model', $Model
)
if ($OutputDir) {
  if (-not (Test-Path $OutputDir)) { New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null }
  $pyArgs += @('--output-dir', $OutputDir)
}
if ($KeepVideo) { $pyArgs += '--keep-video' }
if ($Language)  { $pyArgs += @('--language', $Language) }

& python @pyArgs
if ($LASTEXITCODE -ne 0) {
  Write-Error "transcribe.py failed with exit code $LASTEXITCODE"
  exit $LASTEXITCODE
}
