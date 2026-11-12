# 家事（ごみ・掃除・ごはん）公開の手順と引き継ぎ

この文書の冒頭が、今の公開の手順じゃ。§0〜§3 は済んだ段の記録として残す。ただし §2 の「参考」と §3 の「戻し方」は今も使う。§4〜§6 は今の手順の一部。状態の正本は `requirements-ledger.md`、経過は `progress.md`。

## 今の状態（2026-11-12）

エージェントが GitHub の公開 API で確かめたもの:

- PR #253（https://github.com/syouya0618/irori/pull/253）は **Draft・未 merge**。head は `314fbd9c`（origin の branch と同じ）。`main` は `521f2fc2` のままで、branch の基点と同じ。
- `314fbd9c` で、次の 3 本の run が成功した。
  - `CI`（run 43182408888）
  - `E2E`（run 43182408848）: 2 つの job が成功。失敗の時だけ動く 2 つの step（artifact の保存・DB の失敗の調査）は skipped で、ほかの step は全て成功。Playwright の集計（注釈）は 88 passed・1 skipped。
  - `CodeQL`（run 43182408844）: javascript-typescript・python・actions の 3 つ。
- `main` の保護が求める必須チェックは `ci` と `e2e`（job の名）。

利用者の報告（エージェントは本番に接続できず、照合しておらぬ）:

- 2026-11-12 に、本番の Supabase `irori-prod` へ migration 3 本を適用した。
- 本番の既存の履歴 55 本は GitHub と一致（照合した時点は報告に無い）。
- 適用後の SQL 監査は PASS（数値は §3）。
- CodeQL で、PR の差分の新しい警告は 0 件。
- 本番アプリへのデプロイと、本番での実操作はまだ。

まだ無いもの:

- 本番 DB のバックアップの取得と復元の試験。記録が無く、**未完了**として扱う。
- iPhone Safari・実機での家事の確認。家事の Playwright は Chromium だけで走る。
- Push の実端末での受信の確認。
- 無料 AI の実接続。アダプターは実装済みで、既定 OFF。Workers Free の契約の確認は未完了。

## 今の公開の手順（人。この順）

エージェントは、commit・push・PR の更新・Draft の解除・merge・デプロイ・本番 DB の操作を行わぬ。

1. **文書の更新を commit・push する。**
   - worktree に、この文書を含む 4 本（`progress.md`・`handoff.md`・`pr-body.md`・`requirements-ledger.md`）の更新が未 commit で在る。
   - commit の文面と `git add` する path は、引き継ぎの報告に書く。
   - force push はしない。
2. **新しい SHA で CI が緑になるのを待つ。**
   - 3 本の workflow は path で絞っておらぬ。文書だけの commit でも、`CI`・`E2E`・`CodeQL` が走り直す。
   - `314fbd9c` の緑は、新しい SHA の緑の代わりにならぬ。
   - 必須の `ci`・`e2e` に加えて、`db-image-probe` と CodeQL も緑になるまで、5 へ進まない。
   - `skipped` と、step が 0 件で終わった失敗は、成功に数えない。
   - 落ちたら merge せず、ログをエージェントへ渡す（§2 の「E2E が落ちた時」）。
3. **PR の本文を差し替える。**
   - `pr-body.md` の中身で、PR #253 の本文を置き換える。GitHub の画面か、`gh pr edit 253 --repo syouya0618/irori --body-file "$W/docs/plans/2026-11-10-household-chores/pr-body.md"`（`W` は下の「基本の情報」）。
   - 今の GitHub 上の本文は、最初の commit（`51bd55bc`）の頃のものじゃ。古い記述が残っておる。
     - 「CI で初めて走るもの」
     - 「本番 DB へ入れるまで merge しない」
     - 「食材止まりのアレルギーを広げるかは未決」
