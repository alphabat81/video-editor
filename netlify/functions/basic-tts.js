exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  try {
    const body = JSON.parse(event.body || '{}');
    const text = String(body.text || '').trim();
    const lang = String(body.lang || 'ko').replace(/[^a-z-]/gi, '') || 'ko';
    if (!text) {
      return { statusCode: 400, body: JSON.stringify({ error: 'text required' }) };
    }
    const url = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl='
      + encodeURIComponent(lang)
      + '&q='
      + encodeURIComponent(text.slice(0, 450));
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://translate.google.com/',
      },
    });
    if (!upstream.ok) throw new Error('Google TTS HTTP ' + upstream.status);
    const audio = Buffer.from(await upstream.arrayBuffer());
    return {
      statusCode: 200,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'audio/mpeg',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
      body: audio.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: e.message }),
    };
  }
};
