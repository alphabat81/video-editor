/* Exact timeline export. Decoder/audio preparation time is never recorded. */
(() => {
  'use strict';
  const cancelled = () => { if (EXP.cancelled) throw new Error('내보내기를 취소했습니다.'); };
  const number = value => Math.max(0, Number(value) || 0);
  const seconds = value => number(value).toFixed(6);

  function mediaReady(element, url) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('원본 영상 준비 시간이 초과되었습니다.')), 30000);
      const finish = error => {
        clearTimeout(timer);
        element.removeEventListener('loadeddata', ready);
        element.removeEventListener('error', failed);
        EXP.frameAbort?.signal.removeEventListener('abort', aborted);
        error ? reject(error) : resolve();
      };
      const ready = () => finish();
      const failed = () => finish(new Error('원본 영상을 읽을 수 없습니다. 파일을 다시 불러와 주세요.'));
      const aborted = () => finish(new Error('내보내기를 취소했습니다.'));
      EXP.frameAbort?.signal.addEventListener('abort', aborted, { once: true });
      element.addEventListener('loadeddata', ready);
      element.addEventListener('error', failed);
      element.preload = 'auto'; element.muted = true; element.playsInline = true;
      element.src = url; element.load();
    });
  }

  async function seekFrame(video, requested) {
    cancelled();
    if (video.readyState < 2) await mediaReady(video, video.currentSrc || video.src);
    cancelled();
    const end = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.001) : Infinity;
    const target = Math.max(0, Math.min(number(requested), end));
    if (video.readyState >= 2 && !video.seeking && Math.abs(video.currentTime - target) < 0.00001) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('영상 프레임을 읽지 못했습니다. 같은 화면을 반복 저장하지 않고 내보내기를 중단합니다.')), 30000);
      const finish = error => {
        clearTimeout(timer);
        video.removeEventListener('seeked', ready); video.removeEventListener('error', failed);
        EXP.frameAbort?.signal.removeEventListener('abort', aborted);
        error ? reject(error) : resolve();
      };
      const ready = () => { if (video.readyState >= 2 && !video.seeking) finish(); };
      const failed = () => finish(new Error('영상 프레임 디코딩에 실패했습니다.'));
      const aborted = () => finish(new Error('내보내기를 취소했습니다.'));
      EXP.frameAbort?.signal.addEventListener('abort', aborted, { once: true });
      video.addEventListener('seeked', ready); video.addEventListener('error', failed);
      try { video.currentTime = target; } catch (error) { finish(error); }
    });
    cancelled();
  }

  async function prepareFrame(time) {
    const visible = S.clips.filter(c => c.track === 0 && time >= c.startTime && time < c.startTime + c.duration);
    for (const clip of visible.slice()) {
      const transition = getAutoTransitionAt(time, clip);
      if (transition?.next) visible.push(transition.next);
    }
    visible.push(...S.clips.filter(c => c.type === 'sticker' && c.element?.tagName === 'VIDEO' &&
      time >= c.startTime && time < c.startTime + c.duration));
    for (const clip of S.clips) {
      if (clip.element?.tagName === 'VIDEO' && clip.element.readyState >= 2 &&
          time >= clip.startTime + clip.duration && !visible.includes(clip)) {
        clip.element.removeAttribute('src'); clip.element.load();
      }
    }
    await Promise.all([...new Set(visible)].filter(c => c.element?.tagName === 'VIDEO').map(c =>
      seekFrame(c.element, Math.max(0, time - c.startTime))));
    cancelled();
    S.t = time;
    renderPreview();
  }

  function wav16(buffer) {
    const channels = 2, frames = buffer.length, bytes = new ArrayBuffer(44 + frames * channels * 2);
    const view = new DataView(bytes);
    const text = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
    text(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
    view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); text(36, 'data');
    view.setUint32(40, bytes.byteLength - 44, true);
    const left = buffer.getChannelData(0), right = buffer.getChannelData(Math.min(1, buffer.numberOfChannels - 1));
    for (let i = 0; i < frames; i++) {
      for (let channel = 0; channel < 2; channel++) {
        const sample = Math.max(-1, Math.min(1, channel ? right[i] : left[i]));
        view.setInt16(44 + (i * 2 + channel) * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
      }
    }
    return new Uint8Array(bytes);
  }

  async function mixAudio(duration) {
    const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OfflineContext) throw new Error('이 브라우저는 정확한 오디오 내보내기를 지원하지 않습니다. Chrome을 사용해 주세요.');
    const context = new OfflineContext(2, Math.max(1, Math.ceil(duration * 44100)), 44100);
    const cache = new Map();
    let count = 0;
    const decode = url => {
      if (!cache.has(url)) cache.set(url, (async () => {
        const response = await fetch(url, { signal: EXP.frameAbort?.signal });
        if (!response.ok) throw new Error('오디오 원본 파일을 읽지 못했습니다.');
        return context.decodeAudioData(await response.arrayBuffer());
      })());
      return cache.get(url);
    };
    async function add(url, options) {
      cancelled();
      if (!url || options.volume <= 0 || options.end <= options.start) return;
      let buffer;
      try { buffer = await decode(url); }
      catch (error) {
        // A video without an audio track is a valid input. Explicit music/voice is required.
        if (options.optional) return;
        throw new Error('BGM 또는 자막 음성을 읽지 못했습니다: ' + error.message);
      }
      cancelled();
      const start = Math.max(0, options.start), end = Math.min(duration, options.end);
      const offset = Math.min(number(options.offset), buffer.duration);
      if (end <= start || offset >= buffer.duration) return;
      const source = context.createBufferSource(), gain = context.createGain();
      source.buffer = buffer; gain.gain.value = options.volume;
      source.connect(gain); gain.connect(context.destination);
      if (options.loop) {
        source.loop = true; source.loopStart = offset;
        source.loopEnd = Math.min(buffer.duration, options.sourceEnd || buffer.duration);
      }
      const length = source.loop ? end - start : Math.min(end - start, buffer.duration - offset);
      if (options.fadeOut) {
        const fade = Math.min(0.12, length / 2);
        gain.gain.setValueAtTime(options.volume, start + length - fade);
        gain.gain.linearRampToValueAtTime(0, start + length);
      }
      source.start(start, offset, length); count++;
    }
    const mediaClips = getTrackMediaClips();
    for (const clip of S.clips.filter(c => c.type === 'video')) {
      const next = mediaClips[mediaClips.findIndex(c => c.id === clip.id) + 1];
      await add(clip.element?.currentSrc || clip.element?.src || S.media.find(m => m.id === clip.mediaId)?.src, {
        start: clip.startTime, end: clip.startTime + clip.duration, volume: clip.vol ?? 1, optional: true,
        fadeOut: S.autoTransition && next && Math.abs(next.startTime - clip.startTime - clip.duration) <= 0.08,
      });
    }
    for (const item of BGM.items) {
      const offset = getBGMSourceStart(item), sourceEnd = getBGMSourceEnd(item);
      await add(item.url || item.element?.currentSrc || item.element?.src, {
        start: item.start || 0,
        end: item.loop ? getBGMEnd(item) : Math.min(getBGMEnd(item), (item.start || 0) + sourceEnd - offset),
        offset, sourceEnd, loop: item.loop, volume: item.vol,
      });
    }
    for (const sub of S.subs) await add(getSubExportAudioUrl(sub), {
      start: sub.start, end: sub.end, volume: TTS.vol,
    });
    if (!count) return null;
    setExpProg(3, 'BGM·음성을 영상 시간에 맞추는 중...');
    const rendered = await context.startRendering();
    cancelled();
    return wav16(rendered);
  }

  async function exportMp4(fps, bitrate) {
    const savedTime = S.t, oldSuppress = EXP.suppressLiveAudio;
    const originalElements = new Map(), exportVideos = [];
    let ff = null;
    EXP.frameAbort = new AbortController();
    pause();
    EXP.frameAccurate = true; EXP.suppressLiveAudio = true;
    try {
      setExpProg(0, '영상과 오디오 준비 중... 준비 시간은 결과 영상에 포함되지 않습니다.');
      await document.fonts?.ready;
      // Each cut needs its own decoder, including adjacent cuts sharing one source.
      for (const clip of S.clips.filter(c => c.element?.tagName === 'VIDEO')) {
        cancelled();
        const original = clip.element, video = document.createElement('video');
        exportVideos.push(video);
        // Decode only the active cut/transition, rather than holding every 4K cut in memory.
        video.preload = 'none'; video.muted = true; video.playsInline = true;
        video.src = original.currentSrc || original.src;
        originalElements.set(clip, original); clip.element = video;
      }
      const audio = await mixAudio(S.totalDur);
      ff = await createExportFFmpeg(0, 0); // Per-chunk encoder ratios must not jump the overall progress.
      EXP.frameFFmpeg = ff;
      cancelled();
      const frames = Math.ceil(S.totalDur * fps);
      // Bound temporary image memory even for 4K. Encoded segments are much smaller.
      const chunkSize = Math.max(1, Math.min(30, Math.floor(64000000 / (canvas.width * canvas.height))));
      const segments = [];
      document.getElementById('expFmtDsp').textContent = 'MP4 · H.264 + AAC · 프레임 정확도 내보내기';
      for (let start = 0; start < frames; start += chunkSize) {
        const count = Math.min(chunkSize, frames - start);
        const images = [];
        try {
          for (let i = 0; i < count; i++) {
            cancelled();
            await prepareFrame((start + i) / fps);
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.98));
            if (!blob) throw new Error('영상 프레임을 만들지 못했습니다.');
            const name = 'frame' + String(i).padStart(6, '0') + '.jpg';
            ff.FS('writeFile', name, new Uint8Array(await blob.arrayBuffer())); images.push(name);
            if (i % 5 === 0) {
              setExpProg(5 + (start + i + 1) / frames * 81, `영상 저장 중: ${start + i + 1} / ${frames} 프레임`);
              await sleep(0);
            }
          }
          const segment = 'part' + String(segments.length).padStart(6, '0') + '.mp4';
          await ff.run('-framerate', String(fps), '-i', 'frame%06d.jpg', '-frames:v', String(count),
            '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-bf', '0',
            '-b:v', `${Math.floor(bitrate / 1000)}k`, '-pix_fmt', 'yuv420p',
            '-video_track_timescale', String(fps * 1000), segment);
          segments.push(segment);
        } finally {
          images.forEach(name => { try { ff.FS('unlink', name); } catch {} });
        }
        cancelled();
      }
      ff.FS('writeFile', 'parts.txt', new TextEncoder().encode(segments.map(name => `file '${name}'`).join('\n')));
      if (audio) ff.FS('writeFile', 'mix.wav', audio);
      setExpProg(89, '영상과 BGM·음성을 합치는 중...');
      const args = ['-f', 'concat', '-safe', '0', '-i', 'parts.txt'];
      if (audio) args.push('-i', 'mix.wav');
      args.push('-map', '0:v:0');
      if (audio) args.push('-map', '1:a:0', '-c:a', 'aac', '-profile:a', 'aac_low',
        '-b:a', '160k', '-ar', '44100', '-ac', '2');
      else args.push('-an');
      args.push('-c:v', 'copy', '-tag:v', 'avc1', '-t', seconds(S.totalDur),
        '-movflags', '+faststart', 'final.mp4');
      await ff.run(...args);
      cancelled();
      const result = ff.FS('readFile', 'final.mp4');
      const blob = new Blob([result], { type: 'video/mp4' });
      setExpProg(100, '완료! MP4 파일을 저장합니다.');
      downloadBlob(blob, 'video_export_compatible_h264_aac.mp4');
      return blob;
    } finally {
      try { ff?.exit(); } catch {}
      EXP.frameFFmpeg = null; EXP.frameAbort = null;
      exportVideos.forEach(video => { video.pause(); video.removeAttribute('src'); video.load(); });
      originalElements.forEach((original, clip) => { clip.element = original; });
      EXP.frameAccurate = false; EXP.suppressLiveAudio = oldSuppress;
      S.t = savedTime; renderPreview();
    }
  }
  window.exportFrameAccurateMp4 = exportMp4;
  window.FrameAccurateExport = { prepareFrame, seekFrame, mixAudio };
})();

