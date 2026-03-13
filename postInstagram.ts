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
