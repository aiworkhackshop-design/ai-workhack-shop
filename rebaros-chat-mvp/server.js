const express = require('express');
const multer = require('multer');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

app.post('/api/analyze-page', upload.single('image'), async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY is not set on Render.' });
    if (!req.file) return res.status(400).json({ error: 'image is required' });
    const page = req.body.page || 'unknown';
    const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const response = await client.chat.completions.create({
      model: process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: schemaHint },
        { role: 'user', content: [
          { type: 'text', text: `これはPDFのPage ${page}です。このページを分類し、鉄筋拾い候補があれば作ってください。` },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }
        ]}
      ],
      temperature: 0.1,
      max_tokens: 2500
    });
    const text = response.choices[0].message.content || '{}';
    res.json(JSON.parse(text));
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`RebarOS Vision server running on ${port}`));
