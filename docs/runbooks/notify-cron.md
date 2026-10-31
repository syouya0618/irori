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

要望・改善提案の知らせ（`feedback_notifications`）も**同じ実行の別フェーズ**で送る
（予定の通知の後。独立した try で包み、予定の通知を巻き込まぬ）。そのフェーズの失敗も
同じ心拍の `failed_count` に数えるゆえ、上の 3 通りの読み分けはそのまま使える。
内訳の見方は `docs/runbooks/feedback.md` §4。

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
- 要望の知らせ（別フェーズ）: `src/lib/notifications/deliver-feedback.ts` / `docs/runbooks/feedback.md`
- テーブル: `supabase/migrations/20260808100003_notification_deliveries.sql`
- 再登録の endpoint: `src/app/api/push/resubscribe/route.ts`（SW と起動時の突き合わせが叩く）
- 起動時の突き合わせ: `src/components/common/push-subscription-reconciler.tsx`
- 認可の機械検査: `e2e/cron-routes-auth.spec.ts`（proxy に食われぬこと + 鍵の分離）
- 登録 verb の機械検査: `src/app/api/cron/notify/__tests__/runbook-contract.test.ts`
  （この手順書の `net.http_*()` とハンドラの export が食い違えば赤になる）

## 次の授乳の目安（feeding）

既存の5分Cronで、本人がONにした端末だけへ送る。個人設定は
`notification_preferences.feeding_reminder_minutes` の1列（NULL=OFF、5/10/15/30）。
既存行は全てOFFで始まり、初回の推奨操作は15分前。予定通知・朝のまとめの列は変更しない。
通知許可と購読登録は上の既存手順のまま、本人の明示操作で行う。

画面と同じ `findLastNursing` / `computeNextFeeding` を使い、開始時刻 `logged_at`
+ 世帯の `feeding_interval_min` - 本人のリード時間を導く。搾乳だけを除き、NULLや
将来の授乳種別は起点に含める。期限前の未来行を積み溜めず、期限に達した現在の
サイクルだけを既存 `notification_deliveries` へ入れる。15分graceを越えたもの、
次の目安自体が過ぎたものは送らない。通知は `/baby` を開き、画面が最新の記録を取得する。

`kind='feeding'` の部分UNIQUEは `(event_key, subscription_key)`。
`event_key` は最終授乳ログIDの不変コピーで、削除時にも配信履歴を消さない。
`dedupe_day` を鍵に含めないため、時刻編集でJST日付が変わっても送信済みの同じ
授乳・購読へ再通知しない。PostgRESTの列指定upsertは部分索引を推論できないため、
service role専用 `enqueue_feeding_delivery` RPCが明示的な `ON CONFLICT ... WHERE`
を行う。未送信行だけを再照準し、送信済み・失効済みの行を復活させない。

送信は既存のclaim・失敗処理・購読診断を共有する。授乳だけは
`claim_feeding_delivery` RPCが先にキュー行のロックを取得し、その**後の新しい
READ COMMITTEDスナップショット**で、最終ログID/開始時刻・間隔・個人設定・
承認済みの現在の世帯所属・有効な購読・graceを再確認する。
1本の `UPDATE ... EXISTS` だけでは、行ロック待ちの間に確定した新授乳やOFFを
古い断面で見逃す（2接続で再現済み）。ロック前の断面へ戻してはならない。
RPCのEXECUTEはservice roleだけで、SECURITY INVOKERを維持する。

最終確認の後に確定した変更や、Pushサービスが受理済みの通知を完全には取り消せない。
TTLは最大300秒・目安までの残時間以内を指定し、端末の `tag='feeding'` で前の表示を
置き換える。PushサービスやOS側の配送・表示時刻の保証ではない。
応答不明の送信はclaimを保持して再送せず、明示的な拒否だけ次回へ回す。
購読を削除するのは従来どおり404/410だけ。401/403/429/5xxでは購読を残す。

### 適用・検証・復旧

- `20261028232155_feeding_reminders.sql` を**コードの公開より先**に適用する。
  個人列・制約・索引・RPCの追加で、旧コードも継続動作する。
- 本番のproject ref、migration履歴、dry-run差分が今回の1件だけであること、
  バックアップと復旧手段を確認する。確認できなければ適用とmain mergeを止める。
  credential brokerのallowlistやmanifestを拡張して進めない。
