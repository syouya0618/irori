# 締め出された時の手順（ログインできぬ）

> **急いでおるなら §1 だけ読め。** 理屈は §3 に置いてある。

## 1. まず何が起きておるか、画面が名指しする

ログイン画面に理由が出る。出た文言で分岐せよ。

| 画面に出る文言 | 何が起きておるか | すること |
|---|---|---|
| 「メールの送信回数が上限に達しました」 | **これが最も多い。** Supabase 組込みメールは**1時間に2通**しか送れぬ | §2 の逃げ道を使う（待たずに入れる） |
| 「リンクの有効期限が切れています」 | リンクは一度きり・既定 1 時間 | 新しく送る。ただし上の上限を消費する |
| 「別のブラウザで開いています」 | 送信したブラウザと違う所で開いた（PKCE の検証子はそのブラウザにしかない） | **送信を押したのと同じアプリ**で開く。§2 の逃げ道はこの制約を受けぬ |
| 「送信に失敗しました（〇〇）」 | 括弧の中が Supabase の error code | その code をそのまま調べる |

## 2. メールを使わずに入れる（逃げ道）

**メールを 1 通も消費せぬ。** サービスロールキーを持つ者（世帯の管理者）が手元で実行する。

```bash
node scripts/generate-login-link.mjs 相手のメールアドレス
```

- 標準出力に **URL が 1 行**だけ出る。それを LINE 等で本人へ直接渡す
- 本人はそれを**どのブラウザで開いてもよい**（PKCE の制約を受けぬ）
- 開けばログインが完了し、`/` から設定どおりのページへ着く

⚠️ **この URL は使い切りの資格情報じゃ。** 持つ者は誰でもそのアカウントとして
ログインできる。本人へ直接渡し、使うまでは秘密として扱うこと。一度使うか期限が
切れれば無効になる。

### 鍵の用意

本番の値が要る。**`.env.local` を潰してはならぬ** —— あれはローカル開発用
（ローカル Supabase を指す）で、上書きすると開発環境が壊れる。

```bash
vercel env pull .env.production.local --environment=production
```

スクリプトは `.env.production.local` → `.env.local` の順で探す（`--env <path>`
で明示もできる）。**本番用を先に見る**のは、ローカルの値で作った
「本番では通らぬのに成功に見えるリンク」を出さぬためじゃ。

⚠️ **`--environment=production` を省くな。** 既定は `development` で、そこには
env が 1 本も入っておらぬ ——`vercel env pull .env.local` を素で打つと
**既存の 3 本が消えて `VERCEL_OIDC_TOKEN` だけになる**（2026-08-10 に実際にやった）。

### `.env.local` を壊してしもうた時の復旧

ローカル開発用の値はローカル Supabase から作り直せる:

```bash
{ echo 'NEXT_PUBLIC_APP_URL=http://localhost:3000'
  supabase status -o env | sed -n \
    's/^API_URL=/NEXT_PUBLIC_SUPABASE_URL=/p;
     s/^ANON_KEY=/NEXT_PUBLIC_SUPABASE_ANON_KEY=/p;
     s/^SERVICE_ROLE_KEY=/SUPABASE_SERVICE_ROLE_KEY=/p' | tr -d '"'
} > .env.local
```

（`supabase start` が動いておることが前提。e2e 用は `.env.e2e` で別物ゆえ無関係。）

## 3. なぜ締め出しが起きたか（2026-08-10 の記録）

二つの欠陥が噛み合った。

```
① proxy が redirect で更新済みトークンを捨てる  →  無言でログアウト   [#223 で修正]
                                                        ↓
② Supabase 組込みメールは 1時間に2通しか送れぬ  →  戻れない          [設定・未対応]
```

②は公式にこうある —— *"2 emails per hour with the built-in email provider"* /
*"You can only change this with a custom SMTP setup."*
（<https://supabase.com/docs/guides/auth/rate-limits>）

**恒久策は独自 SMTP を入れること**じゃ。入れれば上限を上げられる。

- SMTP 設定: `https://supabase.com/dashboard/project/<ref>/auth/smtp`
- 上限の変更: `https://supabase.com/dashboard/project/<ref>/auth/rate-limits`

入れぬ判断をしておる間は、§2 の逃げ道が唯一の確実な入口じゃ。

## 4. やってはならぬこと

- **失敗しても押し直さぬ。** 上限は「送れた通数」で数えるが、無駄打ちは
  成功した時に上限を食う。二人で押し合えば即座に尽きる
- **特定アドレスだけ認証を迂回する裏口を作らぬ。** このリポジトリは公開ゆえ、
  その裏口は誰の目にも見える。承認ゲート（proxy + `getAuthContext` の二層）と
  RLS が「公開インスタンス × 家族専用」を成り立たせておる唯一の根拠じゃ
