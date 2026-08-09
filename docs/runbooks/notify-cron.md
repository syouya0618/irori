# 通知配信 cron の登録手順（pg_cron → `/api/cron/notify`）

**これは手順書であって migration ではない。** そう決めた理由から書く。

## なぜ migration にせぬのか

登録に要る URL と secret は **Supabase Vault** に置く。このリポジトリは公開ゆえ
ベタ書きできぬ。そして Vault の秘密は**ローカルにも CI にも存在せぬ**ため、
`vault.decrypted_secrets` を参照する migration を書くと `supabase db reset` では
必ず「秘密が無い」経路を通る。pgTAP でそれを検証しても、緑でも赤でも本番の姿を
何も語らぬ — **意味を持たぬテスト**が増えるだけじゃ。ゆえに Dashboard での手作業に
し、その代わり手順をここへ全部書く。

## 全体像

```
Supabase (pg_cron, 5 分ごと)
  └─ net.http_get → https://<本番ドメイン>/api/cron/notify
       Authorization: Bearer <NOTIFY_CRON_SECRET>
         └─ Vercel Function (nodejs, maxDuration 60)
              └─ deliverDueNotifications()  … 展開 → claim → 送信 → 心拍
```

**毎朝のまとめ（B-5）も、この 1 本に相乗りしておる。** 別の cron を足してはならぬ:
まとめは「その JST 暦日ぶんのキュー行を先に立て、`scheduled_at <= now()` で拾う」形
ゆえ、予定通知と**同じ展開・同じ grace・同じ重複排除**に乗る。別経路にすれば、
取りこぼしの拾い直しと二重通知の防止をもう一組作ることになる。
ゆえにこの手順書が 1 本を守れば、まとめの配信も守られる。

⚠️ **`net.http_post` ではない。** ハンドラは `GET` だけを export しておる
（Vercel Cron が GET を送るため。`google-sync` も同じ形）。Next.js の Route Handler は
**export しておらぬメソッドに 405 を返す** — 実測: `POST /api/cron/notify` = **405**、
`GET` = 401（secret 無し）。405 はハンドラの手前で返るゆえ、
**認可ログすら出ぬ**。そして後述のとおり `cron.job_run_details` は
それでも `succeeded` と記録する。**pg_net の既定に素直に従って POST で登録すると、
通知は 1 通も出ぬまま全ての監視が緑になる。**

**Vercel の cron ではない。** Hobby プランの cron は 1 日 1 回までで、5 分ごとの
式はデプロイ自体が失敗する（`google-sync` が 1 日 1 回なのはそれゆえ）。
「10 分前に通知」を守るには 5 分粒度が要るため、Supabase 側から叩く。

---

## 手順

### 0. 順序が命じゃ（**先に env、後で schedule**）

pg_cron の schedule は登録した瞬間から動き出す。秘密が入る前に発火すると、
`net.http_get` は空の Authorization を送り、**401 が延々と積もる**（しかも
`cron.job_run_details` は "succeeded" と記録する。後述）。必ずこの順で:

1. Vercel に `NOTIFY_CRON_SECRET` を入れて**再デプロイ**する
2. Supabase Vault に URL と secret を入れる
3. schedule を登録する

### 1. secret を作って Vercel へ

```bash
# 32 バイトの乱数（google-sync の CRON_SECRET とは**必ず別値**にすること）
openssl rand -base64 32

vercel env add NOTIFY_CRON_SECRET production
```

⚠️ **`vercel env add` は自動で再デプロイせぬ。** 入れただけでは動いておる
Function に新しい env は載らぬ。必ず再デプロイして、反映を確かめてから次へ進むこと。

⚠️ **`CRON_SECRET` を使い回すな。** pg_net は Authorization ヘッダを
`net.http_request_queue` に保存する（応答も `net._http_response` に残る）。
つまり **Dashboard の SQL Editor から読める場所に秘密が滞留する**。同じ値を使えば、
その滞留 1 つで google-sync の cron も同時に開く。

### 2. Vault へ URL と secret を入れる

