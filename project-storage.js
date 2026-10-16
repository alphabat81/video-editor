/* Portable editing projects: JSON manifest followed by original binary assets. */
(() => {
  'use strict';
  const MAGIC = 'VEPROJ01';
  const OMIT = new Set(['element', 'audioEl', 'src', 'url', 'audioUrl', 'file']);
  const project = { name: '내 편집 프로젝트', busy: false };
  const copy = value => JSON.parse(JSON.stringify(value, (key, v) =>
    OMIT.has(key) || typeof v === 'function' ? undefined : v));
  const status = message => {
    document.getElementById('editableProjectStatus').textContent = message;
  };
  const safeName = name => (String(name || '내 편집 프로젝트')
    .replace(/\.veproj$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120) || '프로젝트');

  function settingsSnapshot() {
    return {
      width: canvas.width, height: canvas.height, padding: AI_PADDING,
      aiEdits: { ...AI_EDITS }, t: S.t, pxSec: S.pxSec,
      autoTransition: S.autoTransition, transitionDur: S.transitionDur,
      quality: document.getElementById('expBitrate').value,
      fps: document.getElementById('expFpsOpt').value,
      tts: { on: TTS.on, provider: TTS.provider, rate: TTS.rate,
        pitch: TTS.pitch, vol: TTS.vol, voiceIdx: TTS.voiceIdx },
      ws: { voice: WS_TTS.voice },
      el: { voiceId: EL.voiceId, modelId: EL.modelId },
      tc: { voiceId: TC.voiceId, model: TC.model, emotion: TC.emotion, tempo: TC.tempo },
    };
  }

  async function buildProjectBlob(name) {
    // Take a click-time snapshot before reading any binary assets asynchronously.
    const media = S.media.map(item => ({ data: copy(item), source: item.src || item.element?.src }));
    const clips = S.clips.map(item => ({ data: copy(item), source: item.element?.src }));
    const subs = S.subs.map(item => ({ data: copy(item), source: item.audioUrl }));
    const bgm = BGM.items.map(item => ({ data: copy(item), source: item.url || item.element?.src }));
    const caches = [WS_TTS, EL, TC].map(provider => [...provider.cache.entries()]);
    const manifest = {
      format: 'video-editor-project', version: 1, name: safeName(name),
      savedAt: new Date().toISOString(), settings: settingsSnapshot(),
      thumbnailMediaId: S.thumbnailMediaId, bgmActiveId: BGM.activeId,
      bgmDefaults: { vol: BGM.vol, loop: BGM.loop },
      srtFiles: copy(SRT_FILES).map(group => ({ ...group,
        subIds: group.subIds.filter(id => subs.some(item => item.data.id === id)) })),
      assets: [], media: [], clips: [], subs: [], bgm: [], caches: [],
    };
    const blobs = [], bySource = new Map();
    async function addAsset(source) {
      if (!source) return null;
      if (bySource.has(source)) return bySource.get(source);
      const response = await fetch(source);
      if (!response.ok) throw new Error('원본 미디어를 읽지 못했습니다. 파일을 다시 연결한 후 저장해 주세요.');
      const blob = await response.blob();
      if (!blob.size) throw new Error('비어 있는 미디어 파일은 저장할 수 없습니다.');
      const index = blobs.length;
      blobs.push(blob);
      manifest.assets.push({ size: blob.size, type: blob.type || 'application/octet-stream' });
      bySource.set(source, index);
      status(`원본 파일 포함 중… ${blobs.length}개`);
      return index;
    }
    for (const item of media) {
      item.data.asset = await addAsset(item.source);
      if (item.data.asset === null) throw new Error(`원본 파일이 없습니다: ${item.data.name}`);
      manifest.media.push(item.data);
    }
    for (const item of clips) {
      if (item.source) item.data.asset = await addAsset(item.source);
      manifest.clips.push(item.data);
    }
    for (const item of subs) {
      if (item.source) item.data.audioAsset = await addAsset(item.source);
      manifest.subs.push(item.data);
    }
    for (const item of bgm) {
      item.data.asset = await addAsset(item.source);
      if (item.data.asset === null) throw new Error(`BGM 원본이 없습니다: ${item.data.name}`);
      manifest.bgm.push(item.data);
    }
    for (const entries of caches) {
      const saved = [];
      for (const [key, source] of entries) saved.push([key, await addAsset(source)]);
      manifest.caches.push(saved);
    }
    const json = new TextEncoder().encode(JSON.stringify(manifest));
    const header = new Uint8Array(12);
    header.set(new TextEncoder().encode(MAGIC));
    new DataView(header.buffer).setUint32(8, json.byteLength, true);
    return new Blob([header, json, ...blobs], { type: 'application/octet-stream' });
  }

  async function readProjectBlob(file) {
    const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (header.length !== 12 || new TextDecoder().decode(header.slice(0, 8)) !== MAGIC)
      throw new Error('편집 프로젝트(.veproj) 파일을 선택해 주세요. MP4는 미디어 불러오기를 이용하세요.');
    const length = new DataView(header.buffer).getUint32(8, true);
    if (!length || length > 64 * 1024 * 1024 || 12 + length > file.size)
      throw new Error('프로젝트 정보가 손상되었거나 지원 범위를 초과했습니다.');
    const data = JSON.parse(await file.slice(12, 12 + length).text());
    if (data.format !== 'video-editor-project' || data.version !== 1)
      throw new Error('지원하지 않는 프로젝트 버전입니다.');
    for (const key of ['assets', 'media', 'clips', 'subs', 'bgm', 'srtFiles', 'caches']) {
      if (!Array.isArray(data[key])) throw new Error('프로젝트 구성 정보가 올바르지 않습니다.');
    }
    const validNumber = v => typeof v === 'number' && Number.isFinite(v);
    if (!data.settings || !validNumber(data.settings.width) || !validNumber(data.settings.height) ||
        data.settings.width < 64 || data.settings.width > 4096 ||
        data.settings.height < 64 || data.settings.height > 4096)
      throw new Error('프로젝트 해상도가 올바르지 않습니다.');
    const blobs = [];
    let offset = 12 + length;
    for (const asset of data.assets) {
      if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || offset + asset.size > file.size)
        throw new Error('프로젝트의 원본 파일이 누락되었거나 손상되었습니다.');
      blobs.push(file.slice(offset, offset + asset.size, String(asset.type || 'application/octet-stream')));
      offset += asset.size;
    }
    if (offset !== file.size) throw new Error('프로젝트 파일 길이가 올바르지 않습니다.');
    const validAsset = id => Number.isInteger(id) && id >= 0 && id < blobs.length;
    const ids = new Set();
    for (const item of data.media) {
      if (!['video', 'image'].includes(item.type) || !validAsset(item.asset) ||
          !Number.isSafeInteger(item.id) || ids.has(item.id)) throw new Error('미디어 정보가 올바르지 않습니다.');
      ids.add(item.id);
    }
    const clipIds = new Set();
    for (const clip of data.clips) {
      if (!['video', 'image', 'text', 'subtitle', 'effect', 'sticker'].includes(clip.type) ||
          !validNumber(clip.startTime) || clip.startTime < 0 || !validNumber(clip.duration) || clip.duration <= 0 ||
          !Number.isSafeInteger(clip.id) || clipIds.has(clip.id) ||
          (clip.asset != null && !validAsset(clip.asset)) ||
          (['video', 'image'].includes(clip.type) && !validAsset(clip.asset) && !ids.has(clip.mediaId)))
        throw new Error('영상 컷 정보가 올바르지 않습니다.');
      clipIds.add(clip.id);
    }
    for (const sub of data.subs) {
      if (!validNumber(sub.start) || !validNumber(sub.end) || sub.start < 0 || sub.end < sub.start ||
          typeof sub.text !== 'string' || !Number.isSafeInteger(sub.id) ||
          (sub.audioAsset != null && !validAsset(sub.audioAsset))) throw new Error('자막 정보가 올바르지 않습니다.');
    }
    const subIds = new Set(data.subs.map(sub => sub.id));
    for (const group of data.srtFiles) {
      if (!group || typeof group.name !== 'string' || !Array.isArray(group.subIds) ||
          group.subIds.some(id => !subIds.has(id))) throw new Error('자막 파일 목록이 올바르지 않습니다.');
    }
    for (const item of data.bgm) {
      if (!validAsset(item.asset) || !validNumber(item.start) || item.start < 0 ||
          !validNumber(item.end) || item.end <= item.start || !validNumber(item.vol) || item.vol < 0 || item.vol > 1)
        throw new Error('BGM 정보가 올바르지 않습니다.');
    }
    if (data.caches.length !== 3) throw new Error('음성 설정 정보가 올바르지 않습니다.');
    for (const entries of data.caches) {
      if (!Array.isArray(entries) || entries.some(entry => !Array.isArray(entry) ||
        typeof entry[0] !== 'string' || !validAsset(entry[1]))) throw new Error('자막 음성 정보가 올바르지 않습니다.');
    }
    return { data, blobs };
  }

  function loadElement(kind, url) {
    return new Promise((resolve, reject) => {
      const el = kind === 'image' ? new Image() : document.createElement(kind === 'video' ? 'video' : 'audio');
      const event = kind === 'image' ? 'load' : 'loadeddata';
      const timer = setTimeout(() => finish(new Error('미디어 읽기 시간이 초과되었습니다.')), 60000);
      const finish = error => {
        clearTimeout(timer);
        el.removeEventListener(event, ready); el.removeEventListener('error', failed);
        error ? reject(error) : resolve(el);
      };
      const ready = () => finish();
      const failed = () => finish(new Error('프로젝트의 미디어를 재생할 수 없습니다.'));
      el.addEventListener(event, ready); el.addEventListener('error', failed);
      if (kind !== 'image') { el.preload = 'auto'; el.playsInline = true; }
      el.src = url;
      if (kind !== 'image') el.load();
    });
  }

  async function restoreProject(prepared) {
    const { data, blobs } = prepared;
    const urls = blobs.map(blob => URL.createObjectURL(blob));
    // Audio owners get separate URLs so deleting BGM cannot revoke subtitle audio.
    const ownedAudioUrl = asset => {
      const url = URL.createObjectURL(blobs[asset]); urls.push(url); return url;
    };
    let media, clips, bgm;
    // Decode everything first: a bad project never clears the current editing session.
    try {
      media = [];
      for (const item of data.media) {
        const element = await loadElement(item.type, urls[item.asset]);
        let thumbnail = item.type === 'image' ? urls[item.asset] : item.thumbnail;
        if (item.type === 'video' && (!thumbnail || !thumbnail.startsWith('data:image/'))) {
          const thumb = document.createElement('canvas'); thumb.width = 120; thumb.height = 68;
          thumb.getContext('2d').drawImage(element, 0, 0, 120, 68);
          thumbnail = thumb.toDataURL();
        }
        media.push({ ...copy(item), src: urls[item.asset], element, thumbnail });
      }
      clips = [];
      for (const item of data.clips) {
        const source = media.find(m => m.id === item.mediaId);
        const clip = copy(item);
        if (source) { clip.element = source.element; clip.thumbnail = source.thumbnail; }
        else if (item.asset != null) clip.element = await loadElement(item.type, urls[item.asset]);
        clips.push(clip);
      }
      bgm = [];
      for (const item of data.bgm) {
        const url = ownedAudioUrl(item.asset);
        const element = await loadElement('audio', url);
        element.volume = item.vol;
        bgm.push({ ...copy(item), url, element });
      }
    } catch (error) {
      urls.forEach(url => URL.revokeObjectURL(url));
      throw error;
    }
    pause();
    S.media.forEach(item => item.element?.pause?.());
    BGM.items.forEach(item => item.element?.pause());
    SUB_AUDIO.el?.pause(); SUB_AUDIO.el = null; SUB_AUDIO.curSubId = null;
    [WS_TTS, EL, TC].forEach(provider => { provider.currentAudio?.pause(); provider.curSubId = null; });
    window.speechSynthesis?.cancel(); TTS.curSubId = null;
    S.media = media; S.clips = clips;
    S.subs = data.subs.map(item => ({ ...copy(item),
      ...(item.audioAsset != null ? { audioUrl: ownedAudioUrl(item.audioAsset) } : {}) }));
    S.thumbnailMediaId = data.thumbnailMediaId ?? null;
    S.nid = Math.max(0, ...[...media, ...clips, ...data.subs, ...bgm].map(item => Number(item.id) || 0)) + 1;
    S.selId = null; S.selIds.clear(); S.selMediaIds.clear();
    BGM.items = bgm; BGM.activeId = data.bgmActiveId ?? bgm[0]?.id ?? null;
    BGM.vol = data.bgmDefaults?.vol ?? 0.5; BGM.loop = data.bgmDefaults?.loop !== false;
    [WS_TTS, EL, TC].forEach((provider, i) => {
      provider.cache.clear();
      (data.caches[i] || []).forEach(([key, asset]) => provider.cache.set(key, ownedAudioUrl(asset)));
    });
    const cfg = data.settings;
    Object.keys(AI_EDITS).forEach(key => { AI_EDITS[key] = !!cfg.aiEdits?.[key]; });
    document.querySelectorAll('[onclick^="toggleAIEdit"]').forEach(row => {
      const key = row.getAttribute('onclick').match(/'([^']+)'/)?.[1];
      row.classList.toggle('on', !!AI_EDITS[key]);
      row.querySelector('.ai-toggle')?.classList.toggle('on', !!AI_EDITS[key]);
    });
    const padding = Math.max(0, Math.min(3, Number(cfg.padding) || 0));
    setPadding(padding, document.getElementById('padBtn' + padding));
    S.autoTransition = cfg.autoTransition !== false;
    S.transitionDur = Math.max(0.15, Math.min(1.2, Number(cfg.transitionDur) || 0.45));
    updateAutoTransitionUI();
    for (const [target, source, keys] of [
      [TTS, cfg.tts, ['on', 'provider', 'rate', 'pitch', 'vol', 'voiceIdx']],
      [WS_TTS, cfg.ws, ['voice']], [EL, cfg.el, ['voiceId', 'modelId']],
      [TC, cfg.tc, ['voiceId', 'model', 'emotion', 'tempo']],
    ]) keys.forEach(key => { if (source?.[key] != null) target[key] = source[key]; });
    document.getElementById('ttsToggleBtn').textContent = TTS.on ? '🔊' : '🔇';
    setTTSProvider(TTS.provider);
    for (const [id, value] of [['ttsRate', TTS.rate], ['ttsPitch', TTS.pitch], ['ttsVol', TTS.vol],
      ['ttsVoiceSel', TTS.voiceIdx], ['wsExportVoiceSel', WS_TTS.voice], ['elVoiceSel', EL.voiceId],
      ['elModelSel', EL.modelId], ['tcModelSel', TC.model], ['tcEmotionSel', TC.emotion]]) {
      const el = document.getElementById(id); if (el) el.value = value;
    }
    for (const key of ['rate', 'pitch', 'vol']) {
      const slider = document.querySelector(`input[oninput^="TTS.${key}="]`);
      if (slider) slider.value = TTS[key];
      const label = document.getElementById('tts' + key[0].toUpperCase() + key.slice(1) + 'Val');
      if (label) label.textContent = Number(TTS[key]).toFixed(key === 'vol' ? 2 : 1);
    }
    SRT_FILES.splice(0, SRT_FILES.length, ...copy(data.srtFiles));
    const grouped = new Set(SRT_FILES.flatMap(file => file.subIds));
    const ungrouped = S.subs.filter(sub => !grouped.has(sub.id));
    if (ungrouped.length) SRT_FILES.push({ name: '프로젝트 자막', subIds: ungrouped.map(sub => sub.id) });
    const list = document.getElementById('srtList'); list.replaceChildren();
    SRT_FILES.forEach((file, index) => {
      const row = document.createElement('div'); row.className = 'srt-item';
      const label = document.createElement('span');
      label.textContent = `📄 ${file.name} (${file.subIds.length}개)`; label.style.flex = '1';
      const button = document.createElement('button'); button.className = 'srt-edit-btn';
      button.textContent = '✏️ 편집'; button.onclick = () => openSRTEditor(index);
      row.append(label, button); list.append(row);
    });
    closeSRTEditor(); srtEditFileIdx = -1;
    EXPORT_CACHE.file = null; EXPORT_CACHE.projectSnapshot = null;
    EXPORT_CACHE.exportName = ''; EXPORT_CACHE.importedName = '';
    ['reimportExportBtn', 'importRecentBtn'].forEach(id => { document.getElementById(id).style.display = 'none'; });
    document.getElementById('bgmInfo').style.display = bgm.length ? '' : 'none';
    syncBGMInputs(); if (typeof syncBGMSourceInputs === 'function') syncBGMSourceInputs();
    setProjectResolution(cfg.width, cfg.height);
    if (cfg.quality) syncProjectQualityFromExport(cfg.quality);
    if (cfg.fps) document.getElementById('expFpsOpt').value = cfg.fps;
    S.t = Math.max(0, Number(cfg.t) || 0); recalcDuration();
    setZoom(Math.max(20, Math.min(500, Number(cfg.pxSec) || 100)));
    renderMediaGrid(); renderTimeline(); renderBGMTrack();
    applyAIVolumeEdits(); seekTo(S.t);
    media.filter(item => item.type === 'video').forEach(item => {
      item.element.addEventListener('seeked', () => { if (!S.playing) renderPreview(); });
    });
    HISTORY.states.length = 0; HISTORY.cur = -1; saveState();
    const focus = clips.find(clip => clip.type === 'text' || clip.type === 'subtitle') || clips[0];
    if (focus) {
      selectClip(focus.id);
      const detail = document.querySelector(`.ptab[onclick*="'detail'"]`);
      if (detail) switchPTab('detail', detail);
    }
    project.name = safeName(data.name);
    document.getElementById('editableProjectName').value = project.name;
    document.getElementById('projectImportStatus').textContent = '편집 프로젝트 복원 완료. 타임라인의 기존 텍스트·자막·BGM을 선택해 수정하세요.';
    return data;
  }

  async function runBusy(task) {
    if (project.busy) return;
    if (EXP.recorder?.state === 'recording' || document.getElementById('exportModal')?.classList.contains('show')) {
      showToast('영상 내보내기 창을 닫은 뒤 프로젝트를 저장하거나 불러와 주세요.'); return;
    }
    project.busy = true;
    document.querySelectorAll('[data-project-action]').forEach(button => { button.disabled = true; });
    try { await task(); }
    catch (error) { status('실패: ' + error.message); showToast(error.message, 'error', 6000); }
    finally {
      project.busy = false;
      document.querySelectorAll('[data-project-action]').forEach(button => { button.disabled = false; });
    }
  }

  window.saveEditingProject = () => runBusy(async () => {
    status('프로젝트 저장 준비 중…');
    project.name = safeName(document.getElementById('editableProjectName').value);
    const blob = await buildProjectBlob(project.name);
    // Do not use downloadBlob(): that helper registers its result as an exported video.
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = project.name + '.veproj';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    status(`저장 파일 생성 완료: ${link.download} (${(blob.size / 1048576).toFixed(1)} MB). 브라우저 다운로드에서 확인하세요.`);
    showToast('편집 프로젝트 다운로드를 시작했습니다. 원본 미디어와 편집 레이어가 함께 저장됩니다.', 'success', 4500);
  });
  window.openEditingProject = () => {
    if (!project.busy) document.getElementById('editableProjectInput').click();
  };
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.veproj'; input.hidden = true; input.id = 'editableProjectInput';
  input.onchange = () => {
    const file = input.files[0]; input.value = ''; if (!file) return;
    runBusy(async () => {
      status('프로젝트 파일 확인 중…');
      const prepared = await readProjectBlob(file);
      if ((S.clips.length || S.media.length || BGM.items.length || S.subs.length) &&
          !window.confirm('현재 작업을 불러올 프로젝트로 바꿉니다. 저장하지 않은 편집은 사라집니다. 계속할까요?')) {
        status('불러오기를 취소했습니다. 현재 편집은 유지됩니다.'); return;
      }
      status('원본 미디어와 편집 레이어를 복원하는 중…');
      await restoreProject(prepared);
      status(`불러오기 완료: ${project.name}. 기존 자막·텍스트·BGM을 직접 수정할 수 있습니다.`);
      showToast('편집 프로젝트를 불러왔습니다.', 'success');
    });
  };
  document.body.append(input);
  const panel = document.createElement('section');
  panel.style.cssText = 'padding:10px;margin-bottom:12px;background:#182b38;border:1px solid #38627d;border-radius:7px';
  panel.innerHTML = `<div style="font-size:12px;font-weight:700;margin-bottom:7px">💾 편집 프로젝트 중간저장</div>
    <input id="editableProjectName" class="prop-inp" aria-label="프로젝트 이름" value="내 편집 프로젝트" style="width:100%;box-sizing:border-box;margin-bottom:7px">
    <button class="srt-upload-btn" data-project-action onclick="saveEditingProject()">💾 프로젝트 저장 (.veproj)</button>
    <button class="srt-upload-btn" data-project-action onclick="openEditingProject()" style="margin-top:6px">📂 프로젝트 불러오기</button>
    <div id="editableProjectStatus" role="status" style="margin-top:8px;font-size:11px;line-height:1.5;color:#b9d6e8">원본 영상·이미지·자막·BGM·효과를 한 파일에 저장합니다. 브라우저를 닫거나 PC를 재부팅한 뒤에도 편집을 이어갈 수 있습니다. 완성 MP4를 편집본으로 변환하는 기능은 아닙니다.</div>`;
  document.getElementById('tabImport').prepend(panel);
  const toolbar = document.querySelector('.toolbar');
  for (const [label, action, title] of [
    ['💾 프로젝트 저장', window.saveEditingProject, '편집 프로젝트 저장 (Ctrl+S)'],
    ['📂 프로젝트 열기', window.openEditingProject, '편집 프로젝트 불러오기 (Ctrl+O)'],
  ]) {
    const button = document.createElement('button'); button.className = 'tool-btn';
    button.dataset.projectAction = ''; button.textContent = label; button.title = title; button.onclick = action;
    toolbar.insertBefore(button, toolbar.lastElementChild);
  }
  document.addEventListener('keydown', event => {
    const key = event.code === 'KeyS' ? 's' : event.code === 'KeyO' ? 'o' : event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.altKey && ['s', 'o'].includes(key)) {
      event.preventDefault();
      key === 's' ? window.saveEditingProject() : window.openEditingProject();
    }
  });
  window.EditableProject = { build: buildProjectBlob, read: readProjectBlob, restore: restoreProject };
})();

