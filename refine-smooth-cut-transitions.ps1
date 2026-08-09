$ErrorActionPreference = 'Stop'
$target = 'C:\Users\alphabatkim\video-editor\index.html'
if (-not (Test-Path -LiteralPath $target)) { throw "App file not found: $target" }
$text = [IO.File]::ReadAllText($target) -replace "`r`n", "`n"
if ($text.Contains('smooth-cut-audio-crossfade-fix-v2')) {
  Write-Host 'Smooth cut audio refinement is already installed.'
  exit 0
}
$backup = "$target.before-smooth-cut-refine-$(Get-Date -Format yyyyMMdd-HHmmss).html"
[IO.File]::Copy($target, $backup, $false)
$helper = @'
// Keep dialogue and clip audio from overlapping for the full visual dissolve.
// A short audio handoff prevents clicks without making speech sound doubled.
function getAudioTransitionAt(time) {
  const tr = getTransitionAt(time);
  if (!tr) return null;
  const end = tr.from.startTime + tr.from.duration;
  const duration = Math.min(0.12, tr.duration);
  const start = end - duration;
  if (time < start || time >= end) return null;
  return { ...tr, alpha: smoothStep01((time - start) / duration), duration };
}
'@
$text = $text.Replace('function drawCover(', "$helper`nfunction drawCover(")
$text = $text.Replace('// smooth-cut-audio-crossfade-fix', '// smooth-cut-audio-crossfade-fix-v2')
$text = $text.Replace('const transition = S.playing ? getTransitionAt(S.t) : null;', 'const transition = S.playing ? getAudioTransitionAt(S.t) : null;')
$text = $text.Replace('const transition = getTransitionAt(t);', 'const transition = getAudioTransitionAt(t);')
[IO.File]::WriteAllText($target, $text, (New-Object Text.UTF8Encoding($false)))
Write-Host "Refined cut audio handoff in $target"
Write-Host "Backup: $backup"