Dashboard → Project Settings → Vault → Add new secret。

| Name | Secret |
|---|---|
| `notify_cron_url` | `https://<本番ドメイン>/api/cron/notify` |
| `notify_cron_secret` | 手順 1 で作った値 |

### 3. 拡張を有効化する

Dashboard → Database → Extensions で `pg_cron` と `pg_net` を有効にする
（`pg_net` は `extensions` スキーマに入る）。

### 4. schedule を登録する（SQL Editor）

```sql
select cron.schedule(
  'notify-deliveries',
  '*/5 * * * *',                      -- 5 分ごと
  $$
  select net.http_get(
    url     := (select decrypted_secret from vault.decrypted_secrets
                 where name = 'notify_cron_url'),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret
                                       from vault.decrypted_secrets
                                      where name = 'notify_cron_secret')
    ),
    timeout_milliseconds := 5000
  );
  $$
);
```

**`net.http_get` である理由**: 上に書いたとおりハンドラは GET のみ。
`net.http_post` に書き換えると **405 が返って通知が全滅する**（実測済み）。
この 1 行が食い違うことを機械で止めるため、
`src/app/api/cron/notify/__tests__/runbook-contract.test.ts` が
**この手順書の SQL とハンドラの export を突き合わせておる**。手順書の verb を
変えるなら、先にハンドラへその export を足すこと。

**`*/5 * * * *`（5 分粒度）である理由**: 毎分にすると `cron.job_run_details` が
1 日 1440 行たまる。Free tier の 500MB を通知の記録で食い潰すのは割に合わぬ。
5 分なら 288 行/日で、grace window（15 分）は取りこぼし 2 回ぶんを吸収できる。

**`timeout_milliseconds := 5000` を必ず明示する**: 既定値は pg_net の版で違う
（手元の 0.20.3 は 5000ms じゃが、古い版は 2000ms じゃった）。Vercel の
コールドスタートに 2 秒は短すぎ、既定に任せると朝いちばん（＝一番通知が要る時刻）の
実行だけが恒常的に落ちる。**我々の管理外の既定値に賭けず、明示的に書け。**

### 5. `cron.job_run_details` の掃除ジョブも登録する

公式が「自動削除されない」と明記しておる。放置すれば無限に積もる。

```sql
select cron.schedule(
  'purge-cron-history',
  '0 3 * * *',                        -- JST 12:00（UTC 03:00）
  $$ delete from cron.job_run_details where end_time < now() - interval '7 days' $$
);
```

---

## 監視 — ⚠️ `cron.job_run_details` は**配達を監視せぬ**

これが一番の落とし穴じゃ。pg_net の `net.http_get` / `net.http_post` は
**request_id を即座に返して終わる**。
HTTP のやり取りが始まるのはトランザクションが commit された後ゆえ、
**HTTP が 500 でも 401 でも接続不能でも、`cron.job_run_details` には `succeeded` が
記録される**。ここだけを見ておると「毎回成功しておるのに通知が来ぬ」になる。

配達を見るのは `net._http_response` じゃ（**保持 6 時間・unlogged テーブル**）。

```sql
-- 直近の応答（status_code を見る。401 なら secret、5xx ならアプリ側）
select id, status_code, error_msg, created
  from net._http_response
 order by created desc
 limit 20;
```

アプリ側の真実は 2 つ:

```sql
-- 心拍: 「走ったこと」そのもの。ran_at が 10 分以上前なら止まっておる
select * from notification_heartbeat;

-- 最終配信: 送るものが無かった日も進まぬゆえ、心拍と**両方**見ること
select max(sent_at) from notification_deliveries;
```

⚠️ **`sent_at` は「送信を試みて claim した瞬間」であって「端末が受け取った瞬間」
ではない。** 送信が status を返さずに失敗したとき（ソケットタイムアウト等）、
その 1 通は **at-most-once の割り切りで落とし、`sent_at` は立ったまま残す** ——
届いたか分からぬものを再送すれば二度鳴り、Safari は可視通知の雪崩で権限そのものを
剥奪するゆえじゃ（`send-push.ts` の `isProvenNotDelivered`）。ゆえに
「`max(sent_at)` は新しいのに端末へ来ておらぬ」は起こりうる。そのときは同じ実行の
`failed_count` が 1 以上になっておるはずゆえ、**この 2 つを対で読め**（下の ① と
同じ作法じゃ）。Vercel のログには
`送信の結果が不明ゆえ再送せぬ` が残る。

