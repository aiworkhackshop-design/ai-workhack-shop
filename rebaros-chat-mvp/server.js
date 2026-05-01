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

const schemaHint = `あなたは日本の鉄筋拾い出し・基礎伏図の専門家です。対象は鉄筋屋の拾いだけです。アンカーボルト、型枠、コンクリート、設備配管は鉄筋加工帳の対象外として扱ってください。

目的:
図面ページから「文字」だけでなく、基礎の構造を想像できるように、鉄筋対象を構造オブジェクト化してJSONだけで返してください。

最重要ルール:
- アンカーボルトは鉄筋屋の加工帳対象外。foundation_breakdownにも出さない。
- F1/F2などの基礎梁を勝手に作らない。
- 表紙/配置図/平面図/立面図/意匠図から鉄筋を拾わない。
- 対象は、外周布基礎、内部布基礎、土間配筋、人通口補強筋、スリーブ補強の5項目。
- 図面右側の仕様欄、断面詳細、凡例、基礎伏図内の注記を優先して読む。
- 読めた文字は必ず read/spec にそのまま要約して入れる。「情報が不明」だけで逃げない。
- 3D/半3D表示に使える geometry_hint を必ず返す。
- 確定できない寸法を加工帳に入れない。
- 切寸・本数・形状が確定したものだけ fabrication_rows / fabrication_book_rows に入れる。
- fabrication_rows が空の場合、status は必ず「要確認」にする。「拾い可能」にしない。
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
      "category":"外周布基礎|内部布基礎|土間配筋|人通口補強筋|スリーブ補強",
      "page":1,
      "status":"要確認|拾い可能|対象外",
      "confidence":0,
      "read":"図面から読めた情報。D10@250、D10@300SC、人通口600x350 6か所等を読めたら必ず書く",
      "missing":"加工帳化に不足している情報。例: 延長未確定、面積未確定、補強筋形状未確定",
      "spec":"仕様・径・ピッチ・補強内容",
      "quantity_basis":"延長/面積/箇所数などの根拠",
      "action":"延長確認|面積確認|形状確認|箇所確認|加工帳化可能|対象外",
      "geometry_hint":{"kind":"footing_line|slab_mesh|opening_reinforcement|sleeve_reinforcement","count":0,"width":0,"height":0,"dia":"","pitch":0,"visual_note":"半3Dでどう見せるか"},
      "fabrication_rows":[]
    }
  ],
  "fabrication_book_rows":[],
  "warnings":[]
}

最低限、次の5項目を foundation_breakdown に必ず出す:
1. 外周布基礎
2. 内部布基礎
3. 土間配筋
4. 人通口補強筋
5. スリーブ補強

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
  parsed.foundation_breakdown = parsed.foundation_breakdown
    .filter(x => !String(x.category || '').includes('アンカー'))
    .map(x => {
      const validRows = Array.isArray(x.fabrication_rows) ? x.fabrication_rows.filter(isValidFabRow) : [];
      const hasRows = validRows.length > 0;
      const next = {
        ...x,
        geometry_hint: x.geometry_hint || { kind: 'footing_line', count: 0, visual_note: '' },
        fabrication_rows: validRows
      };
      if (!hasRows && next.status === '拾い可能') {
        next.status = '要確認';
        next.action = next.action && next.action !== '加工帳化可能' ? next.action : '加工帳化には切寸・本数・形状の確定が必要';
        next.missing = next.missing || '切寸・本数・形状が未確定のため加工帳未反映';
      }
      return next;
    });
  return parsed;
}

async function callOpenAI({ model, page, dataUrl }) {
  const response = await client.chat.completions.create({
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: schemaHint },
      { role: 'user', content: [
        { type: 'text', text: `PDFのPage ${page}です。鉄筋屋対象のみで、基礎伏図専用の拾い分解表 foundation_breakdown を作ってください。アンカーボルトは除外。fabrication_rows が作れないものは必ず status=要確認 にしてください。` },
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

app.get('/health', (_, res) => res.json({ ok: true, mode: 'foundation-3d-breakdown-no-anchor-strict-book', model: selectedModel(), apiKey: apiKeyInfo() }));

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
