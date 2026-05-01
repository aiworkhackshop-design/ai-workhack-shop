const express = require('express');
const multer = require('multer');
const OpenAI = require('openai');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 90000, maxRetries: 2 });

app.use(express.static(__dirname));
app.use(express.json({ limit: '2mb' }));

const schemaHint = `あなたは日本の鉄筋拾い出し・鉄筋加工帳作成の専門家です。鉄之助・加工帳之助の実務イメージで、図面ページを読み、ページ分類、拾い候補、鉄筋加工帳行をJSONだけで返してください。

必ず次のJSON形式で返してください。
{
  "project_type":"鉄筋工事",
  "page_classification":[
    {"page":1,"type":"表紙|仕様書|基礎伏図|基礎リスト|断面詳細|土間|壁|柱|梁|スラブ|対象外","confidence":0,"reason":""}
  ],
  "spec_master":{
    "lap":{"D10":450,"D13":550,"D16":650,"D19":800,"D22":900,"D25":1000},
    "cover":60,
    "stock":6000,
    "unit_weight":{"D10":0.56,"D13":0.995,"D16":1.56,"D19":2.25,"D22":3.04,"D25":3.98},
    "notes":[]
  },
  "takeoff_candidates":[
    {
      "type":"基礎梁|土間|壁|柱|スラブ|任意",
      "page":1,
      "member":"基礎梁",
      "mark":"F1",
      "location":"X1-X3/Y2",
      "dia":"D13",
      "main":"4-D13",
      "stirrup":"D10@200",
      "pitch":200,
      "length":0,
      "qty":0,
      "shape":"直筋|フック|スターラップ|L型|コ型",
      "confidence":0,
      "reason":"",
      "needs_human_check":true,
      "fabrication_rows":[
        {
          "mark":"F1",
          "member":"基礎梁",
          "floor":"1F",
          "location":"X1-X3/Y2",
          "dia":"D13",
          "material":"SD295",
          "shape":"直筋",
          "a":0,
          "b":0,
          "c":0,
          "d":0,
          "cut":0,
          "qty":0,
          "places":1,
          "total_qty":0,
          "stock":6000,
          "unit_weight":0.995,
          "process":"切断|曲げ|スターラップ",
          "note":"根拠を書く"
        }
      ]
    }
  ],
  "fabrication_book_rows":[
    {
      "mark":"F1",
      "member":"基礎梁",
      "floor":"1F",
      "location":"X1-X3/Y2",
      "dia":"D13",
      "material":"SD295",
      "shape":"直筋",
      "a":0,
      "b":0,
      "c":0,
      "d":0,
      "cut":0,
      "qty":0,
      "places":1,
      "total_qty":0,
      "stock":6000,
      "unit_weight":0.995,
      "process":"切断",
      "note":""
    }
  ],
  "warnings":[]
}

重要ルール:
- 表紙・意匠図・建具表・設備図から無理に拾わない。
- 寸法・径・本数・ピッチが足りない場合は、confidenceを低くし、needs_human_check=trueにする。
- 加工帳行は必ず mark/member/location/dia/shape/cut/qty/total_qty/unit_weight を埋める。分からない値は0または空欄にし、noteに不足理由を書く。
- D10継手450、D13継手550、D16継手650を初期仕様として扱う。
- 切寸が定尺6000を超える場合は、継手を考慮した分割が必要とnoteに書く。
- JSON以外の文章は返さない。`;

function cleanJson(text) {
  const raw = String(text || '{}').trim();
  try { return JSON.parse(raw); } catch (_) {}
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  return { page_classification: [], takeoff_candidates: [], fabrication_book_rows: [], warnings: ['AI JSON parse failed'], raw };
}

function apiKeyInfo() {
  const key = process.env.OPENAI_API_KEY || '';
  return { exists: !!key, prefix: key ? key.slice(0, 7) : null, length: key.length };
}

async function callOpenAI({ model, page, dataUrl }) {
  const response = await client.chat.completions.create({
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: schemaHint },
      { role: 'user', content: [
        { type: 'text', text: `PDFのPage ${page}です。ページ分類、拾い候補、鉄筋加工帳行をJSONで返してください。` },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } }
      ]}
    ],
    temperature: 0.1,
    max_tokens: 3000
  });
  return response.choices?.[0]?.message?.content || '{}';
}

app.post('/api/analyze-page', upload.single('image'), async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY is not set on Render.', apiKey: apiKeyInfo() });
    if (!req.file) return res.status(400).json({ error: 'image is required' });
    const page = req.body.page || 'unknown';
    const model = process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini';
    const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const text = await callOpenAI({ model, page, dataUrl });
    const parsed = cleanJson(text);
    parsed._debug = { model, page, imageBytes: req.file.size, apiKey: apiKeyInfo() };
    res.json(parsed);
  } catch (err) {
    const status = err.status || err.code || 500;
    const msg = err.message || String(err);
    console.error('[analyze-page error]', { status, msg, stack: err.stack });
    res.status(500).json({ error: msg, status, apiKey: apiKeyInfo(), hint: 'Check OPENAI_API_KEY, billing/credits, model access, and Render logs.' });
  }
});

app.get('/health', (_, res) => res.json({ ok: true, mode: 'vision-fabrication-book', model: process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini', apiKey: apiKeyInfo() }));

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
    res.status(500).json({ ok: false, error: err.message || String(err), status: err.status || err.code || 500, apiKey: apiKeyInfo() });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`RebarOS Vision server running on ${port}`));