- ローカルでは `pnpm test:run` / `pnpm lint` / `pnpm exec tsc --noEmit` / `pnpm build`、
  隔離Supabaseで `supabase test db` / Playwrightを実行する。
- 実ロック競合は **新規の隔離テストDBだけ**で
  `python3 scripts/test-feeding-reminder-concurrency.py --port 54322`。
  CIは起動した専用Supabaseへ実行する。既存の共有ローカルスタックへ実行しない。
  enqueue/claimの重複に加え、ロック待ち中の新授乳・OFF・リード変更・世帯変更を検証する。
- 公開後は上記のCron・HTTP応答・heartbeatを連続する複数回で照合する。
  `sent_at` はclaimであり、OS実機で受信した証拠と混ぜない。新機能を勝手にONにしたり、
  家族端末へ試験Pushを送ったりしない。
- 障害時は授乳設定を本人の操作でOFFにするか、確認済みの直前アプリへrollbackする。
  旧コードはfeedingを展開・送信しない。追加スキーマと履歴は残し、DB restoreや
  既存育児データの削除を行わない。受理済みPushの取消しは保証できない。

診断は秘密列を取得せず、件数だけで行う。

```sql
SELECT kind, count(*) AS total,
       count(*) FILTER (WHERE sent_at IS NOT NULL) AS claimed,
       count(*) FILTER (WHERE skipped_at IS NOT NULL) AS skipped,
       count(*) FILTER (WHERE sent_at IS NULL AND skipped_at IS NULL) AS pending
FROM public.notification_deliveries
WHERE created_at > now() - interval '1 day'
GROUP BY kind;
```

## 地域ニュース（任意）

`/news` で利用者が公式RSS対応地域と通知ON/OFFを選ぶ。追加のAPI鍵や別cronは不要。既存の `/api/cron/notify` の最終フェーズで処理し、予定・授乳・要望通知とは別に失敗を数える。標準の5分間隔の登録を使う。

- JST07:45〜08:15に、設定された固定の公式RSSだけを取得する（5分lease）。1ソース5秒・256KBまで、redirect/DTD/entity/非UTF-8を拒否。記事本文や任意URLは取得しない。利用者情報を配信元・AIへ送らない。
- JST08:00〜08:15未満に新着を配信する。cron遅延でこの窓を逃した日は遅い時刻の通知を出さない。08:00ちょうどの端末到達を保証するものではない。
- 公表日あり・直近7日・通知ONまたは地域変更後に公表された、未処理の関連記事が対象。日付のみのRSS値は日本時間0時へ正規化する。日付なしは推定せず除外する。見出しの年齢語句で絞り、対象不明の記事は共通情報として扱う。医療・受給資格の判定には使わない。
- URLの正規化とSHA-256で重複排除。利用者ごとに1日最大10記事を固定し、利用者×日付×端末の専用キューに積む。記事がなければキューも通知も作らない。記事ごとの処理印により翌日に同じ記事を新着として送らない。
- 最終claimで現在の承認・世帯・地域・通知ON/OFF・購読所有者・年齢関連性を再確認する。共有閲覧者は対象外。通知は汎用文と `/news` への導線だけで、氏名・生年月日・地域・記事見出しを含めない。
- Push transportと購読の後始末は既存基盤を共有する。claim後の応答不明は再送しない。明示的に拒否された場合のみ同じ行を窓内で再試行する。受理前のプロセス停止では1通を取りこぼし得る。処理印は配信完了の証拠ではない。
- `news_preferences` は本人だけが読める。`news_articles` は本人が選んだ地域だけ。取得lease・batch・処理印・配信キューにはAPI利用者のGRANTを設けず、service role専用とする。
- ログはsource keyと集計だけ。記事本文・見出し・ユーザー地域設定・Push endpointをログやCI artifactへ出さない。最終取得日が古い場合、画面に更新未確認と表示する。
- source追加は公式RSS案内・URL・利用条件を確認し、カタログとDBのallowlistを同時に変更する。利用者が任意の配信URLを入力する方式にはしない。

本番での登録変更、migration適用、実Push送信は別の公開前確認で行う。合成DB・fake transportのPASSを本番配信の証拠に置き換えない。
