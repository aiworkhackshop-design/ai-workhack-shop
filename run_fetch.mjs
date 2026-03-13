/**
 * fetchRankingジョブを即時実行するスクリプト
 * 使い方: node run_fetch.mjs
 */
import { config } from "dotenv";
config();

// 環境変数の確認
console.log("=== 環境変数確認 ===");
console.log("RAKUTEN_APP_ID:", process.env.RAKUTEN_APP_ID ? `設定済み (${process.env.RAKUTEN_APP_ID.slice(0, 8)}...)` : "未設定");
console.log("DATABASE_URL:", process.env.DATABASE_URL ? "設定済み" : "未設定");
console.log("");

// fetchRankingジョブを実行
const { fetchRankingJob } = await import("./server/jobs/fetchRanking.ts");

console.log("=== fetchRankingジョブ開始 ===");
await fetchRankingJob();
console.log("=== fetchRankingジョブ完了 ===");
process.exit(0);