4. **公開の前に、人が確かめて決める。**
   - Vercel の production の env が指す Supabase が、migration を入れた `irori-prod` であることを確かめる（URL の中の project ref を照らす。鍵の値は表に出さない）。エージェントは、アプリの実の接続先を一度も照合できておらぬ。
   - バックアップを取るか。取るなら公開の前に取り、記録を `progress.md` へ残す。
   - `314fbd9c`（人の commit。家事以外の全ての呼び出し元に効く共有の `log-error.ts` を含む）は、独立レビューの記録が無い（CI と CodeQL は通った）。merge の前にレビューするか。
   - 上の「まだ無いもの」を残したまま公開してよいか。
5. **Draft を解除し、保護条件を満たして通常 merge する**（§4 の 1）。
6. **デプロイを確かめる**（§4 の 2）。
7. **本番で確かめる**（§4 の 3 のチェックリスト）。

戻し方は、§3 の末尾（DB・トリガ）と §4 の末尾（アプリ）。

## 本番の DB について、今知っておくこと

- 3 本の migration は本番に適用済み。**以後、この 3 本は書き換えない。** 直すなら、新しい加算の migration で足す。
- トリガ 3 本は、適用の時点から本番で有効じゃ。旧アプリのままでも、次の書き込みで動く。
  - `trg_calendar_events_purpose_default`: `calendar_events` の INSERT と、`start_date` の UPDATE
  - `trg_event_reminders_purpose_opt_out`: `event_reminders` の DELETE
  - `trg_event_reminders_purpose_opt_in`: `event_reminders` の INSERT
- どれも、ごみに分類した予定にだけ作用する設計じゃ。旧アプリには分類を作る画面が無い。
- 予定や通知に異常が見えたら、merge の前でも後でも、§3 の末尾の `DISABLE TRIGGER` で元の挙動へ戻せる（DROP はしない）。

## 基本の情報

- worktree: repo の根からの `.claude/worktrees/kaji-gomi-souji-gohan-20261110`。手順の中では `W` に入れて使う:

  ```bash
  W=<repo の根>/.claude/worktrees/kaji-gomi-souji-gohan-20261110
  ```

- branch: `worktree-kaji-gomi-souji-gohan-20261110`（基点 `521f2fc2`）
- PR: https://github.com/syouya0618/irori/pull/253（作り直さない。修正は追随の commit で足す）
- 追加した migration（加算のみ。この順。本番へ適用済み）:
  1. `20261111100001_event_purposes.sql` — 表 `event_purposes`、RPC、既存表 `calendar_events` / `event_reminders` へのトリガ 3 本
  2. `20261111100002_cleaning_routines.sql` — 表 `cleaning_routines` / `cleaning_logs`、RPC
  3. `20261111100003_dinner_tables.sql` — 表 10（`dinner_settings` `pantry_items` `food_exclusions` `food_preferences` `dish_feedback` `dinner_plan_state` `dinner_plan_entries` `grocery_items` `dinner_ai_usage` `dinner_ai_provider_state`）、RPC
- repo の migration は 58 本（既存 55 本＋上の 3 本）。3 本の中身は `51bd55bc` 以後変わっておらぬ。
- 既存表の DROP・rename・型変更・既存ポリシーの変更は無い。Realtime publication と `public/sw.js` は変更していない。
- 経緯: 3 本は、`51bd55bc` の前に 5 件の修正で列と RPC を足し、その場で書き換えた（その時点では、どの DB にも適用していなかった）。手元や preview の DB に古い版を適用したことがあるなら、その DB は `supabase db reset` で作り直す。

## 0. エージェントが手元で実行できなかった検証（経緯と、今の結果）

