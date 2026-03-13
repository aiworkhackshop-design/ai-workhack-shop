/**
 * Instagram自動投稿ジョブ
 * postsテーブルから未投稿(posted=false)商品を取得してInstagramカルーセル投稿する
 *
 * フロー:
 *   postsテーブルから未投稿取得
 *   → Pythonスクリプトでカルーセル画像生成
 *   → S3にアップロード
 *   → Instagram Graph APIでカルーセル投稿
 *   → posted=true, instagramPostId, postedAtを更新
 *
 * ============================================================
 * 【世界最高レベル購買心理設計 v3】
 * キャプション設計思想:
 *   AIDA フレームワーク
 *     A (Attention)  → 最初の1行で強烈なフック（問い・数字・FOMO）
 *     I (Interest)   → 2-3行で「なぜこれが良いのか」の興味喚起
 *     D (Desire)     → 社会的証明・希少性で「欲しい」を強化
 *     A (Action)     → 明確なCTA（コメント・保存・プロフィール誘導）
 *
 *   心理トリガー:
 *     - FOMO（取り残される恐怖）
 *     - 社会的証明（口コミ件数・ランキング）
 *     - 希少性・緊急性（ランキングは毎日変わる）
 *     - 情報ギャップ（「知らないと損」）
 *     - 共感・自己関連性（「これ私のことだ」）
 *     - コミットメント（コメントで答えさせる）
 *
 * カテゴリ: beauty（美容家電）/ gadget（家電）/ kitchen（キッチン）
 * ============================================================
 */
import axios from "axios";
import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import { fileURLToPath } from "url";
import * as os from "os";
import * as fs from "fs";
import { eq, and } from "drizzle-orm";
import { getDb } from "../db";
import { posts } from "../../drizzle/schema";
import { storagePut } from "../storage";
import { generateCarouselImagesCanvas } from "./generate_carousel_canvas.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execFileAsync = promisify(execFile);

const IG_ACCOUNT_ID = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || "";
const FB_TOKEN = process.env.FACEBOOK_PAGE_ACCESS_TOKEN || "";
const API_VERSION = "v21.0";
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

/**
 * 安全装置: 開発環境またはDRY_RUN=trueの場合は投稿APIを呼ばない
 * 誤投稿によるInstagramブロックを防ぐ
 */
const IS_DRY_RUN = process.env.NODE_ENV === "development" || process.env.DRY_RUN === "true";
if (IS_DRY_RUN) {
  console.log("[postInstagram] ⚠️  DRY RUN MODE: 開発環境のため投稿APIは呼ばれません（画像生成のみ）");
}

// Pythonスクリプトのパス
const CAROUSEL_SCRIPT = path.join(__dirname, "generate_carousel.py");
const REEL_SCRIPT = path.join(__dirname, "generate_reel.py");

// カテゴリ表示名
const CATEGORY_LABELS: Record<string, string> = {
  beauty: "美容家電",
  gadget: "便利ガジェット",
  kitchen: "キッチン",
  life: "生活便利グッズ",
  amazon: "Amazon神アイテム",
};
/**
 * Node.js Canvasでカルーセル画像を生成する（Python不要）
 */
async function generateCarouselImages(
  categoryId: string,
  topProducts: Array<{
    rank: number;
    title: string;
    price: number;
    imageUrl: string | null;
    amazonImageUrl: string | null;
    asin: string | null;
    amazonUrl: string | null;
    rating: number | null;
    reviewCount: number | null;
  }>,
  tmpDir: string,
  source = "rakuten"
): Promise<string[]> {
  return generateCarouselImagesCanvas(categoryId, topProducts, tmpDir, source);
}

/**
 * 画像をS3にアップロードしてURLを返す
 */
async function uploadImageToS3(imagePath: string, key: string): Promise<string> {
  const imageBuffer = fs.readFileSync(imagePath);
  const { url } = await storagePut(key, imageBuffer, "image/jpeg");
  return url;
}

/**
 * Instagramカルーセルアイテムを作成する
 */
