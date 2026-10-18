const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(path.resolve(path.dirname(process.execPath), '../node_modules/playwright')); }
const folder = path.resolve(__dirname, '../../outputs/export-frame-check');
const ffmpeg = (args, options = {}) => run('ffmpeg', ['-y', '-hide_banner', ...args], { maxBuffer: 32 * 1024 * 1024, ...options });

(async () => {
  await fs.mkdir(folder, { recursive: true });
  const source = path.join(folder, 'source.mp4'), music = path.join(folder, 'music.wav');
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=330:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2',
    '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[a]', '-map', '[a]', music]);
  const browser = await playwright.chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://**/*', route => process.env.VIDEO_EDITOR_WASM === '1' &&
      new URL(route.request().url()).hostname === 'unpkg.com' ? route.continue() : route.abort());
    await page.goto(process.env.VIDEO_EDITOR_TEST_URL || 'http://127.0.0.1:3210/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.exportFrameAccurateMp4);
    await page.exposeFunction('__encodeNative', async (args, files) => {
      for (const [name, bytes] of files) {
        assert.equal(path.basename(name), name);
        await fs.writeFile(path.join(folder, name), Buffer.from(bytes));
      }
      await ffmpeg(['-loglevel', 'error', ...args], { cwd: folder });
      return [...await fs.readFile(path.join(folder, args.at(-1)))];
    });
    await page.evaluate(useWasm => {
      // Exercise the real browser seek/render/mix implementation, with native FFmpeg
      // replacing only the WASM filesystem/CLI for an offline, reproducible test.
      if (!useWasm) window.createExportFFmpeg = async () => {
        const files = new Map();
        return { FS(op, name, value) {
          if (op === 'writeFile') files.set(name, value);
          if (op === 'unlink') files.delete(name);
          if (op === 'readFile') return files.get(name);
        }, async run(...args) {
          const bytes = await window.__encodeNative(args, [...files].map(([name, data]) => [name, [...data]]));
          files.set(args.at(-1), Uint8Array.from(bytes));
        }, exit() {} };
      };
      window.MediaRecorder = class { constructor() { throw new Error('Real-time recorder must not be used'); } };
      window.downloadBlob = blob => { window.__exported = blob; };
      TTS.provider = 'webspeech'; S.autoTransition = false;
      setProjectResolution(320, 180); document.getElementById('expBitrate').value = '1500000';
    }, process.env.VIDEO_EDITOR_WASM === '1');
    await page.setInputFiles('#projectImportInput', source);
    await page.waitForFunction(() => S.clips.some(c => c.type === 'video'));
    await page.evaluate(() => {
      const clip = S.clips.find(c => c.type === 'video'); clip.duration = 2.5; clip.vol = 0;
      window.__originalVideo = clip.element; recalcDuration(); seekTo(0.6);
    });
    async function exportFile(name) {
      await page.evaluate(async () => {
        window.__exported = null; exportVideo(); await startExport();
        if (!window.__exported) throw new Error(document.getElementById('toastContainer').textContent || 'No export');
      });
      const bytes = await page.evaluate(async () => [...new Uint8Array(await window.__exported.arrayBuffer())]);
      const file = path.join(folder, name); await fs.writeFile(file, Buffer.from(bytes)); return file;
    }
    const without = await exportFile('without-bgm.mp4');
    await page.setInputFiles('#bgmInput', music);
    await page.waitForFunction(() => BGM.items[0]?.duration > 0);
    await page.evaluate(() => {
      Object.assign(BGM.items[0], { start: 0, end: 2.5, sourceStart: 1.2, sourceEnd: 1.8, loop: true, vol: 0.7 });
      const originalDecode = OfflineAudioContext.prototype.decodeAudioData;
      OfflineAudioContext.prototype.decodeAudioData = async function(...args) {
        await new Promise(resolve => setTimeout(resolve, 1300));
        return originalDecode.apply(this, args);
      };
    });
    const withBgm = await exportFile('with-bgm.mp4');
    async function hashes(file) {
      const { stdout } = await ffmpeg(['-loglevel', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-']);
      return stdout.split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1).trim());
    }
    const a = await hashes(without), b = await hashes(withBgm);
    assert.equal(a.length, 75); assert.deepEqual(b, a, 'Slow BGM preparation must not change video frames');
    assert.equal(new Set(b.slice(0, 60)).size, 60, 'First two seconds must contain 60 distinct moving frames');
    const metadata = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', withBgm])).stdout);
    assert.equal(metadata.streams.find(s => s.codec_type === 'video').codec_name, 'h264');
    const audio = metadata.streams.find(s => s.codec_type === 'audio');
    assert.equal(audio.codec_name, 'aac'); assert.equal(audio.profile, 'LC');
    assert.equal(audio.channels, 2); assert.equal(audio.sample_rate, '44100');
    assert(Math.abs(Number(metadata.format.duration) - 2.5) < 0.05);
    const { stdout: pcm } = await ffmpeg(['-loglevel', 'error', '-i', withBgm, '-t', '0.5', '-vn',
      '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], { encoding: 'buffer' });
    let crossings = 0, last = 0;
    for (let offset = 0; offset < pcm.length; offset += 4) {
      const sample = pcm.readFloatLE(offset); if (last <= 0 && sample > 0) crossings++; last = sample;
    }
    assert(Math.abs(crossings / 0.5 - 880) < 20, 'Selected BGM source offset must start immediately at 880 Hz');
    assert.deepEqual(await page.evaluate(() => [S.t, S.playing, EXP.frameAccurate,
      S.clips[0].element === window.__originalVideo]), [0.6, false, false, true]);
    assert(await page.evaluate(async () => {
      const items = BGM.items, vol = S.clips[0].vol;
      try {
        BGM.items = []; S.clips[0].vol = 0.5;
        const audio = await FrameAccurateExport.mixAudio(2.5);
        if (!audio || audio.byteLength !== 44 + 2.5 * 44100 * 4) return false;
        const view = new DataView(audio.buffer); let peak = 0;
        for (let i = 44; i < audio.length; i += 4) peak = Math.max(peak, Math.abs(view.getInt16(i, true)));
        return peak > 100;
      } finally { BGM.items = items; S.clips[0].vol = vol; }
    }), 'Original MP4 audio must be included even without BGM');
    // Required audio decode failure must not silently produce a broken export.
    assert(await page.evaluate(async () => {
      const old = BGM.items[0].url; BGM.items[0].url = URL.createObjectURL(new Blob(['broken audio']));
      window.__exported = null;
      try { await exportFrameAccurateMp4(30, 1500000); return false; }
      catch { return !window.__exported && !EXP.frameAccurate && S.clips[0].element === window.__originalVideo; }
      finally { URL.revokeObjectURL(BGM.items[0].url); BGM.items[0].url = old; }
    }));
    assert(await page.evaluate(async () => {
      window.__exported = null;
      const pending = exportFrameAccurateMp4(30, 1500000);
      setTimeout(cancelExport, 150);
      try { await pending; return false; }
      catch { return !window.__exported && !EXP.frameAccurate && S.clips[0].element === window.__originalVideo; }
      finally { EXP.cancelled = false; }
    }));
    await page.evaluate(() => {
      S.clips.push({ ...S.clips[0], id: S.nid++, startTime: 2.5, duration: 1 });
      S.autoTransition = true; recalcDuration();
    });
    const shared = await exportFile('shared-source-transition.mp4');
    assert.equal((await hashes(shared)).length, 105, 'Shared-source cuts and transitions must not lose frames');
    assert(await page.evaluate(() => S.clips[0].element === S.clips[1].element &&
      S.clips[0].element === window.__originalVideo), 'Export-only decoders must be released');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'PASS', encoder: process.env.VIDEO_EDITOR_WASM === '1' ? 'browser WASM' : 'native test adapter',
      frames: a.length, initialUniqueFrames: new Set(b.slice(0, 60)).size,
      bgmPreparationDelayMs: 1300, selectedBgmFrequency: crossings / 0.5, duration: metadata.format.duration,
      checks: ['identical video with/without BGM', 'no frozen introduction', 'BGM offset/loop',
        'H.264/AAC LC stereo 44100', 'original MP4 audio', 'shared-source cuts/transition',
        'timeline restoration', 'decode error/cancel cleanup'] }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

