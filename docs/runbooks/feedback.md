# 要望・改善提案（feedback）の運用

家族が送った要望を運用者（`app_operators`）が受け取り、状態を返し、**本番で反映を確かめてから**
「反映済み」と確定する仕組みの手順書じゃ。正本はアプリ内の受信箱と履歴で、Push は知らせにすぎぬ。

- migration: `supabase/migrations/20261025200001_feedback.sql`
- 画面: `/feedback`（投稿者）・`/feedback/inbox`（運用者）・設定 → 「使い方と要望」
- 知らせ: `/api/cron/notify` の別フェーズ（`src/lib/notifications/deliver-feedback.ts`）

## 1. 状態の意味

| 状態 | 誰が | 意味 |
|---|---|---|
| 受付 | 投稿で自動 | 届いた。まだ誰も判断しておらぬ |
| 検討中 | 運用者 | やるかどうかを考えておる |
| 対応中 | 運用者 | 作業中。PR のマージは「取り込み済みの変更」に記録する（**反映ではない**） |
| 反映済み | 運用者（確定フォームだけ） | 本番環境で動作を確かめた。コミット SHA と確認の時刻を必ず伴う |
| 見送り | 運用者 | やらぬ。理由（返信）が必須 |

- 一般利用者は自分の要望の状態を 1 つも動かせぬ（表への書込権限も RPC も無い）。
- 「反映済み」は通常の状態変更では選べず、DB の CHECK が証拠なしの `released` を拒む
  （service role・SQL Editor でも同じ）。
- 反映済みを取り消す（差し戻す）時は理由が必須。現在の証拠は消え、履歴には残る。

## 2. 本番へ適用する手順（順序が肝）

### 2.1 migration を先に

```sh
# 人間の端末で（Claude は実行せぬ）
pnpm supabase migration list --linked     # 20261025200001 が未適用であることを確かめる
pnpm supabase db push --linked            # 適用
```

⚠️ **deploy を migration より先にしてはならぬ。** 表が無いと:

- `/api/cron/notify` の要望フェーズが毎回 `42P01` で落ち、心拍の `failed_count` が 1 以上になる
  （設定画面の通知カードが「問題が起きている可能性」を出す。予定の通知そのものは送られる）
- `/feedback` は error boundary（「問題が発生しました」）になる
- 設定画面は件数を出さぬだけで動く（`unseen feedback count failed` がログに出る）

適用後の確認（読み取り）:

```sql
select relname, relrowsecurity
  from pg_class
 where relname in ('feedback_items', 'feedback_events', 'feedback_notifications');

select p.proname, p.prosecdef, p.proconfig
  from pg_proc p
 where p.proname in ('submit_feedback', 'operator_update_feedback', 'operator_release_feedback',
                     'mark_feedback_seen', 'get_feedback_push_summary', 'enqueue_feedback_push',
                     'feedback_text_ok');
```

### 2.2 運用者が登録済みか

受信箱を開けるのは `app_operators` に在る利用者だけ（世帯 owner であることは根拠にならぬ）。
登録の手順は `docs/runbooks/approvals.md` §2.3 にある。

```sql
select o.user_id, u.email, p.is_approved, p.household_id
  from public.app_operators o
  join auth.users u on u.id = o.user_id
  join public.profiles p on p.id = o.user_id;
```

運用者には**承認済みで世帯に所属した**利用者を選ぶ。世帯が無いと、受信箱（(main) の配下）に
入れず、運用者宛の Push も積まれぬ（承認済みかつ世帯所属の端末だけに積む）。

### 2.3 deploy

通常の main マージ → Vercel の production deploy。開いたままの PWA は古いバンドルのままゆえ、
家族には一度アプリを閉じて開き直してもらう。

## 3. 「反映済み」の確定（運用者の作法）

**PR のマージ・プレビューでの確認では確定せぬ。** 次の順で確かめてから確定する。

1. 修正の PR が main にマージされ、Vercel の production deploy が Ready になった
2. 稼働中のデプロイが修正を含むことを確かめる
   - 受信箱の詳細の確定フォームに「このサーバの稼働中デプロイ: `production:<sha>`」が出る
     （`VERCEL_ENV` と `VERCEL_GIT_COMMIT_SHA` をサーバが読んだもの。**本番の URL で開いた時だけ**
     `production:` になる。プレビューで開けば `preview:` と出る）
   - 修正のコミットがその祖先かを人間の端末で確かめる:

     ```sh
     git fetch origin main
     git merge-base --is-ancestor <修正の sha> <稼働中の sha> && echo included
     ```