| 検証 | 手元で実行できなかった理由 | 今の結果（`314fbd9c`） |
|---|---|---|
| `supabase test db`（本物の Supabase local） | Docker 不可 | E2E の pgTAP の step が成功（拒否試験 175 件を含む） |
| DB イメージの最小再現（`scripts/test-db-execute-denial.sh`・`db-image-probe` ジョブ） | Docker 不可 | 106 の手順（hint_roles だけが EXECUTE 拒否で落ちる）と 156 の手順（42501 で稼働を続ける）が成功。stack 上の probe も成功。script は条件を全て満たした時だけ PASS で終わる。ログの本文は読めておらぬ |
| 本物の Auth → PostgREST → RPC（`e2e/chores-rpc-auth.spec.ts`） | ローカルポート bind 不可 | Playwright の step の中で成功 |
| 2 接続の並行試験（`scripts/test-chores-concurrency.py`） | Postgres を起動できない | 成功 |
| Playwright（`e2e/chores-*.spec.ts`、`touch-targets`・`a11y-axe` の家事の分） | ローカルポート bind 不可 | 成功。88 passed・1 skipped で、flaky の行は無い。家事の spec は skip を持たぬゆえ、skip の 1 件は家事以外 |
| 最後の「DB の異常終了 0 件」の断定 | （CI でだけ走る） | 成功 |
| 実ブラウザ（200% 拡大、キーボード、実機） | ローカルポート bind 不可 | **未実施**。iPhone Safari の実機では、家事を一度も確かめておらぬ |
| 無料 AI の実 API | Cloudflare の資格情報とコネクタが無い。アカウントが Workers Free かを API から判定できない | **未実施**。実 API の呼出しは 0 回 |
| Push の実端末受信 | 端末が無い。家族へ無断の試験通知は送らない | **未確認** |

ブラウザの範囲:

- 家事の Playwright は `chromium` project（Desktop Chrome の設定）で走る。
- `webkit-iphone` project（iPhone 15 の模擬・WebKit）は `webkit-core.spec.ts` だけを流し、家事を含まぬ。

注（`fba35d38` までの経緯）:

1. 手元の pgTAP: プロセス内 PGlite（PG 17.5）＋ Supabase スタブ＋本物の pgTAP で、migration 58 本と pgTAP 39 ファイル 1947 件を実行し全緑。
2. CI の pgTAP:
   - `51bd55bc`: CLI 既定の DB イメージ（17.6.1.106・supautils 3.2.0）の不具合で、166 行目に SIGSEGV。
   - `fba35d38`: 17.6.1.156 へ固定し、拒否試験 175 件を含めて成功。
3. 手元の probe（実の image ではない）:
   - `docker` を模した shim で判定の流れを 27 通り。bash 5.3 と macOS の bash 3.2 の両方で流した。
   - mutation 10 本。
   - 独立レビュー 2 周（読むだけ）。1 周目の P1 を直し、2 周目は P1・P2 なし。
   - PGlite で、script が組み立てる SQL を、非 superuser に見立てたロールから確認。
4. CI の probe（`fba35d38`）:
   - 156 の stack: 成功（旧版の probe）。
   - 106 の throwaway: 旧版が準備の `GRANT … TO CURRENT_USER` で落ちた（supautils#205。期待の拒否に届かず）。
   - 直した版（`bf4568ff`）では、`--image` は準備を別の接続で commit し、`--container` はロールごとの transaction と ROLLBACK で何も残さぬ。実の image では `314fbd9c` で初めて走り、成功した。
5. CI の Playwright（`fba35d38`）: 87 passed・1 failed・1 skipped。
   - 失敗の 1 件は、ごはん①の断言の誤り（C-24 と食い違い）で、`060db833` で直した。
   - skip の 1 件は家事以外。

`pnpm build` は、手元の sandbox では完走しなかった。CI の build は `51bd55bc`・`fba35d38`・`314fbd9c` で成功した。

## 1. 追随の commit・push（済み。経緯）

人が次の commit を作り、push した。PR #253 は作り直しておらぬ。

| commit | 中身 |
|---|---|
| `51bd55bc` | 最初の実装 |
| `35d55586` | CI 用 DB の image の固定 |
| `fba35d38` | 判定できないアレルギーの保留・品目の候補・AI の記述 |
| `bf4568ff` | probe の grantee の明示と、fixture の分離 |
| `060db833` | ごはん①の断言（C-24） |
| `2b1fae6e` | 文書（`fba35d38` の CI の結果） |
| `314fbd9c` | CodeQL の指摘への修正（人が作成） |

