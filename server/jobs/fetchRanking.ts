/**
 * 楽天商品取得ジョブ
 * 楽天市場 IchibaItem/Search API でキーワード検索し、
 * レビュー数順 TOP5 を posts テーブルに保存する
 *
 * カテゴリ: beauty（美容家電）/ gadget（便利ガジェット）/ kitchen（キッチン便利グッズ）/ life（生活便利グッズ）/ amazon（Amazon神アイテム）
 *
 * フロー:
 *   楽天 IchibaItem/Search → 食品除外フィルタ → ASIN 取得 → DB 保存（posts）
 */
import axios from "axios";
import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import * as path from "path";
import { getDb } from "../db";
import { posts, InsertPost } from "../../drizzle/schema";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execFileAsync = promisify(execFile);

const PARTNER_TAG = "aiworkhacksho-22";
const RAKUTEN_APP_ID = process.env.RAKUTEN_APP_ID || "";
const RAKUTEN_ACCESS_KEY = process.env.RAKUTEN_ACCESS_KEY || "";

/** 楽天 IchibaItem/Search API（新エンドポイント） */
const RAKUTEN_SEARCH_API =
  "https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220601";

/**
 * カテゴリ設定
 * keyword: 楽天検索キーワード
 * id: DB に保存する category 値
 * hits: 検索件数（食品除外後に5件確保するため多めに取得）
 */
const RANKING_CATEGORIES = [
  {
    id: "beauty" as const,
    label: "美容家電",
    keyword: "美容家電 人気",
    hits: 10,
  },
  {
    id: "gadget" as const,
    label: "便利ガジェット",
    keyword: "ガジェット 便利 充電",
    hits: 15,
  },
  {
    id: "kitchen" as const,
    label: "キッチン便利グッズ",
    keyword: "キッチン 便利グッズ 調理",
    hits: 15,
  },
  {
    id: "life" as const,
    label: "生活便利グッズ",
    keyword: "生活 便利グッズ 収納",
    hits: 15,
  },
  {
    id: "amazon" as const,
    label: "Amazon神アイテム",
    keyword: "便利 おすすめ 人気 家電",
    hits: 15,
  },
];

/**
 * 食品・食料品を除外するキーワードリスト
 */
const FOOD_KEYWORDS = [
  "トマト", "ミニトマト", "野菜", "果物", "フルーツ", "お茶", "緑茶", "コーヒー",
  "抹茶", "米", "お米", "パン", "肉", "魚", "海鮮", "刺身", "寿司", "ラーメン",
  "うどん", "そば", "パスタ", "カレー", "スープ", "味噌", "醤油", "調味料",
  "スナック", "お菓子", "チョコ", "ケーキ", "クッキー", "飴", "グミ",
  "ジュース", "ビール", "ワイン", "日本酒", "焼酎", "飲料", "水",
  "サプリ", "プロテイン", "栄養", "健康食品", "ダイエット食品",
  "胡蝶蘭", "花", "植物", "種", "苗", "肥料",
  "福袋", "アウトレット", "訳あり", "B級",
];

/**
 * 商品タイトルが食品カテゴリかどうかを判定する
 */
function isFoodItem(title: string): boolean {
  const lowerTitle = title.toLowerCase();
  return FOOD_KEYWORDS.some((keyword) => title.includes(keyword));
}

/**
 * asin_utils.py を使って商品名から ASIN とAmazon画像URLを取得する
 */
async function searchAsinAndImage(productName: string): Promise<{ asin: string | null; imageUrl: string | null }> {
  const scriptPath = path.join(__dirname, "asin_utils.py");
  try {
    const { stdout } = await execFileAsync("python3", [scriptPath, productName], {
      timeout: 20000,
    });
    const result = JSON.parse(stdout.trim());
    return {
      asin: result.asin || null,
      imageUrl: result.image_url || null,
    };
  } catch {
    return { asin: null, imageUrl: null };
  }
}

/**
 * 楽天 IchibaItem/Search API でキーワード検索し、食品除外後 TOP5 を取得する
 */
