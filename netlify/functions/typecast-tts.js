exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: corsHeaders(),
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const apiKey = String(process.env.TYPECAST_API_KEY || '').trim();
  if (!apiKey) {
    return json(500, { error: 'TYPECAST_API_KEY is not configured on Netlify.' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (error) {
    return json(400, { error: 'Invalid JSON body.' });
  }

  if (!payload.voice_id || !payload.text) {
    return json(400, { error: 'voice_id and text are required.' });
  }

  try {
    const upstream = await fetch('https://api.typecast.ai/v1/text-to-speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': apiKey
      },
      body: JSON.stringify(payload)
    });

    if (!upstream.ok) {
      const body = await upstream.text();
      return json(upstream.status, { error: body || `Typecast HTTP ${upstream.status}` });
    }

    const audio = Buffer.from(await upstream.arrayBuffer());
    return {
      statusCode: 200,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store'
      },
      isBase64Encoded: true,
      body: audio.toString('base64')
    };
  } catch (error) {
    return json(500, { error: error.message || 'Typecast request failed.' });
  }
};

function json(statusCode, data) {
  return {
    statusCode,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(data)
  };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}