- 同じディレクトリの `commit-message*.txt` は、どれも上の commit で使用済み。新しい commit には使わない。
- 着手の時、主 checkout（repo 直下）には利用者の未 commit 変更があった。そちらで `git add -A` をしないこと。
- force push はしない。追加の修正は新しい commit で足す。

## 2. CI の経過（経緯）

- `51bd55bc`:
  - `CI` は全成功（run 43025441100）。
  - `E2E` は、`supabase test db` の `chores_rpc_security.sql:166` で DB が SIGSEGV（run 43025441011。CLI 既定の image の不具合）。後続は skipped。
- `fba35d38`:
  - `CI` は全成功（run 43117184040）。CodeQL も成功。
  - `E2E`（run 43117183991）は失敗。
    - `db-image-probe`: 106 の手順が、準備の `GRANT … TO CURRENT_USER`（supautils#205）で赤。156 の手順は skipped。
    - `e2e` ジョブ: 156 の固定、stack の probe、`supabase test db`（拒否試験 175 件を含む）、並行試験 2 本、build は成功。
    - Playwright は 87 passed・1 failed（ごはん①の断言）・1 skipped（家事以外）。
    - 最後の「異常終了 0 件」の断定は skipped で、一度も走らなかった。
- `314fbd9c`: 全て成功（上の「今の状態」と §0 の表）。`fba35d38` の後に「次の SHA で初めて確かめる」としていた次のものも、ここで step が成功した。どれも script と試験の判定による（ログの本文は読めておらぬ）。
  - `db-image-probe`: 106 で対照のロールが 42501、anon・authenticated が自分の backend の signal 11。156 で 4 ロールとも 42501 のまま稼働を続ける。
  - stack 上の probe に足した 5 つの赤の条件（`progress.md` の「主経路へ足した、未観測の前提」）。
  - Playwright の全て（直したごはん①を含む）。
  - 最後の「異常終了 0 件」の断定。

参考（今も有効）:

- Supabase CLI は `2.101.0` に pin したまま（`setup-cli@v1`）。DB イメージは `e2e.yml` の `IRORI_DB_IMAGE_TAG` / `IRORI_DB_IMAGE_DIGEST` の 1 か所で固定する（無条件に latest へは追随しない）。
- 手元で `supabase start` するときは、`supabase/.temp/postgres-version` に同じ tag（`17.6.1.156`）を書いてから起動する（README の検証の節）。`.temp` は gitignore ゆえ書かねば 106 のままで、拒否試験で DB が落ちる。`supabase link` はこの値を本番の版で上書きする。
- E2E が落ちた時:
  - テストを削らず、skip・弱い assert へ変えて通さない。権限を足して拒否試験を通すこともしない。
  - 上限（`timeout-minutes: 40`）で切れた時は、上限を上げる。
  - 失敗のログ（Playwright の artifact と、`Record isolated database runtime`・probe の出力）をエージェントへ渡せば直す。
- 手元の Docker で probe を流すなら（任意。正本は CI の amd64）:

  ```bash
  docker pull "supabase/postgres@sha256:21ab971149317ea9cd12a8126fe4ebb34def08c8972956b0958cba0924409dab"
  docker pull "supabase/postgres@sha256:ca7871b587ca2c401ac0f325df6249c9aa0d25647ded34631158efc51176767f"
  "$W/scripts/test-db-execute-denial.sh" --image "supabase/postgres@sha256:21ab971149317ea9cd12a8126fe4ebb34def08c8972956b0958cba0924409dab" --expect crash
  "$W/scripts/test-db-execute-denial.sh" --image "supabase/postgres@sha256:ca7871b587ca2c401ac0f325df6249c9aa0d25647ded34631158efc51176767f" --expect clean
  ```

  - 使い捨ての container を起こして、終了時に消す。共有の DB や本番には向けない。

## 3. 本番 DB への適用（済み。2026-11-12、人）

利用者の報告（エージェントは本番に接続しておらぬ）:

