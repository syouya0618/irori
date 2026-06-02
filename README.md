# うちのログ（irori）

夫婦の献立・買い物・在庫・育児ログをひとつにまとめる家庭運営 PWA。

> 「irori」はリポジトリ／プロジェクトのコードネーム、「うちのログ」はアプリ名です。

## 現在地

`main`（Next.js 版）は、献立・買い物・在庫・育児ログの主要機能を実装済みです。育児ログは授乳タイマーや週間サマリーまで含みます。

並行して Flutter 版（`flutter/`）への移行を進めており、現在は Phase 1（認証・ルーティング・育児ログ）まで実装済みです。

主な実装済み機能:

- 認証: Supabase magic link、callback、未認証リダイレクト、承認待ち画面
- 世帯管理: 世帯作成、招待リンク、招待受け入れ、ownerによる承認
- 献立: 週間表示、CRUD、食材、リアクション、テンプレート、外食記録、写真アップロード
- 買い物: 手動追加、献立から生成、カテゴリ/店舗別表示、購入チェック、Realtime、一括クリア
- 在庫: CRUD、期限アラート、購入履歴サジェスト、在庫から買い物追加、レシピ候補、Realtime
- 育児ログ: 授乳、おむつ、睡眠、体温、成長記録、メモ、授乳タイマー、覚醒時間、週間サマリー、Realtime
- 設定: デフォルトページ、テーマ、在庫自動追加カテゴリ、赤ちゃん情報、PDFエクスポート

未実装の大きな塊:

- 買い物リストのオフライン対応
- Google Placesによる外食先検索
- PWA Push通知
- 成長曲線グラフ
- 予防接種、検診、アレルギー管理
- 家事分担レポート

## 技術スタック

### Web（Next.js）

- Next.js 16.2.6 App Router
- React 19.2
- TypeScript
- Tailwind CSS v4.2
- shadcn/ui + Liquid Glass design system
- Supabase Auth / Database / Storage / Realtime
- Vitest
- pdfmake

### Mobile（Flutter・移行中）

- Flutter / Dart
- Riverpod + freezed
- Supabase Flutter SDK

## セットアップ

詳細な手順とコントリビューション方法は [CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。

```bash
pnpm install
cp env.example .env.local   # 値を記入する
supabase start               # ローカルスタック（または supabase db push でリモートへ）
pnpm dev                     # http://localhost:3000
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
- `pnpm build` は Next.js 16.2.6 で Turbopack build retest 済み（Issue #17）。16.2.2 で発生した compile 待ちが解消されたため `--webpack` 固定を解除した。
- Server Actionsは各route配下の `actions.ts` に置く。
- Supabase RLSは `FOR ALL` ではなく SELECT/INSERT/UPDATE/DELETE を分離する。
- `new Date("YYYY-MM-DD")` はUTC解釈の罠があるため、JST日付処理は `src/lib/utils/date-jst.ts` を使う。
- pdfmakeの `setFonts()` はモジュールスコープで1回だけ行う。

## コントリビューション

- [コントリビューションガイド](./CONTRIBUTING.md)
- [行動規範](./CODE_OF_CONDUCT.md)
- [セキュリティポリシー](./SECURITY.md)

## ライセンス

本プロジェクトは [MIT License](./LICENSE) の下で公開されています。

同梱フォント Noto Sans JP（`fonts/`）は [SIL Open Font License 1.1](./fonts/OFL.txt) の下で配布されています。

## 関連ドキュメント

- [デザインシステム](./docs/DESIGN_SYSTEM.md)
