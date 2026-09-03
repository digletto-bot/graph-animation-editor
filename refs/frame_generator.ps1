param(
  [Parameter(Position = 0, Mandatory = $false)]
  [int]$TargetFrames = 10
)

$inputPath = Join-Path $PSScriptRoot 'line_bird_animation_cropped.mp4'
$outputPath = Join-Path $PSScriptRoot 'frames'

# Reset / create frames directory
if (Test-Path -LiteralPath $outputPath -PathType Container) {
  Get-ChildItem -LiteralPath $outputPath -Force |
    Remove-Item -Recurse -Force
} else {
  New-Item -ItemType Directory -Path $outputPath | Out-Null
}

$totalFrames = [int](
  ffprobe `
    -v error `
    -select_streams v:0 `
    -count_frames `
    -show_entries stream=nb_read_frames `
    -of 'default=noprint_wrappers=1:nokey=1' `
    $inputPath
)

$lastTargetIndex = $TargetFrames - 1

$indices = 0..$lastTargetIndex | ForEach-Object {
  [math]::Round($_ * ($totalFrames - 1) / $lastTargetIndex)
}

$select = ($indices | ForEach-Object {
    "eq(n\,$_)"
  }) -join '+'

$outputPattern = Join-Path $outputPath 'frame_%02d.png'

ffmpeg `
  -loglevel error `
  -i $inputPath `
  -vf "select=$select" `
  -fps_mode vfr `
  $outputPattern

$frameCount = (Get-ChildItem -LiteralPath $outputPath -Filter 'frame_*.png' -File).Count

if ($frameCount -eq $TargetFrames) {
  _f "Extracted $TargetFrames frames successfully" '100;255;100' '-b'
} else {
  _f "Error: Extracted $frameCount frames" '255;100;100' '-b'
}