3. 本番の irori で、実際にその変更が動いておることを触って確かめる
4. 確定フォームに「確かめたコミット」（修正のコミット SHA）とリリース情報（任意）を入れ、
   「本番環境で、この変更が動いていることを確かめました」にチェックを入れて「反映済みにする」

記録されるもの（`feedback_events` の該当行と `feedback_items` の現在値）:

| 列 | 中身 |
|---|---|
| `release_commit_sha` | 運用者が入れた SHA（小文字へ正規化） |
| `release_verified_at` | 確定の操作をした時刻（DB の `now()`） |
| `release_note` | 任意のリリース情報 |
| `release_observed_deploy` | 確定を処理したサーバが自分で観測したデプロイ。運用者の申告とは別の観測 |

## 4. 知らせ（Push）の監視

知らせは `/api/cron/notify`（pg_cron が 5 分ごと）の**別フェーズ**で送る。予定の通知と同じ
claim・at-most-once・404/410 の後始末を共有し、失敗は同じ心拍の `failed_count` に数える
（`docs/runbooks/notify-cron.md` の監視表がそのまま使える）。

```sql
-- 直近の知らせ（宛先は数だけ見る。endpoint は出さぬ）
select n.audience, n.scheduled_at, n.sent_at, n.accepted_at, n.skip_reason
  from public.feedback_notifications n
 order by n.created_at desc
 limit 20;
```

| 状態 | 読み方 |
|---|---|
| `accepted_at` あり | push サービスが受理（**端末に表示されたかは分からぬ**） |
| `sent_at` あり・`accepted_at` なし | 結果不明（at-most-once で再送せぬ） |
| `skip_reason = expired` | grace（15 分）を過ぎた。cron が止まっておった |
| `skip_reason = gone` | 端末の購読が失効（410/404）。購読は削除済み |
| `skip_reason = revoked` | 送る直前に資格が崩れた（運用者から外れた・承認を失った・要望が消えた） |
| `skip_reason = superseded` | 送る前に状態がさらに変わった（例: 反映済みを確定した直後に差し戻した → 古い「反映されました」は送らぬ） |

運用者の画面（受信箱の詳細）は同じ内訳を `get_feedback_push_summary` で数だけ出す。
**どの表示も「届いた」とは言わぬ。** 投稿者には、アプリの画面で必ず最新の状態が出る
（設定画面の「確認が必要な項目」と、ヘルプのカードの「更新 N」）。

Push が届かぬ時の復旧:

1. 投稿者の端末で通知が許可され、設定の「通知と端末」に端末が出ておるか
2. 上の SQL で `gone` が出ておれば、その端末でアプリを開き直す（起動時の突き合わせが再登録する）
3. それでも届かぬなら、アプリ内の表示が正本ゆえ、口頭で「アプリの要望の画面を見て」と伝える

## 5. 守っておること（変える前に読め）

- 要望の題・本文・投稿者名は **Push に載せぬ**（ロック画面は施錠されたままでも中身を映す）
- 要望の題・本文は **ログに出さぬ**（`logSupabaseErrorRedacted`。CHECK 違反の details は行の中身を運ぶ）
- GitHub の公開 Issue などへ要望を**自動では送らぬ**（家族の要望・個人情報を公開の場へ出さぬ）
- 投稿は 1 人 24 時間で 20 件まで（他世帯の承認済み利用者も送れるゆえ、受信箱と Push の連打を止める）
- 同じ世帯の家族にも要望は見えぬ（投稿者と運用者のやり取り）

## 6. 戻し方（migration）

⚠️ 要望・履歴・知らせは**全て消える**。戻す前に要るものを書き出すこと。
アプリを先に戻す（新しい画面と cron のフェーズが表を引かぬように）してから流す。

```sql
begin;
drop function if exists public.get_feedback_push_summary(uuid);
drop function if exists public.mark_feedback_seen(uuid);
drop function if exists public.operator_release_feedback(uuid, uuid, integer, text, text, text, boolean, text);
drop function if exists public.operator_update_feedback(uuid, uuid, integer, text, text, text);
drop function if exists public.submit_feedback(uuid, text, text);
drop function if exists public.enqueue_feedback_push(uuid, uuid, text);
drop table if exists public.feedback_notifications;
drop table if exists public.feedback_events;
drop table if exists public.feedback_items;
drop function if exists public.feedback_text_ok(text, integer, boolean);
commit;
```

戻した後は `supabase_migrations.schema_migrations` から `20261025200001` の行を消すか、
`supabase migration repair --status reverted 20261025200001` で印を戻す（人間の端末で）。
