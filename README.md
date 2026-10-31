# うちのログ（irori）

夫婦の育児記録と予定をひとつにまとめる家庭運営 PWA。

> 「irori」はリポジトリ／プロジェクトのコードネーム、「うちのログ」はアプリ名です。

## 現在地

`main`（Next.js 版）は、育児ログ・予定・設定の主要機能を実装済みです。育児ログは授乳タイマーや週間サマリーまで含みます。起動時は育児ページ（`/baby`）が開き（設定で予定に変更可）、ボトムナビは 育児 / 予定 / 設定 の 3 タブです。

> かつて `flutter/` 配下に Flutter 版の移行を並行して進めていましたが、DB スキーマへの未追随が積み上がり維持コストが上回ったため 2026-07-31 に廃止しました。コードは git 履歴から復元できます。
> また、献立・買い物・在庫（レシート OCR 含む）の各機能は 2026-09 に廃止しました。こちらも git 履歴から復元できます。

主な実装済み機能:

- 認証: Supabase magic link、callback、未認証リダイレクト、承認待ち画面
- 世帯管理: 世帯作成、招待リンク、招待受け入れ、運用者による承認（`docs/runbooks/approvals.md`）
- 育児ログ: 授乳、おむつ、体温、成長記録（身長・体重の推移グラフ）、メモ、日記、授乳タイマー（閉じても計測が続く）、週間サマリー、記録者の表示、日付へ移動、全履歴の検索（`/baby/search`）、過去日の追記と日時の修正、Realtime
- 予定: 共有カレンダー（月表示・アジェンダ・繰り返し）、Google カレンダー連携（読み取り同期）、Web Push 通知（予定リマインダー・毎朝のまとめ）、「今日・明日の予定」カード
- 設定: 起動時のページ、テーマ、赤ちゃん情報、通知、Google 連携、エクスポート（小児科用 PDF / 機械可読な JSON）

未実装の大きな塊:

- 成長曲線のパーセンタイル帯（標準曲線との比較。測定値の推移グラフ自体は実装済み）
- 予防接種、検診、アレルギー管理
- 家事分担レポート

## 技術スタック

### Web（Next.js）

- Next.js 16.4.3 App Router
- React 19.2
- TypeScript
- Tailwind CSS v4
- shadcn/ui + Liquid Glass design system
- Supabase Auth / Database / Realtime（Storage は 2026-09 の機能廃止以降使っていない）
- Vitest
- pdfmake

## セットアップ

詳細な手順とコントリビューション方法は [CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。

```bash
pnpm install
cp env.example .env.local   # 値を記入する
supabase start               # ローカルスタック（または supabase db push でリモートへ）
pnpm dev                     # http://localhost:3000
```

検証（CI `.github/workflows/ci.yml` と同じ順）:

```bash
pnpm lint
pnpm exec tsc --noEmit
pnpm test:run
pnpm build | tee /tmp/next-build.log
# 静的検出器（いずれも --strict。CI と同じ引数）
./scripts/check-proxy-effective.py --strict --build-log /tmp/next-build.log
./scripts/check-supabase-error-destructure.py --strict
./scripts/check-transition-reject-guard.py --strict
./scripts/check-transition-all.py --strict
# DB と実ブラウザ（Docker が必要。CI では e2e.yml が実行する）
supabase start && supabase test db
pnpm e2e:env && pnpm e2e:build && pnpm e2e
```

## 重要な注意

- Next.js 16では `middleware.ts` ではなく `proxy.ts` を使う。
- `pnpm build` は Turbopack で行う（Issue #17: 16.2.2 で発生した compile 待ちが 16.2.6 で解消し、`--webpack` 固定を解除した）。
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
- 運用 runbook: [承認](./docs/runbooks/approvals.md) / [通知 cron](./docs/runbooks/notify-cron.md) / [締め出し時のログイン](./docs/runbooks/locked-out.md)
- [本番品質化の監査と台帳（2026-10）](./docs/plans/production-readiness-2026-10.md)

## 製品拡張の初期構築

複数児、子ども別の閲覧共有、睡眠、予防接種・健診、成長基準帯、世帯の独自項目、年齢別ホーム、任意の地域ニュースを同じNext.js / pnpm / Supabase構成で使えます。追加のクラウド契約・AI APIは不要です。

専用のローカルSupabaseを起動できる環境では `supabase start` → `supabase db reset` でmigrationを一括適用します。`db reset` はローカルの使い捨て環境専用です。既存環境への適用はバックアップを確認してmigration履歴に一度ずつ追加し、SQLを手作業で再実行しないでください。既存1児データの移行・アプリの戻し方は [拡張計画](docs/plans/product-expansion.md) を参照してください。

地域ニュースは `/news` で任意設定。初期対応は公式RSSを確認済みの札幌市・横浜市です。取得と朝8時の通知は [既存の通知cron](docs/runbooks/notify-cron.md) を再利用します。Push環境変数が未設定なら通知を実行しません。地域未設定では配信元への取得を行いません。対応地域以外の住所入力・位置情報・外部AIは使いません。

機能テストは合成データだけで行います。`pnpm test:run` と `supabase test db`、専用の合成Supabaseを用意したうえで `pnpm e2e` を実行してください。環境制限で実行できない項目は未実行として扱います。成長統計の出典・加工内容・利用条件は [第三者データ](THIRD_PARTY_DATA.md) に記載しています。
