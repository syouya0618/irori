# うちのログ

夫婦の献立・買い物・在庫・育児ログをひとつにまとめる家庭運営PWA。

## 現在地

2026-04-27時点では、`main` は Phase 3.3 小児科用PDFエクスポートまで取り込み済み。作業ブランチ `codex/continue-work` では Phase 3.4 の育児ログ週間サマリーを実装中。

主な実装済み機能:

- 認証: Supabase magic link、callback、未認証リダイレクト、承認待ち画面
- 世帯管理: 世帯作成、招待リンク、招待受け入れ、ownerによる承認
- 献立: 週間表示、CRUD、食材、リアクション、テンプレート、外食記録、写真アップロード
- 買い物: 手動追加、献立から生成、カテゴリ/店舗別表示、購入チェック、Realtime、一括クリア
- 在庫: CRUD、期限アラート、購入履歴サジェスト、在庫から買い物追加、レシピ候補、Realtime
- 育児ログ: 授乳、おむつ、睡眠、体温、成長記録、メモ、授乳タイマー、覚醒時間、Realtime
- 設定: デフォルトページ、テーマ、在庫自動追加カテゴリ、赤ちゃん情報、PDFエクスポート

未実装の大きな塊:

- 買い物リストのオフライン対応
- Google Placesによる外食先検索
- PWA Push通知
- 成長曲線グラフ
- 予防接種、検診、アレルギー管理
- 家事分担レポート

## 技術スタック

- Next.js 16.2.2 App Router
- React 19.2
- TypeScript
- Tailwind CSS v4.2
- shadcn/ui + Liquid Glass design system
- Supabase Auth / Database / Storage / Realtime
- Vitest
- pdfmake

## 開発

```bash
pnpm install
pnpm dev
```

開発サーバ:

```text
http://localhost:3000
```

検証:

```bash
pnpm test:run
pnpm lint
pnpm exec tsc --noEmit
pnpm build
```

## 重要な注意

- Next.js 16では `middleware.ts` ではなく `proxy.ts` を使う。
- Next.js 16.2.2のTurbopack buildは現環境でcompile待ちになるため、`pnpm build` は `next build --webpack` 固定。
- Server Actionsは各route配下の `actions.ts` に置く。
- Supabase RLSは `FOR ALL` ではなく SELECT/INSERT/UPDATE/DELETE を分離する。
- `new Date("YYYY-MM-DD")` はUTC解釈の罠があるため、JST日付処理は `src/lib/utils/date-jst.ts` を使う。
- pdfmakeの `setFonts()` はモジュールスコープで1回だけ行う。

## 関連ドキュメント

- [要件定義](./requirements.md)
- [開発計画](./development-plan.md)
- [デザインシステム](./docs/DESIGN_SYSTEM.md)
- [Phase 3設計](./docs/plans/2026-04-10-phase3-design.md)
