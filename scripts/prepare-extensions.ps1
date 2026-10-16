$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
foreach ($name in @('stream', 'substack', 'youtube', 'spotify')) {
    foreach ($file in @('transcription-worker.js', 'transcription-client.js')) {
        Copy-Item -LiteralPath (Join-Path $root "extensions\_shared\$file") `
            -Destination (Join-Path $root "extensions\$name\$file") -Force
    }
}
