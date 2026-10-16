const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.resolve(path.dirname(process.execPath), '../node_modules/playwright')); }
const { chromium } = playwright;

(async () => {
  const errors = [];
  const folder = path.resolve(__dirname, '../../outputs/project-storage-check');
  await fs.mkdir(folder, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true, downloadsPath: folder,
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--run-all-compositor-stages-before-draw'] });
  async function fresh() {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://**/*', route => route.abort());
    await page.goto(process.env.VIDEO_EDITOR_TEST_URL || 'http://127.0.0.1:3210/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.EditableProject);
    // This sandbox's Chrome cancels all disk downloads (including baseline .txt).
    // Capture the actual UI-generated download Blob and write it through Node instead.
    await page.evaluate(() => {
      const create = URL.createObjectURL.bind(URL), blobs = new Map();
      URL.createObjectURL = blob => { const url = create(blob); blobs.set(url, blob); return url; };
      document.addEventListener('click', event => {
        const link = event.target.closest('a[download]');
        if (link?.download.endsWith('.veproj')) {
          event.preventDefault(); window.__savedProjectBlob = blobs.get(link.href);
        }
      }, true);
    });
    return { context, page };
  }
  async function persistDownload(page, destination) {
    await page.waitForFunction(() => !!window.__savedProjectBlob).catch(async error => {
      console.log('Save status:', await page.locator('#editableProjectStatus').textContent(), errors);
      throw error;
    });
    const dataUrl = await page.evaluate(() => new Promise(resolve => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(window.__savedProjectBlob); window.__savedProjectBlob = null;
    }));
    await fs.writeFile(destination, Buffer.from(dataUrl.split(',')[1], 'base64'));
  }
  try {
    let { context, page } = await fresh();
    await page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 160; c.height = 90;
      const cx = c.getContext('2d'); cx.fillStyle = 'royalblue'; cx.fillRect(0, 0, 160, 90);
      const png = await new Promise(resolve => c.toBlob(resolve));
      addImgMedia(new File([png], '원본.png', { type: 'image/png' }), { autoAddToTimeline: true });
      const rate = 8000, samples = rate * 4;
      const bytes = new ArrayBuffer(44 + samples * 2), view = new DataView(bytes);
      const str = (off, text) => [...text].forEach((ch, i) => view.setUint8(off + i, ch.charCodeAt(0)));
      str(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
      view.setUint16(32, 2, true); view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, samples * 2, true);
      for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.sin(i * 2 * Math.PI * 440 / rate) * 4000, true);
      loadBGM(new File([bytes], '음악.wav', { type: 'audio/wav' }));
      loadSRT(new File(['1\n00:00:00,000 --> 00:00:02,000\n기존 자막\n'], '원본 자막.srt'));
      addTextClip(TEXT_PRESETS[0]);
      S.clips.find(c => c.type === 'text').text = '기존 텍스트';
    });
    await page.setInputFiles('#projectImportInput', process.env.VIDEO_EDITOR_TEST_VIDEO || path.join(folder, 'fixture.mp4'));
    await page.waitForFunction(() => S.media.length === 2 && S.clips.some(c => c.type === 'video') &&
      S.subs.length === 1 && BGM.items[0]?.duration > 0).catch(async error => {
        console.log(await page.evaluate(() => ({ media: S.media.map(m => [m.type, m.duration]),
          clips: S.clips.map(c => [c.type, c.duration]), subs: S.subs.length,
          bgm: BGM.items.map(b => [b.duration, b.element.error?.message]),
          toasts: document.getElementById('toastContainer').textContent })), errors); throw error;
      });
    await page.evaluate(() => {
      const bgm = BGM.items[0]; bgm.sourceStart = 1; bgm.sourceEnd = 3; bgm.start = 0.25; bgm.end = 2.25; bgm.vol = 0.32;
      S.subs[0].audioUrl = bgm.url; S.subs[0].audioName = '첨부 음성.wav';
      WS_TTS.cache.set(wsCacheKey(S.subs[0].text), bgm.url);
      S.clips.find(c => c.type === 'video').vol = 0.2;
      S.clips.push({ id: S.nid++, type: 'effect', effectId: EFFECT_PRESETS[0].id,
        targetClipId: S.clips.find(c => c.type === 'video').id, track: 3, startTime: 3, duration: 0.5, name: '컷별 효과' });
      setProjectResolution(1920, 1080); setPadding(2, document.getElementById('padBtn2'));
      S.autoTransition = false; S.transitionDur = 0.65;
      renderTimeline(); renderPreview();
      document.getElementById('editableProjectName').value = '중간저장 검증';
      SRT_FILES[0].subIds.push(99999); // Deleting a subtitle can leave a stale group reference.
    });
    const firstFile = path.join(folder, 'first.veproj');
    await page.getByRole('button', { name: '💾 프로젝트 저장', exact: true }).click();
    await persistDownload(page, firstFile);
    const original = await page.evaluate(() => ({ ids: S.clips.map(c => c.id), count: S.clips.length }));
    await context.close();

    ({ context, page } = await fresh());
    await page.setInputFiles('#editableProjectInput', firstFile);
    await page.waitForFunction(() => document.getElementById('editableProjectStatus').textContent.startsWith('불러오기 완료'), null, { timeout: 30000 });
    const restored = await page.evaluate(() => ({
      ids: S.clips.map(c => c.id), count: S.clips.length, text: S.clips.find(c => c.type === 'text').text,
      subtitle: S.subs[0].text, width: canvas.width, height: canvas.height, padding: AI_PADDING,
      bgm: { start: BGM.items[0].sourceStart, end: BGM.items[0].sourceEnd, vol: BGM.items[0].vol },
      video: S.clips.find(c => c.type === 'video').element.readyState,
      voice: !!S.subs[0].audioUrl, cache: WS_TTS.cache.size, groups: SRT_FILES.length,
      autoTransition: S.autoTransition, transitionDur: S.transitionDur,
      noOldBlob: S.media.every(m => m.src.startsWith('blob:')),
    }));
    assert.deepEqual(restored.ids, original.ids); assert.equal(restored.count, original.count);
    assert.equal(restored.text, '기존 텍스트'); assert.equal(restored.subtitle, '기존 자막');
    assert.deepEqual([restored.width, restored.height, restored.padding], [1920, 1080, 2]);
    assert.deepEqual(restored.bgm, { start: 1, end: 3, vol: 0.32 });
    assert(restored.video >= 2 && restored.voice && restored.cache === 1 && restored.groups === 1);
    assert.equal(restored.autoTransition, false); assert.equal(restored.transitionDur, 0.65);
    assert.equal(await page.evaluate(() => S.clips.find(c => c.type === 'effect').targetClipId),
      await page.evaluate(() => S.clips.find(c => c.type === 'video').id));
    // Edit original layers using the existing editor controls, then save again.
    await page.evaluate(() => selectClip(S.clips.find(c => c.type === 'text').id));
    await page.locator('#tcText').fill('수정된 기존 텍스트');
    await page.evaluate(() => openSRTEditor(0));
    await page.locator('.sub-text-inp').fill('수정된 기존 자막');
    await page.evaluate(() => { closeSRTEditor(); setBGMVol(55); setBGMSourceStart(1.5); });
    const secondFile = path.join(folder, 'second.veproj');
    await page.getByRole('button', { name: '💾 프로젝트 저장', exact: true }).click();
    await persistDownload(page, secondFile);
    await context.close();
    ({ context, page } = await fresh());
    await page.setInputFiles('#editableProjectInput', secondFile);
    await page.waitForFunction(() => document.getElementById('editableProjectStatus').textContent.startsWith('불러오기 완료'));
    assert.deepEqual(await page.evaluate(() => [S.clips.find(c => c.type === 'text').text,
      S.subs[0].text, BGM.items[0].vol, BGM.items[0].sourceStart, S.clips.length]),
    ['수정된 기존 텍스트', '수정된 기존 자막', 0.55, 1.5, original.count]);
    const corruption = await page.evaluate(async () => {
      const blob = await EditableProject.build('검증');
      try { await EditableProject.read(blob.slice(0, blob.size - 1)); return false; }
      catch { return S.subs[0].text === '수정된 기존 자막'; }
    });
    assert(corruption, 'Truncated project must be rejected without losing current edits');
    assert(await page.evaluate(async () => {
      const prepared = await EditableProject.read(await EditableProject.build('검증'));
      prepared.blobs[0] = new Blob(['broken image'], { type: 'image/png' });
      try { await EditableProject.restore(prepared); return false; }
      catch { return S.subs[0].text === '수정된 기존 자막'; }
    }), 'Undecodable media must not clear existing editing state');
    await page.evaluate(async () => {
      const voice = S.subs[0].audioUrl;
      removeBGM();
      if (!(await fetch(voice)).ok) throw new Error('Deleting BGM revoked subtitle voice');
      const audioBlob = await (await fetch(voice)).blob();
      loadBGM(new File([audioBlob], '교체한 음악.wav', { type: audioBlob.type }));
    });
    await page.waitForFunction(() => BGM.items[0]?.name === '교체한 음악.wav' && BGM.items[0]?.duration > 0);
    // Cancel replacement with an existing project; no edits should disappear.
    page.once('dialog', dialog => dialog.dismiss());
    await page.setInputFiles('#editableProjectInput', firstFile);
    await page.waitForFunction(() => document.getElementById('editableProjectStatus').textContent.startsWith('불러오기를 취소'));
    assert.equal(await page.evaluate(() => S.subs[0].text), '수정된 기존 자막');
    await page.getByRole('button', { name: '📂 불러오기', exact: true }).click();
    await page.screenshot({ path: path.join(folder, 'restored-editor.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'PASS', checks: ['portable assets across fresh sessions', 'existing text/subtitle/BGM edits',
      'resave and reopen', 'resolution/padding/transitions/effect associations', 'subtitle attached voice and TTS cache',
      'corrupt file preservation', 'cancel replacement preservation', 'no browser JS errors'], restored }, null, 2));
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

