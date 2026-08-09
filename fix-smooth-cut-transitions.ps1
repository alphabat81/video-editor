$ErrorActionPreference = 'Stop'
$target = 'C:\Users\alphabatkim\video-editor\index.html'
if (-not (Test-Path -LiteralPath $target)) { throw "App file not found: $target" }

$text = [IO.File]::ReadAllText($target) -replace "`r`n", "`n"
if ($text.Contains('smooth-cut-audio-crossfade-fix')) {
  Write-Host 'Smooth cut transition fix is already installed.'
  exit 0
}

$backup = "$target.before-smooth-cut-$(Get-Date -Format yyyyMMdd-HHmmss).html"
[IO.File]::Copy($target, $backup, $false)

$helper = @'
// Smooth-cut audio/preview pair lookup. Keeping this in one place makes the
// visual preview, live playback, and export mixer use the exact same boundary.
function getTransitionAt(time) {
  if (!S.autoTransition) return null;
  for (const from of getTrackMediaClips()) {
    const tr = getAutoTransitionAt(time, from);
    if (tr) return { from, ...tr };
  }
  return null;
}
'@
$text = $text.Replace('function drawCover(', "$helper`nfunction drawCover(")

$syncPattern = '(?s)function syncVideoPlayback\(\) \{.*?\n\}\nfunction play\(\)'
$syncReplacement = @'
// smooth-cut-audio-crossfade-fix
function syncVideoPlayback() {
  const transition = S.playing ? getTransitionAt(S.t) : null;
  S.clips.forEach(c => {
    if (c.type !== 'video' || !c.element) return;
    const active = S.playing && S.t >= c.startTime && S.t < c.startTime + c.duration;
    const transitionPreview = S.playing && isClipNeededForTransition(c, S.t);
    const transitionNext = !!(transition && transition.next?.id === c.id);
    const transitionFrom = !!(transition && transition.from?.id === c.id);
    if (!active && !transitionNext) {
      if (transitionPreview) {
        try { c.element.currentTime = 0; } catch(e) {}
      }
      if (!transitionPreview && !c.element.paused) c.element.pause();
      return;
    }
    const localTime = Math.max(0, S.t - c.startTime);
    const driftLimit = EXP.suppressLiveAudio ? 0.85 : 0.45;
    if (Math.abs(c.element.currentTime - localTime) > driftLimit) {
      try { c.element.currentTime = localTime; } catch(e) {}
    }
    c.element.muted = !!EXP.suppressLiveAudio;
    const baseVolume = c.vol != null ? c.vol : 1;
    let mix = 1;
    if (transitionFrom) mix *= (1 - transition.alpha);
    if (transitionNext) mix *= transition.alpha;
    c.element.volume = baseVolume * Math.max(0, Math.min(1, mix));
    if (c.element.paused) c.element.play().catch(()=>{});
  });
}
function play()
'@
$updated = [regex]::Replace($text, $syncPattern, $syncReplacement, 1)
if ($updated -eq $text) { throw 'Could not locate syncVideoPlayback block.' }
$text = $updated

$text = $text.Replace("      audio,`n      start:", "      audio,`n      gainNode: gain,`n      baseVolume: opt.volume == null ? 1 : opt.volume,`n      clipId: opt.clipId == null ? null : opt.clipId,`n      start:")
$text = $text.Replace("        volume: c.vol != null ? c.vol : 1,`n      });", "        volume: c.vol != null ? c.vol : 1,`n        clipId: c.id,`n      });")

$mixerPattern = '(?s)    sync\(t\) \{.*?\n    \},\n    async prepare\(\)'
$mixerReplacement = @'
    sync(t) {
      const transition = getTransitionAt(t);
      tracks.forEach(track => {
        const transitionNext = !!(transition && track.clipId != null && transition.next?.id === track.clipId);
        const transitionFrom = !!(transition && track.clipId != null && transition.from?.id === track.clipId);
        const inRange = (t >= track.start && t < track.end) || transitionNext;
        if (!inRange) {
          if (track.active) {
            track.audio.pause();
            track.active = false;
          }
          track.gainNode.gain.value = 0;
          return;
        }
        const localTime = Math.max(0, t - track.start);
        let at = localTime + track.offset;
        if (track.loop && track.loopDuration > 0) {
          at = track.offset + (localTime % track.loopDuration);
        } else if (track.loop && track.duration > 0) {
          at = (localTime + track.offset) % track.duration;
        }
        let mix = 1;
        if (transitionFrom) mix *= (1 - transition.alpha);
        if (transitionNext) mix *= transition.alpha;
        track.gainNode.gain.value = track.baseVolume * Math.max(0, Math.min(1, mix));
        if (Number.isFinite(at) && Math.abs(track.audio.currentTime - at) > 0.18) {
          try { track.audio.currentTime = Math.max(0, at); } catch(e) {}
        }
        if (!track.active || track.audio.paused) {
          track.active = true;
          track.audio.play().catch(() => {});
        }
      });
    },
    async prepare()
'@
$updated = [regex]::Replace($text, $mixerPattern, $mixerReplacement, 1)
if ($updated -eq $text) { throw 'Could not locate export audio mixer block.' }
$text = $updated

[IO.File]::WriteAllText($target, $text, (New-Object Text.UTF8Encoding($false)))
Write-Host "Installed smooth cut transitions in $target"
Write-Host "Backup: $backup"
