# Changelog

このプロジェクトの注目すべき変更を記録します。

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に基づき、
[Semantic Versioning](https://semver.org/lang/ja/) に準拠します。

## [Unreleased]

### Added
- 育児: 月齢ヘッダに暦上の月齢（生後1ヶ月27日）と通算日数（生後58日）を並べて表示。応当日の無い月は末日で満了（1/31 生まれは 2/28 に 1ヶ月）
- 育児: うんちの量（少量 / 大量）を記録・編集・表示（`baby_logs.poop_amount`）。クイック記録は うんち / 両方 のタップ後に量を選ぶ 2 段目（指定なし で従来どおり量なし）。既存行は量なしのまま
- 育児: 母乳サイクルの開始側（左から / 右から）を記録・編集・表示（`baby_logs.breast_start_side`）。タイマーはタップした側で確定、手動入力は選択、既存行は不明のまま
- OSS（MIT）公開に向けたリポジトリ整備: `LICENSE`、`SECURITY.md`、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、Issue / PR テンプレート
- 同梱フォント Noto Sans JP のライセンス `fonts/OFL.txt`（SIL Open Font License 1.1）
- Dependabot 設定（npm / pub / github-actions、minor・patch を grouped 化）
- `.editorconfig` / `.nvmrc` / `.github/CODEOWNERS`
- `package.json` に `license` / `repository` 等のメタデータ

### Changed
- 起動時のページの選択肢を 育児 / 予定 へ（既定は 育児）。既存の `meals` / `shopping` / `stock` 設定は migration で `baby` へ寄せる
- 「今日・明日の予定」カードを `/baby` へ移設
- ボトムナビを 3 タブ（育児 / 予定 / 設定）へ
- README を現状（baby 機能 land 済み・Flutter 移行 Phase 1）に更新し、ライセンス / コントリビューション節を追加

### Removed
- 献立・買い物・在庫・レシート OCR 機能（画面・Server Action・ドメイン・依存 tesseract.js / react-day-picker・SW の precache 対象）
- 個人的な内容を含む要件・計画メモ（`requirements.md` / `development-plan.md`）。純粋な技術設計は `docs/plans/` に残しています。

[Unreleased]: https://github.com/syouya0618/irori/commits/main