async function createCarouselItem(imageUrl: string): Promise<string> {
  const resp = await axios.post(`${BASE_URL}/${IG_ACCOUNT_ID}/media`, null, {
    params: {
      image_url: imageUrl,
      is_carousel_item: "true",
      access_token: FB_TOKEN,
    },
  });
  if (resp.data.error) {
    throw new Error(`カルーセルアイテム作成失敗: ${resp.data.error.message}`);
  }
  return resp.data.id;
}

/**
 * リール動画を生成する
 */
async function generateReelVideo(
  categoryId: string,
  topProducts: Array<{
    rank: number;
    title: string;
    price: number;
    imageUrl: string | null;
    rating: number | null;
    reviewCount: number | null;
  }>,
  outputPath: string
): Promise<string> {
  const inputData = JSON.stringify({
    category: categoryId,
    products: topProducts,
    output_path: outputPath,
  });

  const { stdout, stderr } = await execFileAsync(
    "python3",
    [REEL_SCRIPT, inputData],
    { timeout: 120000 }
  );

  if (stderr) {
    console.warn("[postInstagram] Reel Python stderr:", stderr.slice(0, 200));
  }

  const lines = stdout.trim().split("\n");
  const lastLine = lines[lines.length - 1];
  const result = JSON.parse(lastLine);
  return result.path as string;
}

/**
 * Instagramリール動画をアップロードして投稿する
 */
async function publishReel(videoUrl: string, caption: string): Promise<string> {
  // リールコンテナ作成
  const containerResp = await axios.post(
    `${BASE_URL}/${IG_ACCOUNT_ID}/media`,
    null,
    {
      params: {
        media_type: "REELS",
        video_url: videoUrl,
        caption,
        share_to_feed: "true",
        access_token: FB_TOKEN,
      },
    }
  );
  if (containerResp.data.error) {
    throw new Error(`リールコンテナ作成失敗: ${containerResp.data.error.message}`);
  }
  const containerId = containerResp.data.id;

  // 動画処理待ち（最大60秒）
  let status = "IN_PROGRESS";
  let attempts = 0;
  while (status !== "FINISHED" && attempts < 12) {
    await new Promise((r) => setTimeout(r, 5000));
    const statusResp = await axios.get(`${BASE_URL}/${containerId}`, {
      params: { fields: "status_code", access_token: FB_TOKEN },
    });
    status = statusResp.data.status_code || "IN_PROGRESS";
    attempts++;
    console.log(`[postInstagram] リール処理状態: ${status} (${attempts}/12)`);
  }

  if (status !== "FINISHED") {
    throw new Error(`リール動画処理タイムアウト: status=${status}`);
  }

  // 公開
  const publishResp = await axios.post(
    `${BASE_URL}/${IG_ACCOUNT_ID}/media_publish`,
    null,
    {
      params: {
        creation_id: containerId,
        access_token: FB_TOKEN,
      },
    }
  );
  if (publishResp.data.error) {
    throw new Error(`リール公開失敗: ${publishResp.data.error.message}`);
  }
  return publishResp.data.id;
}

/**
 * メディアの処理完了を待つ（FINISHED または READY になるまでポーリング）
 */
async function waitForMediaReady(mediaId: string, maxAttempts = 20): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const statusResp = await axios.get(`${BASE_URL}/${mediaId}`, {
      params: { fields: "status_code,status", access_token: FB_TOKEN },
    });
    const statusCode = statusResp.data.status_code;
    console.log(`  [status] ${mediaId}: ${statusCode} (${i + 1}/${maxAttempts})`);
    if (statusCode === "FINISHED" || statusCode === "READY") return;
    if (statusCode === "ERROR") {
      throw new Error(`メディア処理エラー: ${JSON.stringify(statusResp.data)}`);
    }
  }
  throw new Error(`メディア処理タイムアウト: ${mediaId}`);
}

/**
 * Instagramカルーセル投稿を公開する
 */
