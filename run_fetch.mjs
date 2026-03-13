/**
 * run_fetch.mjs
 * GitHub Actions から実行するランキング取得スクリプト
 *
 * 実行タイミング: 毎日 06:00 JST (21:00 UTC 前日)
 *
 * 処理内容:
 *   1. 楽天ランキング取得 (beauty / gadget / kitchen / life)
 *   2. Amazon商品取得 (amazon)
 *   3. DBに保存 (posts テーブル)
 *
 * 必要な環境変数 (GitHub Secrets):
 *   DATABASE_URL              - TiDB/MySQL 接続文字列
 *   RAKUTEN_APP_ID            - 楽天 Application ID
 *   RAKUTEN_ACCESS_KEY        - 楽天 Access Key
 *   BUILT_IN_FORGE_API_URL    - Manus ストレージ URL
 *   BUILT_IN_FORGE_API_KEY    - Manus ストレージ API キー
 */

import { config } from "dotenv";
config();

// 環境変数チェック
const REQUIRED_ENVS = ["DATABASE_URL", "RAKUTEN_APP_ID", "RAKUTEN_ACCESS_KEY"];
const missing = REQUIRED_ENVS.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`❌ 必要な環境変数が不足しています: ${missing.join(", ")}`);
  process.exit(1);
}

console.log("=".repeat(60));
console.log("[run_fetch] ランキング取得ジョブ開始");
console.log(`[run_fetch] 実行時刻: ${new Date().toISOString()}`);
console.log("=".repeat(60));

// 環境変数の確認
console.log("\n=== 環境変数確認 ===");
console.log("RAKUTEN_APP_ID:", process.env.RAKUTEN_APP_ID ? `設定済み (${process.env.RAKUTEN_APP_ID.slice(0, 8)}...)` : "未設定");
console.log("DATABASE_URL:", process.env.DATABASE_URL ? "設定済み" : "未設定");
console.log("NODE_ENV:", process.env.NODE_ENV || "未設定");
console.log("");

// NODE_ENV を production に設定（DRY RUN を解除）
process.env.NODE_ENV = "production";

try {
  console.log("\n[1/2] 楽天ランキング取得を実行中...");
  const { fetchRankingJob } = await import("./server/jobs/fetchRanking.ts");
  await fetchRankingJob();
  console.log("[1/2] ✅ 楽天ランキング取得完了");
} catch (err) {
  console.error("[1/2] ❌ 楽天ランキング取得エラー:", err.message);
  console.error(err.stack);
  process.exit(1);
}

try {
  console.log("\n[2/2] Amazon商品取得を実行中...");
  const { fetchAmazonJob } = await import("./server/jobs/fetchAmazon.ts");
  await fetchAmazonJob();
  console.log("[2/2] ✅ Amazon商品取得完了");
} catch (err) {
  console.error("[2/2] ❌ Amazon商品取得エラー:", err.message);
  console.error(err.stack);
  process.exit(1);
}

console.log("\n" + "=".repeat(60));
console.log("[run_fetch] ✅ 全ランキング取得完了");
console.log("=".repeat(60));
process.exit(0);
