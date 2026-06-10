# コントリビューションガイド

irori への貢献に興味を持っていただきありがとうございます。バグ報告・機能提案・Pull Request いずれも歓迎します。

## 前提ツール

- Node.js 24 推奨（`.nvmrc` 参照。CI も Node 24 で実行）
- pnpm 10 以上（`corepack enable` で有効化できます）
- Supabase アカウント / プロジェクト（または Supabase CLI でのローカル起動）
- Flutter SDK（Flutter 版を触る場合のみ）

## セットアップ

1. リポジトリを fork して clone する
2. 依存をインストール: `pnpm install`
3. 環境変数を設定: `cp env.example .env.local` してから値を記入する
4. Supabase スキーマを適用する:
   - **ローカルスタック**: `supabase start`（`supabase/config.toml` と `supabase/migrations/` を反映）
   - **リモートプロジェクト**: `supabase link --project-ref <project-ref>` の後 `supabase db push`
5. 開発サーバを起動: `pnpm dev` → http://localhost:3000

### Flutter（任意）

```bash
cd flutter
flutter pub get
flutter run \
  --dart-define=SUPABASE_URL=https://your-project.supabase.co \
  --dart-define=SUPABASE_ANON_KEY=your-anon-key
```

## ブランチとコミット

- `main` への直接コミットは禁止です。必ず feature ブランチで作業し、Pull Request を作成してください。
- ブランチ名の例: `feat/...`, `fix/...`, `chore/...`, `docs/...`
- コミットメッセージは [Conventional Commits](https://www.conventionalcommits.org/ja/) を推奨します（`feat(scope): ...` / `fix(scope): ...` など）。
- 1 つの Pull Request は 1 つの関心事に絞ってください。

## 提出前チェック

Pull Request を出す前に、以下がすべて通ることを確認してください:

```bash
pnpm test:run          # テスト
pnpm lint              # ESLint
pnpm exec tsc --noEmit # 型チェック
pnpm build             # ビルド
```

## E2E テスト（Playwright）

ローカルの Supabase スタック（Docker 必須）に対して Playwright の E2E テストを実行できます。
認証はメール OTP（マジックリンク）の実経路を使い、メールは Mailpit（ポート 54324）から取得します。

```bash
supabase start   # ローカル Supabase スタックを起動（Docker が必要）
pnpm e2e:env     # supabase status から .env.e2e を生成
pnpm e2e:build   # .env.e2e の値で Next.js を本番ビルド（.env.local は変更されません）
pnpm e2e         # Playwright テストを実行（next start は Playwright が自動起動）
```

補足:

- 初回は `pnpm exec playwright install chromium` でブラウザのインストールが必要です。
- `pnpm e2e:ui`（UI モード）/ `pnpm e2e:headed`（ブラウザ表示）も使えます。
- ベース URL は `http://127.0.0.1:3000` 固定です（GoTrue の `site_url` と一致させるため、`localhost` は使いません）。
- E2E 用ビルドは `.next/` を上書きします。通常の開発に戻る場合は `pnpm dev` をそのまま使えます。
- CI では `.github/workflows/e2e.yml` が同じ手順を実行します。

## コーディング規約

- デザイン指針は [`docs/DESIGN_SYSTEM.md`](./docs/DESIGN_SYSTEM.md) を参照してください。
- Supabase RLS は `FOR ALL` を使わず、SELECT / INSERT / UPDATE / DELETE を分離します。
- Next.js 16 ではミドルウェアに `middleware.ts` ではなく `proxy.ts` を使います。
- `new Date("YYYY-MM-DD")` は UTC 解釈の罠があるため、JST 日付処理は `src/lib/utils/date-jst.ts` を使います。
- その他の注意点は [README](./README.md) の「重要な注意」節にまとまっています。

## 行動規範

本プロジェクトへの参加にあたっては [行動規範](./CODE_OF_CONDUCT.md) の遵守をお願いします。

## ライセンス

貢献いただいたコードは、本プロジェクトと同じ [MIT License](./LICENSE) の下で公開されることに同意したものとみなされます。
