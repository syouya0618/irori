# irori — Flutter app

This is the Flutter migration of the irori family productivity app.
See [docs/plans/2026-05-27-flutter-migration-design.md](../docs/plans/2026-05-27-flutter-migration-design.md) for the full plan.

## Phase 0 セットアップ手順

### 1. SDK install (主の手元で)

[fvm](https://fvm.app/) を推奨 (Flutter version の project ローカル固定):

```bash
brew install fvm
fvm install 3.44.0
fvm use 3.44.0
```

asdf を使う場合:

```bash
asdf plugin add flutter
asdf install flutter 3.44.0
asdf local flutter 3.44.0
```

### 2. Dart and Flutter MCP Server を Claude Code に登録

[公式ドキュメント](https://docs.flutter.dev/ai/mcp-server) より:

```bash
claude mcp add --transport stdio dart -- dart mcp-server
```

これで Claude が widget tree introspection / `pub_dev_search` / `pubspec.yaml` 管理 / **Agentic Hot Reload** (Flutter 3.44+) を利用可能になる。

### 3. flutter project の初期化

Flutter project 構造の platform-specific ファイル (`web/`, `ios/`, `android/` 等) を生成:

```bash
cd /Users/suzukishouya/dev/personal/irori/flutter
flutter create --org com.example --project-name irori --platforms web .
```

`flutter create` は既存ファイル (pubspec.yaml / lib/ / test/) を上書きする可能性があるが、本ブランチでは:
- `lib/`, `test/`, `pubspec.yaml`, `analysis_options.yaml`, `.gitignore` は手書き版を保持
- `web/`, `.metadata`, README の差分のみ取り込む

実行後、差分を確認:

```bash
git status
git diff
```

`pubspec.yaml` が上書きされた場合は本リポジトリ版の dependencies を復元すること。

### 4. 依存解決 + 動作確認

```bash
fvm flutter pub get
fvm flutter analyze
fvm flutter test
fvm flutter run -d chrome   # ローカル browser で Hello World 確認
```

### 5. Production build (CanvasKit がデフォルト)

```bash
fvm flutter build web --release
```

出力先: `build/web/`

Flutter 3.44 では CanvasKit が default renderer であり、`--web-renderer canvaskit` フラグは廃止済み (`flutter build web` で自動選択)。WebAssembly + skwasm に切り替えるなら `--wasm` を付けるが、本プロジェクトでは Phase 4 後に再評価する。

### 6. Vercel deployment (新規 project)

1. Vercel Dashboard で新規 project 作成: `irori-flutter`
2. リポジトリ: `syouya0618/irori`
3. Root Directory: `flutter`
4. Framework Preset: `Other`
5. Build Command: `flutter build web --release --dart-define=SUPABASE_URL=$SUPABASE_URL --dart-define=SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY` (Flutter 3.44 では CanvasKit がデフォルト renderer)
6. Output Directory: `build/web`
7. Install Command: `(空欄)` または `dart pub global activate fvm && fvm install 3.44.0 && fvm flutter pub get`

または `vercel-flutter-build.sh` スクリプト経由で固定化することも可。

### 7. Supabase Auth に preview URL を許可

Supabase Dashboard → Auth → URL Configuration → Allowed Redirect URLs に
`https://irori-flutter-*.vercel.app/*` を wildcard 登録 (Section 7.2.1)。

### 8. CI workflow を手動で配置

⚠️ **重要**: 以下の YAML ファイルは PR #46 には含まれていない (Claude Code の PreToolUse security hook が `.github/workflows/*.yml` への書き込みを拒否するため)。**主が手動で `.github/workflows/flutter.yml` を作成し、以下の内容を貼り付ける必要がある**。配置後の `git add` + `git commit` も主の手作業じゃ。

`.github/workflows/flutter.yml` に以下を保存:

```yaml
name: Flutter CI

on:
  push:
    branches: [main]
    paths:
      - 'flutter/**'
      - '.github/workflows/flutter.yml'
  pull_request:
    paths:
      - 'flutter/**'
      - '.github/workflows/flutter.yml'

jobs:
  build:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: flutter

    steps:
      - uses: actions/checkout@v4

      - name: Set up Flutter
        uses: subosito/flutter-action@v2
        with:
          flutter-version: '3.44.0'
          channel: 'stable'
          cache: true

      - name: Show versions
        run: |
          flutter --version
          dart --version

      - name: Install dependencies
        run: flutter pub get

      - name: Verify formatting
        run: dart format --output=none --set-exit-if-changed .

      - name: Static analysis
        run: flutter analyze --fatal-infos

      - name: Run tests
        run: flutter test --reporter=expanded

      - name: Build web (CanvasKit default, no env defines)
        # SUPABASE_URL / ANON_KEY は CI では注入せず、main.dart の skip ロジックで
        # Hello World のみ build 可能であることを検証する。
        # Flutter 3.44 では CanvasKit が default renderer で `--web-renderer` フラグは廃止済み。
        run: flutter build web --release
```

セキュリティ注: 本 workflow に untrusted user input (issue title / PR body 等) は使用しておらぬ。固定の `run:` コマンドのみ。

## ディレクトリ構造

```
flutter/
├── lib/
│   ├── main.dart                          ← Entry point
│   ├── app/
│   │   └── router.dart                    ← GoRouter 設定
│   ├── core/
│   │   ├── supabase/
│   │   │   └── supabase_providers.dart    ← Riverpod 経由の Supabase DI
│   │   └── theme/
│   │       ├── colors.dart                ← Liquid Glass 色定義
│   │       ├── radii.dart                 ← Border radius 定数
│   │       ├── shadows.dart               ← Shadow 定義
│   │       └── app_theme.dart             ← Material 3 ThemeData
│   ├── features/
│   │   └── welcome/
│   │       └── welcome_page.dart          ← Phase 0 Hello World
│   └── widgets/
│       └── glass_card.dart                ← Liquid Glass 基本パーツ
├── test/
│   └── widget_test.dart                   ← GlassCard / WelcomePage 基本テスト
├── pubspec.yaml                           ← dependencies (supabase / riverpod / go_router / pdf / fl_chart / freezed)
├── analysis_options.yaml                  ← dart analyze 設定 (strict-casts 等)
├── .gitignore
└── README.md
```

Phase 1 以降は `lib/features/baby/`, `lib/features/meals/`, `lib/features/shopping/`, `lib/features/stock/` を追加していく (設計書 Section 6 参照)。

## トラブルシューティング

### `Supabase has not been initialized` エラー

main.dart は `SUPABASE_URL` / `SUPABASE_ANON_KEY` の env が空の場合 initialize を skip するので Phase 0 では発生しない設計。
Phase 1 で `supabaseClientProvider` を使う前に env を設定すること。

### CanvasKit renderer の初期ロードが遅い

[設計書 Section 7.1.1](../docs/plans/2026-05-27-flutter-migration-design.md#711-canvaskit-renderer-の初期-bundle-サイズ) 参照。
Service Worker による cache が初回以外を高速化する想定。