async function publishCarousel(itemIds: string[], caption: string): Promise<string> {
  // 各アイテムの処理完了を確認
  console.log(`[postInstagram] カルーセルアイテム処理待ち (${itemIds.length}件)...`);
  for (const itemId of itemIds) {
    await waitForMediaReady(itemId);
  }
  console.log("[postInstagram] 全アイテム処理完了。カルーセルコンテナ作成中...");

  const containerResp = await axios.post(
    `${BASE_URL}/${IG_ACCOUNT_ID}/media`,
    null,
    {
      params: {
        media_type: "CAROUSEL",
        children: itemIds.join(","),
        caption,
        access_token: FB_TOKEN,
      },
    }
  );
  if (containerResp.data.error) {
    throw new Error(`カルーセルコンテナ作成失敗: ${containerResp.data.error.message}`);
  }
  const containerId = containerResp.data.id;

  // コンテナ自体の処理完了を待つ
  console.log(`[postInstagram] カルーセルコンテナ処理待ち: ${containerId}`);
  await waitForMediaReady(containerId, 30);
  console.log("[postInstagram] カルーセルコンテナ準備完了。公開中...");

  const publishResp = await axios.post(
    `${BASE_URL}/${IG_ACCOUNT_ID}/media_publish`,
    null,
    {
      params: {
        creation_id: containerId,
        access_token: FB_TOKEN,
      },
      validateStatus: () => true, // 全ステータスを受け入れてエラー詳細を取得
    }
  );
  console.log(`[postInstagram] media_publishレスポンス: status=${publishResp.status}, data=${JSON.stringify(publishResp.data)}`);
  if (publishResp.data.error || publishResp.status >= 400) {
    const errDetail = JSON.stringify(publishResp.data);
    throw new Error(`投稿公開失敗 (HTTP ${publishResp.status}): ${errDetail}`);
  }
  return publishResp.data.id;
}

