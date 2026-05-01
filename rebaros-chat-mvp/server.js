const express = require('express');
const multer = require('multer');
const OpenAI = require('openai');
const sharp = require('sharp');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 150000, maxRetries: 2 });

app.use(express.static(__dirname));
app.use(express.json({ limit: '2mb' }));

function selectedModel() {
  const configured = process.env.OPENAI_VISION_MODEL || '';
  if (!configured || configured.includes('mini')) return 'gpt-4o';
  return configured;
}

const CATEGORIES = ['外周布基礎','内部布基礎','土間配筋','人通口補強筋','スリーブ補強'];

const schemaHint = `あなたは日本の鉄筋積算・基礎伏図解剖・鉄筋加工帳作成の専門家です。対象は鉄筋屋の拾いだけです。アンカーボルト、型枠、コンクリート、設備配管は対象外です。

目的:
日本の複雑な基礎伏図を「文字抽出」ではなく「構造分解」し、鉄筋対象を foundation_breakdown として返してください。

解析順序:
1. 図面内の全テキストをスキャンする。径(D10/D13/D16)、ピッチ(@250/@300SC)、箇所数、開口寸法、スリーブ径、断面名、注記を拾う。
2. 右側/下側の断面詳細・仕様欄・凡例をマスター仕様として扱う。
3. 断面詳細の仕様を伏図上の外周/内部/土間/人通口/スリーブにマッピングする。
4. 「〇か所」「600x350」「D10タテヨコ@250」などの文字があれば、不明で逃げず、該当カテゴリの read/spec/quantity_basis に必ず反映する。
5. 加工帳行は、切寸・本数・形状が論理的に確定できる場合だけ生成する。確定できない場合は加工帳に入れず、missing と action に不足項目を明記する。

厳守:
- アンカーボルトは foundation_breakdown に出さない。
- F1/F2などの基礎梁を勝手に作らない。
- 図面に直接ない寸法でも、断面図・伏図・標準ルールから論理的に導けるものは根拠付きで quantity_basis に書く。
- ただし根拠が弱い加工帳行を fabrication_rows に入れない。
- 「情報が不明」だけの回答は禁止。読めた文字・読めた図形・不足情報を分けて書く。
- 3D/半3D表示に使える geometry_hint を必ず返す。
- JSON以外の文章は返さない。

返却JSON形式:
{
  "project_type":"鉄筋工事",
  "page_classification":[{"page":1,"type":"表紙|配置図|平面図|立面図|基礎伏図|断面詳細|基礎仕様|対象外","confidence":0,"reason":""}],
  "spec_master":{"rebar":"SD295A D10-D13","lap":{"D10":450,"D13":550,"D16":650},"cover":60,"stock":6000,"unit_weight":{"D10":0.56,"D13":0.995,"D16":1.56},"notes":[]},
  "scan_findings":{"text_hits":[],"section_refs":[],"dimension_hits":[],"symbol_hits":[]},
  "foundation_breakdown":[
    {
      "category":"外周布基礎|内部布基礎|土間配筋|人通口補強筋|スリーブ補強",
      "page":1,
      "status":"要確認|拾い可能|対象外",
      "confidence":0,
      "read":"図面から読めた文字・図形情報",
      "missing":"加工帳化に不足している情報",
      "spec":"仕様・径・ピッチ・補強内容",
      "quantity_basis":"延長/面積/箇所数などの根拠。論理算出した場合も根拠を書く",
      "action":"延長確認|面積確認|形状確認|箇所確認|加工帳化可能|対象外",
      "geometry_hint":{"kind":"footing_line|slab_mesh|opening_reinforcement|sleeve_reinforcement","count":0,"width":0,"height":0,"dia":"","pitch":0,"visual_note":"半3Dでどう見せるか"},
      "fabrication_rows":[]
    }
  ],
  "fabrication_book_rows":[],
  "warnings":[]
}

最低限、foundation_breakdown には次の5項目を必ず出す:
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
- note に根拠を書く
上記を満たさない場合、fabrication_book_rows は空配列にする。`;

const cropInstructions = `画像は基礎伏図ページの分割クロップです。小さい文字を重点的に読む。D10/D13/D16、@250、@300SC、タテヨコ、人通口、600x350、か所、スリーブ、VU、断面詳細、仕様欄の文字を抽出してJSONで返してください。`;

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

function ensureBreakdown(parsed, page) {
  parsed.foundation_breakdown = Array.isArray(parsed.foundation_breakdown) ? parsed.foundation_breakdown : [];
  CATEGORIES.forEach(category => {
    if (!parsed.foundation_breakdown.some(x => x.category === category)) {
      parsed.foundation_breakdown.push({
        category,
        page,
        status: '要確認',
        confidence: 0,
        read: '',
        missing: '自動抽出できなかったため補完入力が必要',
        spec: '',
        quantity_basis: '',
        action: '補完入力で加工帳化',
        geometry_hint: { kind: category.includes('土間') ? 'slab_mesh' : category.includes('人通口') ? 'opening_reinforcement' : category.includes('スリーブ') ? 'sleeve_reinforcement' : 'footing_line', count: 0, visual_note: '' },
        fabrication_rows: []
      });
    }
  });
}

