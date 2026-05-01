const express = require('express');
const multer = require('multer');
const OpenAI = require('openai');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 120000, maxRetries: 2 });

app.use(express.static(__dirname));
app.use(express.json({ limit: '2mb' }));

function selectedModel() {
  const configured = process.env.OPENAI_VISION_MODEL || '';
  if (!configured || configured.includes('mini')) return 'gpt-4o';
  return configured;
}

const schemaHint = `あなたは日本の鉄筋拾い出し・基礎伏図の専門家です。図面ページを読み、いきなり加工帳を作らず、まず基礎伏図専用の「拾い分解表」をJSONだけで返してください。

最重要ルール:
- F1/F2などの基礎梁を勝手に作らない。
- 表紙/配置図/平面図/立面図/意匠図から鉄筋を拾わない。
- 基礎伏図・布基礎断面詳細・基礎仕様・人通口補強・土間配筋だけを対象にする。
- 図面右側の仕様欄、断面詳細、凡例、基礎伏図内の注記を優先して読む。
- 読めた文字は必ず read/spec にそのまま要約して入れる。「情報が不明」だけで逃げない。
- ただし確定できない寸法を加工帳に入れない。
- 切寸・本数・形状が確定したものだけ fabrication_book_rows に入れる。
- 不明なものは foundation_breakdown の status を「要確認」にする。
- JSON以外の文章は返さない。

返却JSON形式:
{
  "project_type":"鉄筋工事",
  "page_classification":[
    {"page":1,"type":"表紙|配置図|平面図|立面図|基礎伏図|断面詳細|基礎仕様|対象外","confidence":0,"reason":""}
  ],
  "spec_master":{
    "rebar":"SD295A D10-D13",
    "lap":{"D10":450,"D13":550,"D16":650},
    "cover":60,
    "stock":6000,
    "unit_weight":{"D10":0.56,"D13":0.995,"D16":1.56},
    "notes":[]
  },
  "foundation_breakdown":[
    {
      "category":"外周布基礎|内部布基礎|土間配筋|人通口補強筋|スリーブ補強|アンカーボルト",
      "page":1,
      "status":"拾い可能|要確認|対象外",
      "confidence":0,
      "read":"図面から読めた情報。D10@250、D10@300SC、人通口600x350 6か所等を読めたら必ず書く",
      "missing":"不足している情報",
      "spec":"仕様・径・ピッチ・補強内容",
      "quantity_basis":"延長/面積/箇所数などの根拠",
      "action":"加工帳化可能|延長確認|面積確認|箇所確認|対象外",
      "fabrication_rows":[]
    }
  ],
  "fabrication_book_rows":[],
  "warnings":[]
}

今回のような基礎伏図では、最低限次の6項目を foundation_breakdown に必ず出す:
1. 外周布基礎
2. 内部布基礎
3. 土間配筋
4. 人通口補強筋
5. スリーブ補強
6. アンカーボルト

加工帳行を返してよい条件:
- cut > 0
- qty > 0
- dia が D10/D13/D16 のいずれか
- member が空欄でない
- shape が空欄でない
上記を満たさない場合、fabrication_book_rows は空配列にしてください。`;

function cleanJson(text) {
  const raw = String(text || '{}').trim();
  try { return JSON.parse(raw); } catch (_) {}
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  return { page_classification: [], foundation_breakdown: [], fabrication_book_rows: [], warnings: ['AI JSON parse failed'], raw };
}

function apiKeyInfo() {
  const key = process.env.OPENAI_API_KEY || '';
  return { exists: !!key, prefix: key ? key.slice(0, 7) : null, length: key.length };
}

function isValidFabRow(r) {
  const dia = String(r?.dia || '').toUpperCase();
  const diaOk = ['D10','D13','D16'].includes(dia);
  return diaOk && Number(r?.cut) > 0 && Number(r?.qty) > 0 && String(r?.member || '').trim() && String(r?.shape || '').trim();
}

function sanitize(parsed) {
  parsed.page_classification = Array.isArray(parsed.page_classification) ? parsed.page_classification : [];
  parsed.foundation_breakdown = Array.isArray(parsed.foundation_breakdown) ? parsed.foundation_breakdown : [];
  parsed.fabrication_book_rows = Array.isArray(parsed.fabrication_book_rows) ? parsed.fabrication_book_rows.filter(isValidFabRow) : [];
  parsed.foundation_breakdown = parsed.foundation_breakdown.map(x => ({
    ...x,
    fabrication_rows: Array.isArray(x.fabrication_rows) ? x.fabrication_rows.filter(isValidFabRow) : []
  }));
  return parsed;
}

async function callOpenAI({ model, page, dataUrl }) {
  const response = await client.chat.completions.create({
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: schemaHint },
      { role: 'user', content: [
        { type: 'text', text: `PDFのPage ${page}です。基礎伏図専用の拾い分解表 foundation_breakdown を作ってください。図面右側の仕様欄と断面詳細を重点的に読んでください。確定できないものは要確認で止めてください。` },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }
      ]}
    ],
    temperature: 0,
    max_tokens: 4000
  });
  return response.choices?.[0]?.message?.content || '{}';
}

app.post('/api/analyze-page', upload.single('image'), async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY is not set on Render.', apiKey: apiKeyInfo() });
    if (!req.file) return res.status(400).json({ error: 'image is required' });
    const page = req.body.page || 'unknown';
    const model = selectedModel();
    const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const text = await callOpenAI({ model, page, dataUrl });
    const parsed = sanitize(cleanJson(text));
    parsed._debug = { model, page, imageBytes: req.file.size, apiKey: apiKeyInfo() };
    res.json(parsed);
  } catch (err) {
    const status = err.status || err.code || 500;
    const msg = err.message || String(err);
    console.error('[analyze-page error]', { status, msg, stack: err.stack });
    res.status(500).json({ error: msg, status, apiKey: apiKeyInfo(), hint: 'Check OPENAI_API_KEY, billing/credits, model access, and Render logs.' });
  }
});

app.get('/health', (_, res) => res.json({ ok: true, mode: 'foundation-breakdown-hires', model: selectedModel(), apiKey: apiKeyInfo() }));

app.get('/api/check-openai', async (_, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ ok: false, error: 'OPENAI_API_KEY is not set', apiKey: apiKeyInfo() });
    const model = selectedModel();
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