- 対象: 本番の Supabase `irori-prod`。
- 適用した migration: `20261111100001`〜`20261111100003` の 3 本。
- 既存の履歴: 本番の 55 本が GitHub と一致した（照合した時点は報告に無い）。
- 適用の方法と dry-run の結果は、報告に含まれておらぬ。
- 適用後の SQL 監査: PASS。
  - migration 3/3
  - 表 13/13
  - RLS 13/13
  - トリガ 3/3
  - 書き込みポリシー 0
  - anon・authenticated の直接の書き込み権限 0
- バックアップの取得と復元の試験: 記録が無い。**未完了**として扱う。

### 適用前の計画と止める条件（記録。もう流さない）

main への merge が本番公開を起こす構成なら、schema を先に入れる（旧アプリは新しい表を参照しないので共存できる。トリガは分類済みの予定にだけ作用する）。手順は既存の `docs/runbooks/approvals.md` §2.2 と同じ。

```bash
supabase migration list --linked   # Local だけの版が 20261111100001〜3 の 3 本「だけ」であること
supabase db push --dry-run         # 印字される版も同じ 3 本「だけ」であること。seed・roles の適用が無いこと
supabase db push                   # 3 本を version 順に適用し、history も書く
```

**止める条件（一つでも当たれば流さない）**

| 観測 | 判断 |
|---|---|
| Local だけの版・dry-run の版が上の 3 本以外を含む（特に `20260909100002` / `20260909100003`） | 止める。`100003` は不可逆な DROP。`--include-all`・`migration repair`・SQL Editor への貼り付けで押し通さない |
| 適用前に `select to_regclass('public.event_purposes'), to_regclass('public.cleaning_routines'), to_regclass('public.pantry_items')` のどれかが NULL でない | 止める（手で流した痕跡か、旧名との衝突） |
| `db push` が途中で error | 再送しない。history の query でどこまで入ったかを確かめる |

適用後の確認（計画の時の SQL。読むだけ）:

```sql
select version, name from supabase_migrations.schema_migrations
 where version in ('20261111100001','20261111100002','20261111100003') order by version;  -- 3 行
select tgname from pg_trigger where tgname like 'trg_%purpose%' order by 1;                -- 3 行
select count(*) from pg_policies where tablename in ('event_purposes','cleaning_routines','cleaning_logs','pantry_items','grocery_items','dinner_plan_entries') and cmd <> 'SELECT';  -- 0
select count(*) from information_schema.role_table_grants
 where table_schema = 'public' and grantee in ('anon','authenticated')
   and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')
   and table_name in ('event_purposes','cleaning_routines','cleaning_logs','dinner_settings','pantry_items','food_exclusions','food_preferences','dish_feedback','dinner_plan_state','dinner_plan_entries','grocery_items','dinner_ai_usage','dinner_ai_provider_state');  -- 0
```

### 戻し方（今も有効）

- アプリを戻す場合も、DB の追加は残す（DROP で戻さない）。
- 予定・通知の既存機能だけを元の挙動へ戻したい緊急時は、トリガを無効にする。人が本番で流す。元へ戻すのは `ENABLE TRIGGER`。

  ```sql
  ALTER TABLE public.calendar_events DISABLE TRIGGER trg_calendar_events_purpose_default;
  ALTER TABLE public.event_reminders DISABLE TRIGGER trg_event_reminders_purpose_opt_out;
  ALTER TABLE public.event_reminders DISABLE TRIGGER trg_event_reminders_purpose_opt_in;
  ```

## 4. merge と公開後の確認（人。未実施）

1. Draft を解除し、保護条件（必須チェック `ci`・`e2e`、必要なレビュー）を満たして通常 merge する。merge の前に、その時の head の SHA で CI が緑であることを確かめる（冒頭の手順の 2）。
2. Vercel の production deployment が merge commit で READY になったことを確かめる。HTTP 200・build READY・画面での保存の成功は、別々に確かめる。
3. 本番で確かめる。自分の世帯の実データで行う。試しに作った項目は、画面の操作（削除・取り消し）で片付ける（DB を直に触らない）。操作の詳しい手順は §6。
   - 予定とごみは、**試し用に作った、先の日付の単発の予定**だけで試す。家族の実の予定・繰り返しの予定では試さない。通知の付け外しが、家族の通知に及ぶゆえじゃ。