function mergeFindingsIntoBreakdown(parsed, findings) {
  const text = JSON.stringify(findings || {});
  const hit = (re) => (text.match(re) || []).map(x => x).slice(0, 8).join(' / ');
  const doma = parsed.foundation_breakdown.find(x => x.category === '土間配筋');
  const opening = parsed.foundation_breakdown.find(x => x.category === '人通口補強筋');
  const sleeve = parsed.foundation_breakdown.find(x => x.category === 'スリーブ補強');
  const inner = parsed.foundation_breakdown.find(x => x.category === '内部布基礎');
  const outer = parsed.foundation_breakdown.find(x => x.category === '外周布基礎');
  const d10pitch = hit(/D10\s*(?:タテヨコ)?\s*[@＠]\s*\d{2,4}|D10[@＠]\d{2,4}|D10\s*[@＠]\s*\d{2,4}SC/gi);
  const openingHit = hit(/(?:人通口|600\s*[x×]\s*350|\d+\s*か所|\d+\s*ヶ所)/gi);
  const sleeveHit = hit(/(?:スリーブ|VU\s*150|150\s*φ|φ\s*150)/gi);
  if (doma && d10pitch && (!doma.read || doma.read.length < 12)) { doma.read = d10pitch; doma.spec = d10pitch; doma.action = '面積確認'; }
  if (inner && d10pitch && (!inner.read || inner.read.length < 12)) { inner.read = d10pitch; inner.spec = d10pitch; inner.action = '延長確認'; }
  if (outer && hit(/D13|1-D13|D10|断面|布基礎/gi) && (!outer.read || outer.read.length < 12)) { outer.read = hit(/D13|1-D13|D10|断面|布基礎/gi); outer.action = '延長確認'; }
  if (opening && openingHit && (!opening.read || opening.read.length < 12)) { opening.read = openingHit; opening.spec = openingHit; opening.quantity_basis = openingHit; opening.action = '形状確認'; const m = openingHit.match(/(\d+)\s*[ヶか]所/); if (m) opening.geometry_hint = { kind:'opening_reinforcement', count:+m[1], width:600, height:350, dia:'D13', visual_note:'人通口周囲に補強枠' }; }
  if (sleeve && sleeveHit && (!sleeve.read || sleeve.read.length < 12)) { sleeve.read = sleeveHit; sleeve.spec = sleeveHit; sleeve.action = '箇所確認'; sleeve.geometry_hint = { kind:'sleeve_reinforcement', count:1, width:150, height:150, dia:'D10', visual_note:'スリーブ周囲補強' }; }
}

function sanitize(parsed, page, findings) {
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
  ensureBreakdown(parsed, page);
  mergeFindingsIntoBreakdown(parsed, findings);
  parsed.scan_findings = parsed.scan_findings || findings || {};
  return parsed;
}

async function makeCrops(buffer) {
  const img = sharp(buffer).rotate();
  const meta = await img.metadata();
  const w = meta.width || 0, h = meta.height || 0;
  if (!w || !h) return [];
  const boxes = [
    {name:'full', left:0, top:0, width:w, height:h},
    {name:'right-spec', left:Math.floor(w*0.58), top:0, width:Math.floor(w*0.42), height:h},
    {name:'bottom-detail', left:0, top:Math.floor(h*0.55), width:w, height:Math.floor(h*0.45)},
    {name:'center-plan', left:Math.floor(w*0.12), top:Math.floor(h*0.12), width:Math.floor(w*0.65), height:Math.floor(h*0.68)}
  ];
  const crops = [];
  for (const b of boxes) {
    const buf = await sharp(buffer).rotate().extract({ left:b.left, top:b.top, width:Math.max(1,b.width), height:Math.max(1,b.height) }).resize({ width: 1800, withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
    crops.push({ name:b.name, dataUrl:`data:image/jpeg;base64,${buf.toString('base64')}` });
  }
  return crops;
}

async function cropScan({ model, page, crops }) {
  if (!crops.length) return {};
  const content = [{ type:'text', text:`${cropInstructions}\nPage ${page}. クロップ名ごとに見つけた文字を返す。形式: {"text_hits":[],"dimension_hits":[],"section_refs":[],"symbol_hits":[]}` }];
  crops.forEach(c => { content.push({ type:'text', text:`CROP:${c.name}` }); content.push({ type:'image_url', image_url:{ url:c.dataUrl, detail:'high' } }); });
  const response = await client.chat.completions.create({
    model,
    response_format:{ type:'json_object' },
    messages:[{ role:'user', content }],
    temperature:0,
    max_tokens:2000
  });
  return cleanJson(response.choices?.[0]?.message?.content || '{}');
}

async function callOpenAI({ model, page, dataUrl, findings }) {
  const response = await client.chat.completions.create({
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: schemaHint },
      { role: 'user', content: [
        { type: 'text', text: `PDFのPage ${page}です。以下のCrop&Scan結果も必ず反映して、鉄筋屋対象のみの基礎伏図専用 foundation_breakdown を作成してください。アンカーボルトは除外。\nCrop&Scan結果: ${JSON.stringify(findings || {})}` },
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
    let findings = {};
    try {
      const crops = await makeCrops(req.file.buffer);
      findings = await cropScan({ model, page, crops });
    } catch (cropErr) {
      findings = { warnings:[`crop scan failed: ${cropErr.message || String(cropErr)}`] };
    }
    const text = await callOpenAI({ model, page, dataUrl, findings });
    const parsed = sanitize(cleanJson(text), page, findings);
    parsed._debug = { model, page, imageBytes: req.file.size, apiKey: apiKeyInfo(), cropScan: !!findings };
    res.json(parsed);
  } catch (err) {
    const status = err.status || err.code || 500;
    const msg = err.message || String(err);
    console.error('[analyze-page error]', { status, msg, stack: err.stack });
    res.status(500).json({ error: msg, status, apiKey: apiKeyInfo(), hint: 'Check OPENAI_API_KEY, billing/credits, model access, and Render logs.' });
  }
});

app.get('/health', (_, res) => res.json({ ok: true, mode: 'hyper-foundation-crop-scan', model: selectedModel(), apiKey: apiKeyInfo() }));

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
