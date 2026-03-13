import { config } from 'dotenv';
config();

console.log('=== 環境変数確認 ===');
console.log('FB_TOKEN:', process.env.FACEBOOK_PAGE_ACCESS_TOKEN ? '設定済み' : '未設定');
console.log('IG_ACCOUNT_ID:', process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || '未設定');
console.log('DATABASE_URL:', process.env.DATABASE_URL ? '設定済み' : '未設定');
console.log('');

const { postInstagramJob } = await import('./server/jobs/postInstagram.ts');

console.log('=== Instagram投稿ジョブ開始 (beautyカテゴリのみ) ===');
await postInstagramJob('beauty');
console.log('=== Instagram投稿ジョブ完了 ===');
process.exit(0);