// ============================================================
// 【最強キャプション設計】
//
// 設計原則:
//   - 冷頭1行目: 絵文字+数字+問い でスクロールを止める
//   - 2行目: 社会的証明または共感で「自分のことだ」と思わせる
//   - CTA: コメント誘導（アルゴリズム最優先シグナル）+ 保存誘導
//   - ハッシュタグ: 改行で分離（本文と分ける）
//
// アルゴリズムが重視するシグナル:
//   コメント > 保存 > シェア > いいね の順で重み付け
// ============================================================
const CAPTION_TEMPLATES: Record<string, string[]> = {
  beauty: [
    `🔥 毎朝のヘアセットに15分以上かけてる人へ。
今楽天で一番売れてる美容家電TOP5をまとめた。

気になるのどれ？コメントで番号教えて👇
保存してあとでゆっくり見てね📌
プロフィールのリンクから最安値チェック👆`,

    `✨ 「サロン代が高くてもう限界」と思ってたときに見つけた。
自宅でサロン品質を実現できる美容家電、楽天ランキングから厳選。

同じ悩みある人は「わかる」ってコメントして🙏
保存しておけば後で後悔しないよ📌
プロフィールのリンクから詳細チェック👆`,

    `💬 「これどこで買える？」って聞かれる美容家電をまとめた。
口コミ件数が証明する、楽天ランキング上位の本物だけ。

「知ってた」か「知らなかった」かコメントで教えて！
保存して週末にゆっくり見てね📌
プロフィールのリンクから最安値チェック👆`,

    `💆‍♀️ 美容家電で失敗したことある人へ。
楽天ランキングから厳選した「本当に使える」5選。

「欲しい」と思ったものはコメントで教えて👇
保存してあとでチェック📌
プロフィールのリンクから最安値チェック👆`,

    `💸 「この値段でこの品質はやばい」と思った美容家電をまとめた。
プロ仕様の仕上がりが、楽天で手の届く価格になってる。

気になるのどれ？コメントで教えて👇
保存しておけば買い物失敗が減るよ📌
プロフィールのリンクから最安値チェック👆`,
  ],

  gadget: [
    `⚡ 充電切れで困ったことある人へ。今楽天で一番売れてる便利ガジェットTOP5。
これ知ってたら毎日のストレスが減ってたかも。

気になるのどれ？コメントで番号教えて👇
保存してあとでゆっくり見てね📌
プロフィールのリンクから最安値チェック👆`,

    `💻 仕事の集中力が続かないと思ってたときに見つけたガジェット。
楽天ランキングから厳選した「本当に使える」5選。

「これ欲しかった」と思ったらコメントで教えて👇
保存して週末にゆっくり見てね📌
プロフィールのリンクから最安値チェック👆`,

    `💬 「これどこで買える？」って聞かれるガジェットをまとめた。
楽天ランキングから厳選した、口コミが証明する本物だけ。

「知ってた」か「知らなかった」かコメントで教えて！
保存して週末にゆっくり見てね📌
プロフィールのリンクから最安値チェック👆`,

    `💸 「この値段でこの性能はやばい」と思ったガジェットをまとめた。
プロ仕様の性能が、楽天で手の届く価格になってる。

気になるのどれ？コメントで教えて👇
保存しておけば買い物失敗が減るよ📌
プロフィールのリンクから最安値チェック👆`,

    `🤔 これ全部知ってた？99%の人が知らない便利ガジェットを楽天ランキングから厳選。
知ってたものはコメントで番号教えて👇知らなかったものは保存して後で確認📌

プロフィールのリンクから詳細チェック👆`,
  ],

  kitchen: [
    `🍳 「毎日の料理が面倒」と思ってたときに見つけたキッチングッズ。
楽天ランキングから厳選した、料理が楽しくなる5選。

同じ悩みある人は「わかる」ってコメントして🙏
保存しておけば後で後悔しないよ📌
プロフィールのリンクから詳細チェック👆`,

    `⏰ 朝食5分で作れるって知ってた？今楽天で一番売れてるキッチングッズ TOP5。
これ知らないと毎朝の時間を損してるかも。

気になるのどれ？コメントで番号教えて👇
保存してあとでゆっくり見てね📌
プロフィールのリンクから最安値チェック👆`,

    `💬 「これどこで買える？」って聞かれるキッチングッズをまとめた。
口コミが証明する、楽天ランキング上位の本物だけ。

「知ってた」か「知らなかった」かコメントで教えて！
保存して週末にゆっくり見てね📌
プロフィールのリンクから最安値チェック👆`,

    `☕ 「カフェのトーストが自宅で食べたい」と思ってたときに見つけた。
楽天で手の届く価格のキッチン家電、コスパ最強ランキングにまとめた。

保存しておけば買い物失敗が減るよ📌
気になるのどれ？コメントで教えて👇
プロフィールのリンクから最安値チェック👆`,

    `😱 これ知らないと絶対損してた。楽天リアルタイムランキングキッチングッズ TOP5。
ランキングは毎日変わるから今のうちに保存しておいて📌

「欲しい」と思ったものはコメントで教えて👇
プロフィールのリンクから最安値チェック👆`,
  ],

  default: [
    `🔥 「これどこで買える？」って聞かれる神アイテムをまとめた。
楽天リアルタイムランキングから厳選した本物だけ。

気になるのどれ？コメントで番号教えて👇
保存してあとでゆっくり見てね📌
プロフィールのリンクから最安値チェック👆`,

    `✨ 口コミ総数が証明する神アイテム。楽天ランキングから厳選した本物だけ。
「知ってた」か「知らなかった」かコメントで教えて！

保存して週末にゆっくり見てね📌
プロフィールのリンクから最安値チェック👆`,

    `🤔 これ全部知ってた？99%の人が知らない神アイテムを楽天ランキングから厳選。
知ってたものはコメントで番号教えて👇知らなかったものは保存して後で確認📌

プロフィールのリンクから詳細チェック👆`,

    `🙌 買って良かったもの、正直に言うとこれだった。
このランキング、認める人は「わかる」ってコメントして🙏

保存しておけば後で後悔しないよ📌
プロフィールのリンクから最安値チェック👆`,

    `😱 「この値段でこの品質はやばい」と思った神アイテムをまとめた。
コスパ最強ランキングTOP5。保存しておけば買い物失敗が減るよ📌

気になるのどれ？コメントで教えて👇
プロフィールのリンクから最安値チェック👆`,
  ],
};

