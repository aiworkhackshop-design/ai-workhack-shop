/**
 * run_instagram.mjs
 * GitHub Actions から実行するInstagram投稿スクリプト
 *
 * 実行タイミング（GitHub Actions cron）:
 *   09:00 JST (00:00 UTC) → Amazon投稿
 *   15:00 JST (06:00 UTC) → 楽天投稿（beauty/gadget/kitchen/life）
 *   20:00 JST (11:00 UTC) → Amazon投稿
 *
 * 使い方:
 *   node --loader tsx/esm run_instagram.mjs [--category=amazon|beauty|gadget|kitchen|life] [--slot=morning|afternoon|evening]
 *
 * 必要な環境変数 (GitHub Secrets):
 *   DATABASE_URL                      - TiDB/MySQL 接続文字列
 *   INSTAGRAM_BUSINESS_ACCOUNT_ID     - Instagram ビジネスアカウント ID
 *   FACEBOOK_PAGE_ACCESS_TOKEN        - Facebook Page Access Token
 *   BUILT_IN_FORGE_API_URL            - Manus ストレージ URL
 *   BUILT_IN_FORGE_API_KEY            - Manus ストレージ API キー
 */

import { config } from "dotenv";
config();

// 環境変数チェック
const REQUIRED_ENVS = [
  "DATABASE_URL",
  "INSTAGRAM_BUSINESS_ACCOUNT_ID",
  "FACEBOOK_PAGE_ACCESS_TOKEN",
  "BUILT_IN_FORGE_API_URL",
  "BUILT_IN_FORGE_API_KEY",
];
const missing = REQUIRED_ENVS.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`❌ 必要な環境変数が不足しています: ${missing.join(", ")}`);
  process.exit(1);
}

// NODE_ENV を production に設定（DRY RUN を解除）
process.env.NODE_ENV = "production";

// コマンドライン引数を解析
const args = process.argv.slice(2);
const categoryArg = args.find((a) => a.startsWith("--category="))?.split("=")[1];
const slotArg = args.find((a) => a.startsWith("--slot="))?.split("=")[1];

// 投稿スロット定義
const SLOT_CATEGORIES = {
  morning:   ["amazon"],          // 09:00 JST
  afternoon: ["beauty", "gadget", "kitchen", "life"], // 15:00 JST
  evening:   ["amazon"],          // 20:00 JST
};

// 実行するカテゴリを決定
let categoriesToPost;
if (categoryArg) {
  categoriesToPost = [categoryArg];
} else if (slotArg && SLOT_CATEGORIES[slotArg]) {
  categoriesToPost = SLOT_CATEGORIES[slotArg];
} else {
  // 現在時刻（UTC）からスロットを自動判定
  const hour = new Date().getUTCHours();
  if (hour === 0) {
    categoriesToPost = SLOT_CATEGORIES.morning;
  } else if (hour === 6) {
    categoriesToPost = SLOT_CATEGORIES.afternoon;
  } else if (hour === 11) {
    categoriesToPost = SLOT_CATEGORIES.evening;
  } else {
    // 手動実行の場合はamazonのみ
    categoriesToPost = ["amazon"];
  }
}

console.log("=".repeat(60));
console.log("[run_instagram] Instagram投稿ジョブ開始");
console.log(`[run_instagram] 実行時刻: ${new Date().toISOString()}`);
console.log(`[run_instagram] 投稿カテゴリ: ${categoriesToPost.join(", ")}`);
console.log("=".repeat(60));

// 環境変数の確認
console.log("\n=== 環境変数確認 ===");
console.log("INSTAGRAM_BUSINESS_ACCOUNT_ID:", process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID ? "設定済み" : "未設定");
console.log("FACEBOOK_PAGE_ACCESS_TOKEN:", process.env.FACEBOOK_PAGE_ACCESS_TOKEN ? "設定済み" : "未設定");
console.log("DATABASE_URL:", process.env.DATABASE_URL ? "設定済み" : "未設定");
console.log("BUILT_IN_FORGE_API_URL:", process.env.BUILT_IN_FORGE_API_URL ? "設定済み" : "未設定");
console.log("NODE_ENV:", process.env.NODE_ENV);
console.log("");

// postInstagramJob をインポート
const { postInstagramJob } = await import("./server/jobs/postInstagram.ts");

// 各カテゴリを順番に投稿
let successCount = 0;
let failCount = 0;

for (const category of categoriesToPost) {
  console.log(`\n[投稿] カテゴリ: ${category}`);
  try {
    await postInstagramJob(category);
    console.log(`[投稿] ✅ ${category} 投稿完了`);
    successCount++;
    // Instagram API レート制限対策: カテゴリ間に5秒待機
    if (categoriesToPost.indexOf(category) < categoriesToPost.length - 1) {
      console.log("[投稿] 5秒待機中...");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  } catch (err) {
    console.error(`[投稿] ❌ ${category} 投稿エラー:`, err.message);
    console.error(err.stack);
    failCount++;
  }
}

console.log("\n" + "=".repeat(60));
console.log(`[run_instagram] 完了: 成功 ${successCount}件 / 失敗 ${failCount}件`);
console.log("=".repeat(60));

if (failCount > 0) {
  process.exit(1);
}
process.exit(0);
