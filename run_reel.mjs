/**
 * run_reel.mjs
 * GitHub Actions から実行するInstagramリール投稿スクリプト
 *
 * 実行タイミング: 月・水・金 12:00 JST (03:00 UTC)
 *
 * 使い方:
 *   node --loader tsx/esm run_reel.mjs [--category=amazon|beauty|gadget|kitchen|life]
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

// カテゴリが指定されていない場合は週番号でローテーション
const CATEGORIES = ["beauty", "gadget", "kitchen", "life", "amazon"];
const weekNumber = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
const category = categoryArg || CATEGORIES[weekNumber % CATEGORIES.length];

console.log("=".repeat(60));
console.log("[run_reel] Instagram リール投稿ジョブ開始");
console.log(`[run_reel] 実行時刻: ${new Date().toISOString()}`);
console.log(`[run_reel] 投稿カテゴリ: ${category}`);
console.log("=".repeat(60));

// 環境変数の確認
console.log("\n=== 環境変数確認 ===");
console.log("INSTAGRAM_BUSINESS_ACCOUNT_ID:", process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID ? "設定済み" : "未設定");
console.log("FACEBOOK_PAGE_ACCESS_TOKEN:", process.env.FACEBOOK_PAGE_ACCESS_TOKEN ? "設定済み" : "未設定");
console.log("DATABASE_URL:", process.env.DATABASE_URL ? "設定済み" : "未設定");
console.log("NODE_ENV:", process.env.NODE_ENV);
console.log("");

try {
  const { postInstagramReelJob } = await import("./server/jobs/postInstagram.ts");
  console.log(`\n[リール] カテゴリ: ${category} のリール動画生成・投稿を開始...`);
  await postInstagramReelJob(category);
  console.log(`[リール] ✅ リール投稿完了`);
} catch (err) {
  console.error("[リール] ❌ リール投稿エラー:", err.message);
  console.error(err.stack);
  process.exit(1);
}

console.log("\n" + "=".repeat(60));
console.log("[run_reel] ✅ リール投稿完了");
console.log("=".repeat(60));
process.exit(0);