// ============================================================
// 【アルゴリズム最適化】ハッシュタグ週次ローテーション戦略
//
// 設計思想:
//   - シャドウバン防止: 同じタグを毎日使い続けるとスパム判定リスク
//   - 4週サイクルで異なるタグセットをローテーション
//   - 超大型タグ（1000万件超）: リーチ拡大
//   - 中型タグ（10-100万件）: 発見されやすさ
//   - 小型タグ（1-10万件）: ニッチ層へのリーチ
//   - カテゴリ特化タグ: ターゲット層への精度
//
// 合計: カテゴリ5 + 共通6 = 11個（最適は8-15個）
// ============================================================

/** 現在の週番号（年初からの週数）を取得する */
function getWeekNumber(): number {
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  return Math.floor((now.getTime() - startOfYear.getTime()) / weekMs);
}

/** カテゴリ別ハッシュタグ（4週ローテーション） */
const CATEGORY_HASHTAG_SETS: Record<string, string[]> = {
  beauty: [
    // Week A: ヘアケア特化
    "#美容家電 #ヘアケア #美容好きな人と繋がりたい #美容グッズ #ヘアアレンジ",
    // Week B: スキンケア特化
    "#美容好き #スキンケア好き #美容垢 #美容レビュー #美容オタク",
    // Week C: ビューティー全般
    "#ビューティー #美容部員 #コスメ好き #美容マニア #美容情報",
    // Week D: ヘアスタイル特化
    "#ヘアスタイル #ヘアセット #美髪 #髪質改善 #ヘアケアグッズ",
  ],
  gadget: [
    // Week A: ガジェット全般
    "#ガジェット好き #便利グッズ #ガジェット部 #テック好き #仕事効率化",
    // Week B: スマホ・PC周辺
    "#ガジェットレビュー #テックグッズ #デジタルガジェット #スマホ周辺機器 #PC周辺機器",
    // Week C: 在宅ワーク特化
    "#在宅ワーク #テレワーク #ホームオフィス #仕事道具 #リモートワーク",
    // Week D: 充電・モバイル特化
    "#モバイルバッテリー #充電器 #ワイヤレス充電 #USB充電 #スマートデバイス",
  ],
  kitchen: [
    // Week A: キッチン全般
    "#キッチングッズ #料理好きな人と繋がりたい #時短料理 #おうちごはん #キッチンインテリア",
    // Week B: 料理・レシピ特化
    "#料理好き #手料理 #自炊 #おうちカフェ #キッチン雑貨",
    // Week C: 時短・便利特化
    "#時短家事 #家事効率化 #キッチン家電 #調理家電 #便利調理器具",
    // Week D: インテリア・おうち特化
    "#おうち時間 #暮らしの道具 #キッチンDIY #料理道具 #台所用品",
  ],
  life: [
    // Week A: ライフハック全般
    "#ライフハック #時短グッズ #生活便利グッズ #暮らしを楽しむ #丁寧な暮らし",
    // Week B: 暮らし・インテリア特化
    "#暮らし #シンプルライフ #ミニマリスト #インテリア好き #生活雑貨",
    // Week C: 節約・お得特化
    "#節約生活 #賢い買い物 #生活用品 #日用品 #コスパ重視",
    // Week D: 整理整頓・収納特化
    "#収納グッズ #整理整頓 #片付け #スッキリ暮らし #収納アイデア",
  ],
  amazon: [
    // Week A: Amazon特化
    "#Amazon神アイテム #Amazonおすすめ #Amazon購入品 #アマゾン #Amazonレビュー",
    // Week B: 楽天特化
    "#楽天買い回り #お買い物マラソン #楽天ポイント #楽天市場 #楽天おすすめ",
    // Week C: ショッピング全般
    "#ネットショッピング #通販 #お買い物記録 #購入品紹介 #おすすめ通販",
    // Week D: ランキング・人気商品特化
    "#売れ筋ランキング #人気ランキング #ランキング1位 #売れてる商品 #話題のアイテム",
  ],
};