心拍の読み方に 2 つ約束がある。

**① `ran_at` の鮮度だけを見るな。`failed_count` と対で読め。**
配信基盤が全面停止しても（例: PostgREST 障害や policy 変化で対象世帯の列挙 SELECT が
恒常的に失敗する）、心拍は `finally` が必ず書くゆえ `ran_at` は 5 分ごとに新しくなる。
このとき `deliverDueNotifications` は**完走しておらぬ**ため `failed_count >= 1` になる
（`ran_at` だけが新しく `sent=skipped=failed=0` という組み合わせは「送るものが
無かった」＝平穏の意味じゃ）。**両者は次の 3 通りで読み分ける**:

| ran_at | failed_count | 意味 |
|---|---|---|
| 新しい | 0 | 平穏（送るものが無かった、または全部送れた） |
| 新しい | 1 以上 | **走ってはおるが壊れておる**（`net._http_response` と Vercel のログを見よ） |
| 10 分以上前 | — | 起動しておらぬ（pg_cron / secret / proxy を疑う） |

**② `ran_at` は「最後に *終わった* 実行の開始時刻」じゃ。**
書込は無条件の upsert（last-writer-wins）ゆえ、cron の重複起動が重なると
**遅い実行が後から古い `ran_at` を書き戻しうる**（巻き戻り幅は最大で 1 回の実行時間
＝ `maxDuration` の 60 秒ぶん。上の 10 分の閾値には届かぬ）。ゆえに `ran_at` は
「最近何かが走ったか」を見る値であって、実行の開始時刻を厳密に追う値ではない。
同じ理由で `failed_count` も**最後に終わった実行のもの**ゆえ、重複起動下では
壊れた実行の 1 が平穏な実行の 0 に上書きされうる。連続 2 回の観測で判断せよ。

`skip_reason` の内訳を見れば、壊れ方の種類が分かる:

| 値 | 意味 |
|---|---|
| `expired` | grace（15 分）を過ぎた。cron が止まっておった証拠 |
| `event_started` | 予定が始まってしまった。catch-up の正常な振る舞い |
| `gone` | 端末の購読が失効した（410/404）。購読は削除済み |
| `rescheduled` | 指しておった通知設定・予定が消えたか、日を跨いで動いた |

---

## 購読の失効と自己修復（B-4）

「通知が来ぬ」の半分は cron ではなく**購読側**が死んでおる。3 つの経路で守る。

**① 削除は 410 / 404 だけ。**
`src/lib/notifications/send-push.ts` の `PUSH_GONE_STATUSES` が唯一の判定源じゃ。
401 / 403 / 429 / 5xx は**消さず再試行へ回す** — 4xx を一括で恒久扱いにすると、
VAPID の設定ミス 1 つで全端末の購読が消し飛び、復旧には各端末での再登録が要る
（「再試行は広く、破棄は狭く」）。集合そのものは `send-push.test.ts` が
100..599 を総なめして、`deliver.test.ts` が 400..599 を配信層まで通して固定する。

**② ブラウザが購読を回したら SW が拾う。**
Chrome / Android は都合で購読を差し替える。`public/sw.js` の
`pushsubscriptionchange` が新しい購読を `POST /api/push/resubscribe` へ送り直す。
このパスは**セッション認証**ゆえ `isPublicRoute` へ足してはならぬ
（足すと `auth.uid()` が NULL になり `upsert_push_subscription` が 28000 で落ちる）。
機械検査は `src/app/api/push/resubscribe/__tests__/route.test.ts` が持つ。

