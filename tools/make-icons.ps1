# Generates the Better YouTube PNG icons with a play button and a "blocked" slash.
# Run from anywhere: powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1

Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot "..\icons"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function New-RoundedRectPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

$sizes = @(16, 32, 48, 128)

foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    $pad = [float]($size * 0.03)
    $rect = New-Object System.Drawing.RectangleF($pad, $pad, ($size - 2 * $pad), ($size - 2 * $pad))
    $radius = [float]($size * 0.22)
    $path = New-RoundedRectPath $rect.X $rect.Y $rect.Width $rect.Height $radius

    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rect,
        [System.Drawing.Color]::FromArgb(255, 255, 42, 79),
        [System.Drawing.Color]::FromArgb(255, 166, 0, 34),
        45
    )
    $g.FillPath($brush, $path)

    $highlightRect = New-Object System.Drawing.RectangleF($rect.X, $rect.Y, $rect.Width, ($rect.Height * 0.45))
    $highlightBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $highlightRect,
        [System.Drawing.Color]::FromArgb(42, 255, 255, 255),
        [System.Drawing.Color]::FromArgb(0, 255, 255, 255),
        90
    )
    $g.FillPath($highlightBrush, $path)

    $cx = [float]($size * 0.45)
    $cy = [float]($size * 0.5)
    $tw = [float]($size * 0.28)
    $th = [float]($size * 0.34)

    $triangle = New-Object System.Drawing.Drawing2D.GraphicsPath
    [System.Drawing.PointF[]]$points = @(
        (New-Object System.Drawing.PointF(($cx - $tw / 2), ($cy - $th / 2))),
        (New-Object System.Drawing.PointF(($cx - $tw / 2), ($cy + $th / 2))),
        (New-Object System.Drawing.PointF(($cx + $tw / 2), $cy))
    )
    $triangle.AddPolygon($points)

    $whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $g.FillPath($whiteBrush, $triangle)

    $x1 = [float]($size * 0.18)
    $y1 = [float]($size * 0.82)
    $x2 = [float]($size * 0.82)
    $y2 = [float]($size * 0.18)
    $outerWidth = [float]([Math]::Max(1.6, $size * 0.105))
    $innerWidth = [float]([Math]::Max(1.0, $size * 0.065))

    $darkPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 15, 15, 15), $outerWidth)
    $darkPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $darkPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLine($darkPen, $x1, $y1, $x2, $y2)

    $whitePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(210, 255, 255, 255), $innerWidth)
    $whitePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $whitePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLine($whitePen, $x1, $y1, $x2, $y2)

    $file = Join-Path $outDir ("icon{0}.png" -f $size)
    $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)

    $darkPen.Dispose()
    $whitePen.Dispose()
    $whiteBrush.Dispose()
    $brush.Dispose()
    $highlightBrush.Dispose()
    $triangle.Dispose()
    $path.Dispose()
    $g.Dispose()
    $bmp.Dispose()

    Write-Host "Wrote $file"
}