/** 共通ハッシュタグ（4週ローテーション） */
const COMMON_HASHTAG_SETS: string[] = [
  // Week A
  "#楽天ランキング #コスパ最強 #買ってよかった #神アイテム #おすすめ商品 #人気商品",
  // Week B
  "#おすすめ #人気 #ランキング #コスパ #お気に入り #購入品",
  // Week C
  "#今日の買い物 #おすすめアイテム #話題 #トレンド #注目アイテム #新着",
  // Week D
  "#お得 #セール #割引 #特価 #限定 #期間限定",
];

/** 週次ローテーションでハッシュタグを取得する */
function getRotatedHashtags(categoryId: string): { category: string; common: string } {
  const weekNum = getWeekNumber();
  const setIndex = weekNum % 4; // 4週サイクル
  const categorySets = CATEGORY_HASHTAG_SETS[categoryId] ?? CATEGORY_HASHTAG_SETS["amazon"];
  return {
    category: categorySets[setIndex] ?? categorySets[0],
    common: COMMON_HASHTAG_SETS[setIndex] ?? COMMON_HASHTAG_SETS[0],
  };
}

// 後方互換性のため（直接参照している箇所があれば）
const CATEGORY_HASHTAGS: Record<string, string> = Object.fromEntries(
  Object.entries(CATEGORY_HASHTAG_SETS).map(([k, v]) => [k, v[0]])
);
const COMMON_HASHTAGS = COMMON_HASHTAG_SETS[0];

/**
 * 【AIDA × 心理トリガー設計】キャプションを生成する
 *
 * 最終キャプション構造:
 *   {AIDAフレームワーク準拠のランダムキャプション}
 *
 *   {カテゴリ特化タグ5個}
 *   {共通タグ8個}
 *   合計13個（アルゴリズム最適範囲）
 */
function buildCaption(
  categoryId: string,
  topProducts: Array<{
    rank: number;
    title: string;
    price: number;
    amazonUrl: string | null;
    rating?: number | null;
    reviewCount?: number | null;
  }>
): string {
  // カテゴリ別テンプレート、なければデフォルト
  const templates = CAPTION_TEMPLATES[categoryId] ?? CAPTION_TEMPLATES["default"];
  const randomCaption = templates[Math.floor(Math.random() * templates.length)];

  // 週次ローテーションでハッシュタグを取得（シャドウバン防止）
  const { category: categoryHashtags, common: commonHashtags } = getRotatedHashtags(categoryId);
  const weekNum = getWeekNumber();
  console.log(`[postInstagram] ハッシュタグセット: Week${weekNum % 4 + 1} (${categoryId})`);

  const lines = [randomCaption, ""];
  if (categoryHashtags) lines.push(categoryHashtags);
  lines.push(commonHashtags);

  return lines.join("\n");
}

/**
 * 24時間以内の重複投稿をチェックする
 */
function isPostedWithin24Hours(postedAt: Date | null): boolean {
  if (!postedAt) return false;
  const now = Date.now();
  const postedTime = new Date(postedAt).getTime();
  return now - postedTime < 24 * 60 * 60 * 1000;
}

/**
 * 投稿後に詳細ログを出力する
 */
function logPostResult(postId: string, caption: string, category: string, hookUsed: string): void {
  const timestamp = new Date().toISOString();
  console.log(
    JSON.stringify({
      event: "instagram_post_success",
      post_id: postId,
      category,
      hook_used: hookUsed,
      caption_preview: caption.slice(0, 80),
      timestamp,
    })
  );
}

// ============================================================
// メイン投稿処理（既存シグネチャ互換）
// ============================================================
/**
 * リール投稿ジョブ（カルーセルと同じフローでリール動画を投稿）
 */
