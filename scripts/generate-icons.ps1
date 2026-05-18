# Generate icon PNGs at 16, 32, 48, 128 px for a transcript-extractor extension.
# Idiom: rounded-square in a brand colour, three white horizontal bars
# (transcript rows). Renders crisply at small sizes.
#
# Usage:
#   .\scripts\generate-icons.ps1 -OutDir extensions\stream\icons   -Hex 0078D4  # Microsoft blue
#   .\scripts\generate-icons.ps1 -OutDir extensions\substack\icons -Hex FF6719  # Substack orange

param(
    [Parameter(Mandatory)][string]$OutDir,
    [Parameter(Mandatory)][string]$Hex  # 6-digit hex, no leading '#'
)

Add-Type -AssemblyName System.Drawing

if ($Hex -match '^#') { $Hex = $Hex.Substring(1) }
if ($Hex.Length -ne 6) { throw "Hex must be 6 hex digits (got '$Hex')." }
$r = [Convert]::ToInt32($Hex.Substring(0, 2), 16)
$g = [Convert]::ToInt32($Hex.Substring(2, 2), 16)
$b = [Convert]::ToInt32($Hex.Substring(4, 2), 16)

function New-ExtensionIcon {
    param(
        [Parameter(Mandatory)][int]$Size,
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][int]$R,
        [Parameter(Mandatory)][int]$G,
        [Parameter(Mandatory)][int]$B
    )
    $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
    $gfx = [System.Drawing.Graphics]::FromImage($bmp)
    $gfx.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $gfx.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $gfx.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $gfx.Clear([System.Drawing.Color]::Transparent)

    $brand = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, $R, $G, $B))
    $radius = [int]([Math]::Max(2, [Math]::Round($Size * 0.18)))
    $diameter = $radius * 2
    $bgPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $bgPath.AddArc(0,            0,             $diameter, $diameter, 180, 90)
    $bgPath.AddArc($Size - $diameter, 0,        $diameter, $diameter, 270, 90)
    $bgPath.AddArc($Size - $diameter, $Size - $diameter, $diameter, $diameter, 0,   90)
    $bgPath.AddArc(0,            $Size - $diameter, $diameter, $diameter, 90,  90)
    $bgPath.CloseFigure()
    $gfx.FillPath($brand, $bgPath)

    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $barHeight  = [int]([Math]::Max(1, [Math]::Round($Size * 0.10)))
    $marginX    = [int]([Math]::Round($Size * 0.22))
    $maxBarW    = $Size - 2 * $marginX
    $shortBarW  = [int]([Math]::Round($maxBarW * 0.62))
    $firstBarY  = [int]([Math]::Round($Size * 0.30))
    $rowGap     = [int]([Math]::Round($Size * 0.18))
    for ($i = 0; $i -lt 3; $i++) {
        $y = $firstBarY + $i * $rowGap
        $w = if ($i -eq 2) { $shortBarW } else { $maxBarW }
        $br = [int]([Math]::Max(1, [Math]::Floor($barHeight / 2)))
        $bd = $br * 2
        $barPath = New-Object System.Drawing.Drawing2D.GraphicsPath
        if ($w -gt $bd -and $barHeight -ge 2) {
            $barPath.AddArc($marginX,              $y,                $bd, $bd, 90, 180)
            $barPath.AddArc($marginX + $w - $bd,   $y,                $bd, $bd, 270, 180)
            $barPath.CloseFigure()
        } else {
            $barPath.AddRectangle((New-Object System.Drawing.Rectangle($marginX, $y, $w, $barHeight)))
        }
        $gfx.FillPath($white, $barPath)
        $barPath.Dispose()
    }

    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $gfx.Dispose(); $bmp.Dispose(); $bgPath.Dispose(); $brand.Dispose(); $white.Dispose()
}

$absOut = if ([IO.Path]::IsPathRooted($OutDir)) { $OutDir } else { Join-Path (Get-Location) $OutDir }
if (-not (Test-Path $absOut)) { New-Item -ItemType Directory -Path $absOut -Force | Out-Null }
New-ExtensionIcon -Size 16  -Path (Join-Path $absOut 'icon-16.png')  -R $r -G $g -B $b
New-ExtensionIcon -Size 32  -Path (Join-Path $absOut 'icon-32.png')  -R $r -G $g -B $b
New-ExtensionIcon -Size 48  -Path (Join-Path $absOut 'icon-48.png')  -R $r -G $g -B $b
New-ExtensionIcon -Size 128 -Path (Join-Path $absOut 'icon-128.png') -R $r -G $g -B $b
Write-Host "Generated 4 icons in $absOut (#$Hex)"