既存の画面の回帰:

- [ ] 下のタブが「育児・予定・家事・設定」の 4 本で、育児・予定・設定が従来どおり開く。
- [ ] 育児: 記録を 1 件つけ、編集し、取り消す。
- [ ] 予定: 試しの予定を作り、日付を変える（`calendar_events` のトリガが動く経路）。消すのは、下のごみの確認の後。
- [ ] 予定: 試しの予定に通知を付け、外す（`event_reminders` のトリガが動く経路）。通知の時刻が来る前に外す。
- [ ] Google カレンダーの同期を使っておるなら、同期の後も予定が従来どおり並ぶ（同期の書き込みも `calendar_events` のトリガを通る）。
- [ ] 設定: 開ける。既存の設定が従来どおり読める。

ごみ（同じ試しの予定で）:

- [ ] 家事 → ごみ: 未登録の時は、予定の作成への導線が出る。
- [ ] 試しの予定を「ごみの日にする」。通知の初期選択は「前日 20:00 に通知する」ゆえ、「通知設定は変えない」へ選び直してから保存する。
- [ ] 再読込しても、月表示と 家事 → ごみ に残る。
- [ ] 解除する（通知は「通知設定は変えない」のまま）。最後に、試しの予定を消す。
- [ ] 通知そのものを試すなら、家族に伝えてからにする。
  - 「前日 20:00 に通知する」は、前日の 20:00 に世帯の端末へ届く。
  - 「通知を止める」は、既存の通知も消す（シリーズなら今日以降の全ての回）。
  - 解除しても、付いた通知は残る。

掃除:

- [ ] 項目を追加 → 再読込で残る → 完了 → 直後に取り消し → 元の状態へ戻る。

ごはん:

- [ ] 食材を登録 → 「今あるもので」→ 献立 → 確定 → 買い物。
- [ ] 家族のアカウント（同じ世帯）で買い物を開き、購入のチェックが相手の画面に映る（画面へ戻った時と、表示中の定期再取得）。
- [ ] 献立のページに「AI 補助は設定されていません。」と出る（AI は既定 OFF）。

端末:

- [ ] iPhone Safari（ホーム画面に置いた PWA を含む）で、家事の 3 画面が崩れず、釦を押せる。CI の家事の Playwright は Chromium だけで、ここが初めての確認になる。

確認できぬまま残るもの:

- Push の実端末での受信。家族へ無断の試験通知は送らない。
- 無料 AI（§5）。

戻し方（アプリ）:

- 前の production deployment へ戻すか、merge commit を revert する（どちらも人）。DB の追加は残す。旧アプリは新しい表を参照しない。
- 予定・通知の異常は、§3 の末尾のトリガの無効化で切り分ける。

## 5. 無料 AI の有効化（公開とは別。しなくても全機能が動く）

アダプターは実装済み。実接続は未実施で、既定 OFF。Workers Free の契約の確認は未完了。資格情報を入れない間は呼び出さず、献立は規則ベースの自動献立で動き、献立ページには「AI 補助は設定されていません。」と出る。実 API の呼出しは 0 回。

1. Cloudflare ダッシュボードで、献立に使う Account が **Workers Free**（Paid ではない）であることを人が確認する。Paid なら無料枠の超過分が課金されるので有効化しない。API からは判定できない。
2. Vercel の production env に `MEAL_AI_ENABLED=true`、`MEAL_AI_ACCOUNT_ID`、`MEAL_AI_API_TOKEN`（Workers AI の実行だけを許す token）を入れて再デプロイ。`MEAL_AI_MODEL` は省略可。AI Gateway・プリペイド・有料モデルは使わない。
3. 実 API 試験は最大 3 回。献立ページで希望（例「金曜はカレー」）を入れて「AI 補助」の表示と解釈結果を確認する。家族の名前・誕生日・育児日記・診断は AI へ送らない（送るのは希望文と候補のレシピ ID だけ）。
4. 同じ Account のニュース AI と 1 日 10,000 Neurons の無料枠を共有する。枠が尽きると（内部コード 3036）、次の 09:00 JST まで AI 呼出しを止め、自動献立は続く。詳細は `docs/runbooks/meal-ai.md`。