export async function postInstagramReelJob(
  targetCategory?: string
): Promise<void> {
  console.log("[postInstagramReel] リールジョブ開始:", new Date().toISOString());

  if (!FB_TOKEN) {
    console.error("[postInstagramReel] FACEBOOK_PAGE_ACCESS_TOKEN が未設定です");
    return;
  }
  if (!IG_ACCOUNT_ID) {
    console.error("[postInstagramReel] INSTAGRAM_BUSINESS_ACCOUNT_ID が未設定です");
    return;
  }

  const db = await getDb();
  if (!db) {
    console.error("[postInstagramReel] DB接続失敗");
    return;
  }

  const categories = targetCategory
    ? [targetCategory]
    : ["beauty", "gadget", "kitchen", "life", "amazon"];

  for (const category of categories) {
    const categoryLabel = CATEGORY_LABELS[category] || category;
    console.log(`[postInstagramReel] カテゴリ処理中: ${categoryLabel}`);

    const unpostedItems = await db
      .select()
      .from(posts)
      .where(and(eq(posts.category, category), eq(posts.posted, false)))
      .orderBy(posts.rank)
      .limit(5);

    if (unpostedItems.length === 0) {
      console.log(`[postInstagramReel] 未投稿商品なし: ${categoryLabel}`);
      continue;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reel_"));
    try {
      const topProducts = unpostedItems.map((item) => ({
        rank: item.rank,
        title: item.title,
        price: item.price,
        // Amazon画像URLを優先使用（高品質・白背景）
        imageUrl: item.amazonImageUrl || item.imageUrl,
        rating: item.rating ? parseFloat(item.rating) : null,
        reviewCount: item.reviewCount ?? null,
      }));

      // リール動画生成
      console.log("[postInstagramReel] リール動画生成中...");
      const outputPath = path.join(tmpDir, "reel.mp4");
      const videoPath = await generateReelVideo(category, topProducts, outputPath);

      // S3にアップロード
      console.log("[postInstagramReel] S3アップロード中...");
      const timestamp = Date.now();
      const key = `instagram/reels/${category}/${timestamp}_reel.mp4`;
      const videoBuffer = fs.readFileSync(videoPath);
      const { url: videoUrl } = await storagePut(key, videoBuffer, "video/mp4");
      console.log(`[postInstagramReel] アップロード完了: ${videoUrl.slice(0, 60)}...`);

      // キャプション生成
      const captionProducts = topProducts.map((p) => ({ ...p, amazonUrl: null }));
      const caption = buildCaption(category, captionProducts);

      // リール投稿
      console.log("[postInstagramReel] リール投稿中...");
      const postId = await publishReel(videoUrl, caption);
      console.log(`[postInstagramReel] 投稿完了: ${postId}`);

      // DB更新
      const now = new Date();
      for (const item of unpostedItems) {
        await db
          .update(posts)
          .set({ posted: true, instagramPostId: postId, postedAt: now })
          .where(eq(posts.id, item.id));
      }
      console.log(`[postInstagramReel] ${unpostedItems.length}件をposted=trueに更新`);
    } catch (e) {
      console.error(`[postInstagramReel] リール投稿エラー (${categoryLabel}):`, e);
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  console.log("[postInstagramReel] リールジョブ完了:", new Date().toISOString());
}

export async function postInstagramJob(
  targetCategory?: string,
  targetSource?: "rakuten" | "amazon"
): Promise<void> {
  console.log("[postInstagram] ジョブ開始:", new Date().toISOString());

  if (!FB_TOKEN) {
    console.error("[postInstagram] FACEBOOK_PAGE_ACCESS_TOKEN が未設定です");
    return;
  }
  if (!IG_ACCOUNT_ID) {
    console.error("[postInstagram] INSTAGRAM_BUSINESS_ACCOUNT_ID が未設定です");
    return;
  }

  const db = await getDb();
  if (!db) {
    console.error("[postInstagram] DB接続失敗");
    return;
  }

  const categories = targetCategory
    ? [targetCategory]
    : ["beauty", "gadget", "kitchen"];

  for (const category of categories) {
    const categoryLabel = CATEGORY_LABELS[category] || category;
    console.log(`[postInstagram] カテゴリ処理中: ${categoryLabel}`);

    // postsテーブルから未投稿商品を取得（rank順TOP5）
    const whereCondition = targetSource
      ? and(eq(posts.category, category), eq(posts.posted, false), eq(posts.source, targetSource))
      : and(eq(posts.category, category), eq(posts.posted, false));

    const unpostedItems = await db
      .select()
      .from(posts)
      .where(whereCondition)
      .orderBy(posts.rank)
      .limit(5);

    if (unpostedItems.length === 0) {
      console.log(`[postInstagram] 未投稿商品なし: ${categoryLabel}`);
      continue;
    }

    // 24時間重複防止チェック
    const recentlyPosted = unpostedItems.filter((item) => {
      return item.postedAt && isPostedWithin24Hours(item.postedAt);
    });
    if (recentlyPosted.length > 0) {
      console.log(`[postInstagram] 重複投稿防止: ${categoryLabel} の商品が24時間以内に投稿済みです。スキップします。`);
      continue;
    }

    console.log(`[postInstagram] 未投稿商品: ${unpostedItems.length}件`);

    // 一時ディレクトリを作成
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "carousel_"));
    try {
      // Pythonスクリプトでカルーセル画像を生成
      console.log("[postInstagram] 画像生成中...");
      const topProducts = unpostedItems.map((item) => ({
        rank: item.rank,
        title: item.title,
        price: item.price,
        imageUrl: item.imageUrl,
        amazonImageUrl: item.amazonImageUrl ?? null, // Amazon画像（白背景・高品質）
        asin: item.asin,
        amazonUrl: item.amazonUrl,
        rating: item.rating ? parseFloat(item.rating) : null,
        reviewCount: item.reviewCount ?? null,
      }));

      const imagePaths = await generateCarouselImages(category, topProducts, tmpDir, targetSource || "rakuten");
      console.log(`[postInstagram] 画像生成完了: ${imagePaths.length}枚`);

      if (imagePaths.length === 0) {
        console.error("[postInstagram] 画像生成失敗");
        continue;
      }

      // 画像をS3にアップロード
      console.log("[postInstagram] S3アップロード中...");
      const timestamp = Date.now();
      const imageUrls: string[] = [];
      for (let i = 0; i < imagePaths.length; i++) {
        const key = `instagram/${category}/${timestamp}_slide_${String(i).padStart(2, "0")}.jpg`;
        const url = await uploadImageToS3(imagePaths[i], key);
        imageUrls.push(url);
        console.log(`  スライド${i + 1}: ${url.slice(0, 60)}...`);
      }

      // DRY RUNモードの場合は画像生成のみで投稿しない
      if (IS_DRY_RUN) {
        console.log("[postInstagram] ⚠️  DRY RUN: 投稿をスキップしました");
        console.log(`[postInstagram] 生成画像URL (${imageUrls.length}枚):`);
        imageUrls.forEach((u, i) => console.log(`  スライド${i+1}: ${u}`));
        return;
      }

      // Instagramカルーセルアイテムを作成
      console.log("[postInstagram] カルーセルアイテム作成中...");
      const itemIds: string[] = [];
      for (const url of imageUrls) {
        const itemId = await createCarouselItem(url);
        itemIds.push(itemId);
        await new Promise((r) => setTimeout(r, 1000));
      }

      // キャプション生成（AIDA × 心理トリガー設計）
      const caption = buildCaption(category, topProducts);
      console.log(`[postInstagram] キャプション生成完了`);

      // 投稿
      console.log("[postInstagram] 投稿中...");
      const postId = await publishCarousel(itemIds, caption);

      // 詳細ログ出力
      const hookUsed = caption.split("\n")[0] || "";
      logPostResult(postId, caption, category, hookUsed);

      // postsテーブルを posted=true, instagramPostId, postedAt で更新
      const now = new Date();
      for (const item of unpostedItems) {
        await db
          .update(posts)
          .set({
            posted: true,
            instagramPostId: postId,
            postedAt: now,
          })
          .where(eq(posts.id, item.id));
      }
      console.log(`[postInstagram] ${unpostedItems.length}件をposted=trueに更新`);
    } catch (e) {
      console.error(`[postInstagram] 投稿エラー (${categoryLabel}):`, e);
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  console.log("[postInstagram] ジョブ完了:", new Date().toISOString());
}
