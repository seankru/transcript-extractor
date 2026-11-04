param(
    [Parameter(Mandatory)][ValidatePattern('^[a-p]{32}$')][string[]]$ExtensionId,
    [ValidateSet('Edge', 'Chrome')][string]$Browser = 'Edge',
    [ValidateSet('tiny', 'base', 'small', 'medium', 'large-v3')][string]$Model = 'small',
    [string]$Python = 'python'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
& (Join-Path $root 'scripts\prepare-extensions.ps1')
$pythonPath = (& $Python -c 'import sys; print(sys.executable)').Trim()
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $pythonPath)) { throw 'Python 3.10+ is required.' }
& $pythonPath -c 'import faster_whisper, yt_dlp' 2>$null
if ($LASTEXITCODE -ne 0) {
    & $pythonPath -m pip install -r (Join-Path $PSScriptRoot 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Could not install local transcription dependencies.' }
}
$install = Join-Path $env:LOCALAPPDATA 'TranscriptExtractor'
New-Item -ItemType Directory -Path (Join-Path $install 'jobs') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'native_host.py') -Destination $install -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'podcast.py') -Destination $install -Force
Copy-Item -LiteralPath (Join-Path $root 'tools\transcribe-substack\transcribe.py') -Destination $install -Force
$downloads = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders').'{374DE290-123F-4565-9164-39C4925E467B}'
if (-not $downloads) { $downloads = Join-Path $HOME 'Downloads' }
$configPath = Join-Path $install 'config.json'
$origins = @($ExtensionId | ForEach-Object { "chrome-extension://$_/" })
if (Test-Path -LiteralPath $configPath) {
    $existing = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $origins += @($existing.allowed_origins)
}
$origins = @($origins | Sort-Object -Unique)
@{
    model = $Model
    downloads = [Environment]::ExpandEnvironmentVariables($downloads)
    jobs = Join-Path $install 'jobs'
    ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
    allowed_origins = $origins
} | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8NoBOM
$launcher = Join-Path $install 'host.cmd'
"@echo off`r`n`"$pythonPath`" `"$install\native_host.py`" %*`r`n" |
    Set-Content -LiteralPath $launcher -Encoding ascii
$manifest = Join-Path $install 'com.transcript_extractor.local.json'
@{
    name = 'com.transcript_extractor.local'
    description = 'On-device Whisper transcription for Transcript Extractors'
    path = $launcher
    type = 'stdio'
    allowed_origins = $origins
} | ConvertTo-Json | Set-Content -LiteralPath $manifest -Encoding utf8NoBOM
$vendor = if ($Browser -eq 'Edge') { 'Microsoft\Edge' } else { 'Google\Chrome' }
$key = "HKCU:\Software\$vendor\NativeMessagingHosts\com.transcript_extractor.local"
New-Item -Path $key -Force | Out-Null
Set-Item -Path $key -Value $manifest
Write-Host "Installed local Whisper helper ($Model). Reload the extensions at edge://extensions or chrome://extensions."
