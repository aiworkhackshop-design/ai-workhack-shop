const express = require('express');
const multer = require('multer');
const OpenAI = require('openai');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 90000, maxRetries: 2 });

app.use(express.static(__dirname));
app.use(express.json({ limit: '2mb' }));

const schemaHint = `あなたは日本の鉄筋拾い出し・加工帳作成の専門家です。PDF図面から、仕様書、基礎伏図、基礎リスト、断面詳細、土間、壁、梁を分類し、拾い候補を作ってください。必ずJSONのみで返してください。
{
  "project_type":"鉄筋工事",
  "page_classification":[{"page":1,"type":"表紙|仕様書|基礎伏図|基礎リスト|断面詳細|土間|壁|梁|対象外","confidence":0,"reason":""}],
  "spec_master":{"lap":{"D10":450,"D13":550,"D16":650},"cover":60,"stock":6000,"notes":[]},
  "takeoff_candidates":[
    {"type":"土間|基礎梁|壁|柱|スラブ|任意","page":1,"name":"","dia":"D10","pitch":200,"x":0,"y":0,"length":0,"qty":0,"main":"","stirrup":"","confidence":0,"reason":"","needs_human_check":true}
  ],
  "warnings":[]
}
ルール: 意匠図や表紙から無理に拾わない。寸法と配筋がない候補は出さない。仕様書があれば仕様を優先。D10継手450、D13継手550、D16継手650を初期値にする。`;

function cleanJson(text) {
  const raw = String(text || '{}').trim();
  try { return JSON.parse(raw); } catch (_) {}
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  return { page_classification: [], takeoff_candidates: [], warnings: ['AI JSON parse failed'], raw };
}

function apiKeyInfo() {
  const key = process.env.OPENAI_API_KEY || '';
  return { exists: !!key, prefix: key ? key.slice(0, 7) : null, length: key.length };
}

async function callOpenAIWithSdk({ model, page, dataUrl }) {
  const response = await client.chat.completions.create({
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: schemaHint },
      { role: 'user', content: [
        { type: 'text', text: `PDFのPage ${page}です。ページ分類と鉄筋拾い候補だけをJSONで返してください。` },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } }
      ]}
    ],
    temperature: 0.1,
    max_tokens: 1800
  });
  return response.choices?.[0]?.message?.content || '{}';
}

async function callOpenAIWithFetch({ model, page, dataUrl }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 1800,
        messages: [
          { role: 'system', content: schemaHint },
          { role: 'user', content: [
            { type: 'text', text: `PDFのPage ${page}です。ページ分類と鉄筋拾い候補だけをJSONで返してください。` },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } }
          ]}
        ]
      })
    });
    const json = await response.json().catch(async () => ({ error: { message: await response.text() } }));
    if (!response.ok) {
      const msg = json?.error?.message || `OpenAI HTTP ${response.status}`;
      const e = new Error(msg);
      e.status = response.status;
      e.openai = json;
      throw e;
    }
    return json.choices?.[0]?.message?.content || '{}';
  } finally {
    clearTimeout(timeout);
  }
}

app.post('/api/analyze-page', upload.single('image'), async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY is not set on Render.', apiKey: apiKeyInfo() });
    if (!req.file) return res.status(400).json({ error: 'image is required' });
    const page = req.body.page || 'unknown';
    const model = process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini';
    const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    let text;
    try {
      text = await callOpenAIWithSdk({ model, page, dataUrl });
    } catch (sdkErr) {
      console.error('[sdk analyze-page error]', { status: sdkErr.status || sdkErr.code || 500, msg: sdkErr.message });
      text = await callOpenAIWithFetch({ model, page, dataUrl });
    }
    const parsed = cleanJson(text);
    parsed._debug = { model, page, imageBytes: req.file.size, apiKey: apiKeyInfo() };
    res.json(parsed);
  } catch (err) {
    const status = err.status || err.code || 500;
    const msg = err.message || String(err);
    console.error('[analyze-page error]', { status, msg, stack: err.stack, openai: err.openai });
    res.status(500).json({ error: msg, status, openai: err.openai || null, apiKey: apiKeyInfo(), hint: 'Check OPENAI_API_KEY, OPENAI_VISION_MODEL, billing/credits, model access, and Render outbound network.' });
  }
});

app.get('/health', (_, res) => res.json({ ok: true, mode: 'vision', model: process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini', apiKey: apiKeyInfo() }));

app.get('/api/check-openai', async (_, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ ok: false, error: 'OPENAI_API_KEY is not set', apiKey: apiKeyInfo() });
    const model = process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini';
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Reply with JSON: {"ok":true}' }],
      response_format: { type: 'json_object' },
      max_tokens: 20
    });
    res.json({ ok: true, model, apiKey: apiKeyInfo(), response: cleanJson(response.choices?.[0]?.message?.content || '{}') });
  } catch (err) {
    console.error('[check-openai error]', { status: err.status || err.code || 500, msg: err.message, stack: err.stack });
    res.status(500).json({ ok: false, error: err.message || String(err), status: err.status || err.code || 500, apiKey: apiKeyInfo() });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`RebarOS Vision server running on ${port}`));
