const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const root = __dirname;
const port = Number(process.env.PORT || 3210);

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg',
  '.aac': 'audio/aac',
  '.mp2': 'audio/mpeg',
  '.pcm': 'audio/L16',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.3gp': 'video/3gpp',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.avi': 'video/x-msvideo',
  '.vob': 'video/dvd',
  '.wmv': 'video/x-ms-wmv',
  '.asf': 'video/x-ms-asf',
  '.mkv': 'video/x-matroska',
  '.flv': 'video/x-flv',
  '.webm': 'video/webm',
  '.mxf': 'application/mxf',
  '.av1': 'video/av1',
};

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 1024 * 64) {
        reject(new Error('요청이 너무 큽니다.'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function guid() {
  return crypto.randomUUID().replace(/-/g, '');
}

function xmlEscape(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function payloadFromWsMessage(data) {
  const bytes = new Uint8Array(data);
  for (let i = 0; i < bytes.length - 3; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
      const header = new TextDecoder().decode(bytes.slice(0, i));
      if (!/Path:audio/i.test(header)) return null;
      return Buffer.from(bytes.slice(i + 4));
    }
  }
  return null;
}

function synthesizeEdgeTts({ text, voice, rate, pitch }) {
  const token = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
  const requestId = guid();
  const connectionId = guid();
  const selectedVoice = isEdgeVoice(voice) ? voice : 'ko-KR-SunHiNeural';
  const ratePct = Math.round((Math.max(0.5, Math.min(2, Number(rate) || 1)) - 1) * 100);
  const pitchPct = Math.round((Math.max(0.5, Math.min(2, Number(pitch) || 1)) - 1) * 50);
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ko-KR"><voice name="${selectedVoice}"><prosody rate="${ratePct >= 0 ? '+' : ''}${ratePct}%" pitch="${pitchPct >= 0 ? '+' : ''}${pitchPct}%">${xmlEscape(text)}</prosody></voice></speak>`;
  const config = {
    context: {
      synthesis: {
        audio: {
          metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
          outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
        },
      },
    },
  };
  const endpoint = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${token}&ConnectionId=${connectionId}`;

  return new Promise((resolve, reject) => {
    const chunks = [];
    let finished = false;
    const ws = new WebSocket(endpoint);
    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { ws.close(); } catch (e) {}
      reject(new Error('Edge TTS timeout'));
    }, 30000);
    const fail = err => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      try { ws.close(); } catch (e) {}
      reject(err instanceof Error ? err : new Error(String(err || 'Edge TTS failed')));
    };
    ws.addEventListener('open', () => {
      const now = new Date().toISOString();
      ws.send(`X-Timestamp:${now}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${JSON.stringify(config)}`);
      ws.send(`X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${now}\r\nPath:ssml\r\n\r\n${ssml}`);
    });
    ws.addEventListener('error', () => fail(new Error('Edge TTS connection failed')));
    ws.addEventListener('message', async event => {
      let data = event.data;
      if (typeof data === 'string') {
        if (/Path:turn\.end/i.test(data)) {
          if (!chunks.length) return fail(new Error('Edge TTS returned no audio'));
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          try { ws.close(); } catch (e) {}
          resolve(Buffer.concat(chunks));
        }
        return;
      }
      if (data instanceof Blob) data = await data.arrayBuffer();
      const payload = payloadFromWsMessage(data);
      if (payload?.length) chunks.push(payload);
    });
  });
}

function isEdgeVoice(voice) {
  return /^ko-KR-(SunHi|InJoon|Hyunsu|JiMin|SeoHyeon|SoonBok|YuJin|BongJin|GookMin)Neural$/.test(String(voice || ''));
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `PowerShell exited with ${code}`));
    });
  });
}

function runPowerShellJson(script) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(stderr.trim() || `PowerShell exited with ${code}`));
      try {
        const parsed = JSON.parse(stdout || '[]');
        resolve(Array.isArray(parsed) ? parsed : [parsed]);
      } catch (e) {
        reject(e);
      }
    });
  });
}

function getWindowsVoices() {
  return runPowerShellJson(`
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.GetInstalledVoices() | ForEach-Object {
  $i = $_.VoiceInfo
  [pscustomobject]@{ Name=$i.Name; Culture=$i.Culture.Name; Gender=$i.Gender.ToString(); Age=$i.Age.ToString() }
} | ConvertTo-Json -Compress
$s.Dispose()
`);
}

async function synthesizeWindowsTts({ text, voice, rate }) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'video-editor-tts-'));
  const textPath = path.join(dir, 'input.txt');
  const wavPath = path.join(dir, 'speech.wav');
  await fs.promises.writeFile(textPath, text, 'utf8');
  const sapiRate = Math.max(-10, Math.min(10, Math.round(((Number(rate) || 1) - 1) * 6)));
  const selectedVoice = String(voice || 'Microsoft Heami Desktop').replace(/'/g, "''");
  const script = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice = '${selectedVoice}'
try { $s.SelectVoice($voice) } catch { $s.SelectVoice('Microsoft Heami Desktop') }
$s.Rate = ${sapiRate}
$s.Volume = 100
$s.SetOutputToWaveFile(${JSON.stringify(wavPath)})
$s.Speak([System.IO.File]::ReadAllText(${JSON.stringify(textPath)}, [System.Text.Encoding]::UTF8))
$s.Dispose()
`;
  try {
    await runPowerShell(script);
    return await fs.promises.readFile(wavPath);
  } finally {
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function synthesizeGoogleTts({ text, voice, rate, pitch, apiKey }) {
  const key = String(apiKey || process.env.GOOGLE_TTS_API_KEY || '').trim();
  if (!key) throw new Error('Google Cloud TTS API 키가 필요합니다.');
  const voiceName = String(voice || '').replace(/^google:/, '');
  if (!/^ko-KR-(Neural2|Wavenet|Standard)-[A-D]$/.test(voiceName)) {
    throw new Error('지원하지 않는 Google 한국어 음성입니다.');
  }
  const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: 'ko-KR', name: voiceName },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: Math.max(0.25, Math.min(4, Number(rate) || 1)),
        pitch: Math.max(-20, Math.min(20, ((Number(pitch) || 1) - 1) * 10)),
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Google TTS HTTP ${res.status}`);
  if (!data.audioContent) throw new Error('Google TTS 오디오가 생성되지 않았습니다.');
  return Buffer.from(data.audioContent, 'base64');
}

async function handleBasicTts(req, res) {
  try {
    const body = JSON.parse(await readBody(req) || '{}');
    const text = String(body.text || '').trim();
    if (!text) return send(res, 400, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify({ error: 'text required' }));

    const voice = body.voice || 'Microsoft Heami Desktop';
    const isGoogle = String(voice).startsWith('google:');
    const isEdge = isEdgeVoice(voice);
    const audio = isGoogle
      ? await synthesizeGoogleTts({
          text: text.slice(0, 4500),
          voice,
          rate: body.rate,
          pitch: body.pitch,
          apiKey: body.googleApiKey,
        })
      : isEdge
      ? await synthesizeEdgeTts({
          text: text.slice(0, 4500),
          voice,
          rate: body.rate,
          pitch: body.pitch,
        })
      : await synthesizeWindowsTts({
          text: text.slice(0, 900),
          voice,
          rate: body.rate,
        });
    send(res, 200, {
      'Content-Type': isGoogle || isEdge ? 'audio/mpeg' : 'audio/wav',
      'Content-Length': audio.length,
      'X-TTS-Voice': voice,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    }, audio);
  } catch (e) {
    send(res, 500, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify({ error: e.message }));
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    return send(res, 204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }, '');
  }
  if (req.url === '/api/voices' && req.method === 'GET') {
    try {
      const voices = await getWindowsVoices();
      return send(res, 200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      }, JSON.stringify({ voices }));
    } catch (e) {
      return send(res, 500, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify({ error: e.message }));
    }
  }
  if (req.url === '/api/basic-tts' && req.method === 'POST') return handleBasicTts(req, res);

  const reqPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
  const file = path.resolve(root, rel);
  if (!file.startsWith(root)) return send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
    send(res, 200, { 'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream' }, data);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`video editor running at http://127.0.0.1:${port}/`);
});