async function fetchByKeyword(
  keyword: string,
  category: string,
  hits: number = 15
): Promise<InsertPost[]> {
  if (!RAKUTEN_APP_ID || !RAKUTEN_ACCESS_KEY) {
    console.error("[fetchRanking] RAKUTEN_APP_ID または RAKUTEN_ACCESS_KEY が未設定");
    return [];
  }

  try {
    const resp = await axios.get(RAKUTEN_SEARCH_API, {
      params: {
        applicationId: RAKUTEN_APP_ID,
        accessKey: RAKUTEN_ACCESS_KEY,
        keyword,
        hits,
        sort: "-reviewCount",
        formatVersion: 2,
        format: "json",
      },
      headers: {
        Referer: "https://trpcmanus-b6cbv8wc.manus.space/",
        Origin: "https://trpcmanus-b6cbv8wc.manus.space",
      },
      timeout: 15000,
    });

    const rawItems: unknown[] = resp.data?.Items || [];
    const items: InsertPost[] = [];
    let rank = 1;

    for (const rawItem of rawItems) {
      if (items.length >= 5) break;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const item = rawItem as any;
      const title: string = item.itemName || "";
      if (!title || title.length < 3) continue;

      // 食品除外フィルタ
      if (isFoodItem(title)) {
        console.log(`  [食品除外] ${title.slice(0, 40)}`);
        continue;
      }

      const price: number = item.itemPrice || 0;
      // mediumImageUrls is an array of strings (not objects)
      const imageUrl: string | null =
        (typeof item.mediumImageUrls?.[0] === "string" ? item.mediumImageUrls[0] : null) ||
        (typeof item.smallImageUrls?.[0] === "string" ? item.smallImageUrls[0] : null) ||
        null;
      const rakutenUrl: string | null = item.itemUrl || null;
      const reviewAverage: string | null = item.reviewAverage
        ? String(item.reviewAverage)
        : null;
      const reviewCount: number | null = item.reviewCount
        ? Number(item.reviewCount)
        : null;

      items.push({
        title,
        price,
        asin: null,
        imageUrl,
        rakutenUrl,
        amazonUrl: null,
        category,
        rating: reviewAverage,
        reviewCount,
        rank,
        posted: false,
      });
      rank++;
    }

    console.log(
      `[fetchRanking] 楽天検索: ${items.length}件取得 (keyword="${keyword}", 食品除外後)`
    );
    return items;
  } catch (e) {
    console.error(`[fetchRanking] 楽天検索エラー (keyword="${keyword}"):`, e);
    return [];
  }
}

/**
 * メインジョブ: 楽天キーワード検索 → 食品除外 → ASIN 取得 → DB 保存
 */
export async function fetchRankingJob(targetCategory?: string): Promise<void> {
  console.log("[fetchRanking] ジョブ開始:", new Date().toISOString());

  const db = await getDb();
  if (!db) {
    console.error("[fetchRanking] DB接続失敗");
    return;
  }

  const categoriesToProcess = targetCategory
    ? RANKING_CATEGORIES.filter((c) => c.id === targetCategory)
    : RANKING_CATEGORIES;

  for (const cat of categoriesToProcess) {
    console.log(`[fetchRanking] カテゴリ処理中: ${cat.label} (keyword="${cat.keyword}")`);

    // 楽天 IchibaItem/Search でキーワード検索（食品除外フィルタ付き）
    const fetchedItems = await fetchByKeyword(cat.keyword, cat.id, cat.hits);

    if (fetchedItems.length === 0) {
      console.warn(`[fetchRanking] 商品が取得できませんでした: ${cat.label}`);
      continue;
    }

    // 各商品の ASIN とAmazon画像URLを取得して posts テーブルに保存
    for (const item of fetchedItems) {
      // 商品名で Amazon ASIN と画像URLを取得
      let asin: string | null = null;
      let amazonImageUrl: string | null = null;
      if (item.title) {
        console.log(
          `  [${item.rank}位] Amazon検索中: ${item.title.slice(0, 40)}...`
        );
        const result = await searchAsinAndImage(item.title);
        asin = result.asin;
        amazonImageUrl = result.imageUrl;
        await new Promise((r) => setTimeout(r, 1500)); // レート制限対策
      }

      // Amazon URL を生成（ASIN がある場合のみ）
      const amazonUrl = asin
        ? `https://www.amazon.co.jp/dp/${asin}?tag=${PARTNER_TAG}`
        : null;

      // posts テーブルに INSERT
      try {
        await db.insert(posts).values({
          ...item,
          asin: asin || null,
          amazonUrl,
          // Amazon画像があればそちらを使用、なければ楽天画像を使用
          imageUrl: amazonImageUrl || item.imageUrl,
          posted: false,
        });
        console.log(
          `  [${item.rank}位] 保存: ${item.title.slice(0, 30)} | ASIN: ${asin || "なし"}`
        );
      } catch (e) {
        console.warn(
          `  [${item.rank}位] 保存スキップ (重複の可能性):`,
          (e as Error).message?.slice(0, 80)
        );
      }
    }
  }

  console.log("[fetchRanking] ジョブ完了:", new Date().toISOString());
}
