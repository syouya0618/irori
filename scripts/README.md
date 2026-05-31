# scripts/

irori プロジェクトの開発・運用支援スクリプト集。

---

## verify-flutter-readiness.sh

Phase 1 (Flutter Auth UI / Issue #48) 着手前のブロッカーを Vercel / Supabase API で自動検証するスクリプト。

### 検証項目

| ID | 内容 |
|---|---|
| **R1** | Vercel `irori-flutter` project の Build Command に `--dart-define=SUPABASE_URL` / `--dart-define=SUPABASE_ANON_KEY` 両方設定済か |
| **R2** | 同 project の env に `SUPABASE_URL` / `SUPABASE_ANON_KEY` が全 environment (Production/Preview/Development) で登録済か |
| **R3** | Supabase Auth Allowed Redirect URLs に `irori-flutter-*` 関連 URL が登録済か |

### 使用法

#### 1. Token 発行

| Token | 発行先 | 必要スコープ |
|---|---|---|
| `VERCEL_TOKEN` | https://vercel.com/account/tokens | Full Account (team 配下 projects 読み取り) |
| `SUPABASE_ACCESS_TOKEN` | https://supabase.com/dashboard/account/tokens | 全 organizations 読み取り |

#### 2. `.env.local` に token を記入

repo root に **`.env.local`** を作成 (`.gitignore` 済み — 値は絶対にコミットしないこと):

```bash
# .env.local (repo root) - GITIGNORED, never commit
VERCEL_TOKEN=<your_vercel_token>
SUPABASE_ACCESS_TOKEN=<your_supabase_token>

# 以下はデフォルト値。変更したい場合のみ記入。
SUPABASE_PROJECT_REF=rkzbpoeiiiptqptkxdyi
VERCEL_TEAM_ID=team_agIHQOjUiDPI6tLSjdQRdXce
FLUTTER_PROJECT_NAME=irori-flutter
```

#### 3. 実行

```bash
bash scripts/verify-flutter-readiness.sh
```

### 終了コード

各項目 (R1/R2/R3) は tri-state (`OK` / `BLOCKER` / `UNVERIFIED`) で判定し、優先順位 **BLOCKER > UNVERIFIED > OK** で総合終了コードを決める。

| Code | 状態 | 意味 |
|---|---|---|
| `0` | ✅ | 全項目 OK (Phase 1 着手可能) |
| `1` | ❌ | 未解消ブロッカーあり (1 つ以上 BLOCKER: Vercel project 不在 / env 未登録 / Redirect URL 未登録 等) |
| `2` | ❓ | 検証不可 (BLOCKER は無いが 1 つ以上 UNVERIFIED: token 未設定 / 401・403 / 通信失敗 / JSON パース失敗 等) |

> ★ 401/403 や通信失敗・タイムアウトは **UNVERIFIED** (検証できなかった) であって BLOCKER ではない。「検証できないことは断言しない」原則に従い、`❌ 欠落` と誤報告しない。BLOCKER と UNVERIFIED が混在した場合も、各項目の状態は「項目別状態」セクションに個別表示されるため情報は失われない。

### Claude Code から呼ぶ場合

Claude も同じスクリプトを `Bash` tool で実行可能。`.env.local` が設定されていれば、ユーザーが「Phase 1 ready?」と聞いた際に自動で R1-R3 を確認して報告する。

### セキュリティ

- ⚠️ `.env.local` は **絶対にコミット禁止** (`.gitignore` で自動除外)
- ⚠️ token 値はスクリプト出力には含めない (script 内で `Authorization: Bearer` ヘッダにのみ使用)
- ⚠️ token 漏洩時は即時 revoke (Vercel: https://vercel.com/account/tokens, Supabase: https://supabase.com/dashboard/account/tokens)

### トラブルシューティング

| 症状 | 原因 | 対処 |
|---|---|---|
| `❓ VERCEL_TOKEN 未設定` | `.env.local` に値なし | token 発行 → `.env.local` 記入 |
| `Vercel project 不在` | `irori-flutter` 未作成 | `flutter/README.md` Section 6 の手順で作成 |
| `❓ ... 取得 失敗 (HTTP 401/403)` | token 無効 / scope 不足 (→ UNVERIFIED) | token 再発行 (Full account 推奨) |
| `❓ ... 取得 失敗 (HTTP 000)` | 通信失敗・タイムアウト (→ UNVERIFIED) | ネットワーク確認 → 再実行 |
| `irori-flutter 関連 URL 未登録` | Supabase Dashboard で未追加 | `https://irori-flutter-*.vercel.app/*` を追加 |

---

## check-supabase-error-destructure.py

(既存) Supabase エラーオブジェクトの destructure チェック。詳細はスクリプト先頭の docstring を参照。