## 6. 操作の手引き（公開後の確認で使う）

- **食材登録 → 今あるもので → 既存の日へ足す**: 家事 → ごはん → 食材 → まとめ入力に「鶏もも肉 300g、玉ねぎ 2個、卵 6個、お米 2kg」→ 内容を確認して登録 → 設定で常備品（油・塩・しょうゆ等）を選ぶ → 「今あるもので」。常備品を選ばないと、調味料が要る料理は「揃う」に出ない（未登録の調味料を在庫ありと数えないため）。「豚肉」「鶏肉」のような総称で登録した在庫は材料に数えない（部位が分からないため。画面に直す導線が出る）。候補の「献立に入れる」は、料理が在る日にも 1 品だけ足す（在る料理と固定はそのまま）。
- **使わない食材**: ごはん → 設定 → 使わない食材。一覧（消費者庁の対象品目）か食材名で登録すると献立と在庫提案から必ず外れる。自由入力で判定できない語は「適用済み」と出ず、対象品目・食材から選び直す釦が出る。手で入れた料理は、材料が未登録・使わない食材に当たる時、保存はできるが献立の確定が止まり、理由が出る。確定した後に除外を足すと、当たる料理の材料は「献立から更新」で買い物から外れ、買い物の画面に料理名と理由が出る（献立はそのまま）。判定できない語をアレルギーとして登録すると、選び直すまで献立の確定と買い物の自動の更新が止まる。買い物のリスト・購入の記録・手で足した項目は残り、「要再確認」と出る。アレルギーで「豆乳」「鶏もも」を選ぶと、「大豆」「鶏肉」を品目として登録する候補と外す範囲が出る（押したときだけ登録。苦手には出ない）。
- **取り分け**: 設定で子どもの「食事の段階」を保護者が選ぶまで、取り分け案内は出ない（月齢だけでは出さない）。
- **金曜を固定 → 7 日分 → 買い物 → 家族のアカウントで購入チェック**: 献立 → 日数を 7 日に → 希望に「金曜はカレー」→「希望を反映」→ 読み取り結果（金曜にカレーを固定）を確かめて「この内容で献立を作る」→「この献立で確定」→「買い物リストを見る」。家族のアカウントで同じ世帯に入り、買い物を開いてチェック。相手の端末への反映は、画面へ戻ったときと表示中の定期再取得（即時の push ではない）。
- **作った → 取り消し**: 一部だけ買った料理を「作った」にしてから取り消すと、買い物の不足が元へ戻る。購入の記録は消えず、在庫は増えない。
- **ごみ**: カレンダーでごみの予定を開く → 「ごみの日にする」→ 範囲（この回だけ／シリーズ全体）と通知を選ぶ → 月表示と家事 → ごみで確認。
  - 通知の選択肢は「前日 20:00 に通知する」「通知を止める」「通知設定は変えない」の 3 つ。
  - 新しく分類する時の初期選択は「前日 20:00 に通知する」で、前日の 20:00 に世帯の端末へ届く。
  - 「通知を止める」は、この回（シリーズなら今日以降の全ての回）の既存の通知も消す。
  - 解除の初期選択は「通知設定は変えない」で、付いた通知は残る。
  - 公開後の確認で試す時は、§4 の手順に従う（試し用の単発の予定で、「通知設定は変えない」を選ぶ）。
- **掃除**: 家事 → 掃除 → 項目を追加（テンプレートは入力欄を埋めるだけ）→ 完了 → 直後に取り消し。「実施した日から数える」項目の回をスキップすると、次回はその回の予定日から 1 周期後。