**③ アプリ起動時に突き合わせる。**
`PushSubscriptionReconciler`（`(main)/layout.tsx`）が、ブラウザに購読が在れば
同じ route を冪等に叩く。410 で消した行はここで生き返る。
⚠️ `upsert_push_subscription` は再購読を「復帰」と見なして `failure_count` を
0 に畳む設計ゆえ、**アプリを開くたびに端末ごとの失敗カウントが一度リセットされる**。
cron は 5 分ごとに回るゆえ本当に壊れておる端末なら数分で戻るが、
設定カードの `送信エラー N回` が 0 に見えても「直った」とは限らぬ。
判断は `最終エラー`（`last_failure_at`）と併せて行うこと。

### 画面から見る

主が SQL を打たずとも、`/settings` の通知カードに同じ 2 つが出ておる:

| 表示 | 対応する値 |
|---|---|
| 最終実行 | `notification_heartbeat.ran_at`（10 分以上前なら「動いていません」と出る） |
| 最終配信 | 世帯の `MAX(notification_deliveries.sent_at)` |
| 送信エラー N回 | `push_subscriptions.failure_count`（端末ごと） |

閾値の 10 分は上の一次監視表と**同じ値**じゃ（`HEARTBEAT_STALE_MS`）。
片方だけ動かすと、画面と手順書が違うことを言い出す。

⚠️ **「取得できませんでした」が出たら、それは配信の停止ではない。**
心拍や配信履歴の**読み取り自体**が失敗した時の表示じゃ（migration 未適用の
`42P01`・RLS 拒否・一過性の DB エラー）。「まだありません」（＝ pg_cron 未登録）
とは対処が正反対ゆえ、必ず別の文言で出る。この時に pg_cron を疑って基盤を
止めに行ってはならぬ —— 見るのは Vercel のサーバログ
（`[settings] notification heartbeat lookup failed` 等）じゃ。

⚠️ **設定カードの「解除」はブラウザ側の購読も畳む。**
DB 行を消すだけでは、上の ③ が同じ端末を登録し直して通知が戻る。ゆえに
`delete_my_push_subscription_by_id` が「消した行が呼び出し元の端末か」を返し、
一致した時だけクライアントが `unsubscribe()` を呼び、localStorage に解除の印を
残す。**他の端末の行を消した場合は、その端末が次に起動した時点で復活する**
（端末を跨いだ恒久解除は現状 存在せぬ）。その端末で解除するか、通知を
受け取らせぬなら当該端末のブラウザ設定で権限を切ること。

---

## secret の回転

`NOTIFY_CRON_SECRET` は **Vercel と Vault の 2 箇所に複製されておる**。
片方だけ変えると通知が全部 401 になる（しかも上記のとおり
`cron.job_run_details` は成功と言い張る）。必ずこの順で:

1. 新しい値を `vercel env add NOTIFY_CRON_SECRET production`（旧値は消さぬ）
2. **再デプロイ**して新しい値を載せる
3. Vault の `notify_cron_secret` を新しい値へ更新する
4. 5 分待ち、`net._http_response` の `status_code` が 200 であることを確かめる
5. Vercel から旧値を削除し、**もう一度再デプロイ**する
   （`vercel env rm` も自動再デプロイせぬ。怠ると旧 env を焼き込んだ build が
   動き続ける）

止め方:

```sql
select cron.unschedule('notify-deliveries');
```

---

## 関連

- ハンドラ: `src/app/api/cron/notify/route.ts`
- 配信本体: `src/lib/notifications/deliver.ts`
- テーブル: `supabase/migrations/20260808100003_notification_deliveries.sql`
- 再登録の endpoint: `src/app/api/push/resubscribe/route.ts`（SW と起動時の突き合わせが叩く）
- 起動時の突き合わせ: `src/components/common/push-subscription-reconciler.tsx`
- 認可の機械検査: `e2e/cron-routes-auth.spec.ts`（proxy に食われぬこと + 鍵の分離）
- 登録 verb の機械検査: `src/app/api/cron/notify/__tests__/runbook-contract.test.ts`
  （この手順書の `net.http_*()` とハンドラの export が食い違えば赤になる）
