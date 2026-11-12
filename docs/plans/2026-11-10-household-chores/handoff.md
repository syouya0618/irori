# 家事（ごみ・掃除・ごはん）引き継ぎ手順

人が commit・push 済みのもの（Draft PR #253）:

- 最初の実装: `51bd55bc9822eb000ab647c3bf90e172193440d6`
- 1 回目の追随: `35d55586`（CI 用 DB の固定）と `fba35d38`（判定できないアレルギーの保留・品目の候補・AI の記述）

`fba35d38` の CI を受けた 2 回目の追随は、worktree に未 commit で在る:

- `db-image-probe` の準備の不具合
- Playwright の 1 件の断言
- 文書

commit 以降の操作は、実行環境（git guard・sandbox・資格情報）がエージェントからの実行を拒むため、人が行う。ここはその順序と、各段で止める条件だけを書く。状態の正本は `requirements-ledger.md`、経過は `progress.md`。

- worktree: repo の根からの `.claude/worktrees/kaji-gomi-souji-gohan-20261110`（絶対パスは引き継ぎの報告に書く。下の手順では `W` に入れて使う）
- branch: `worktree-kaji-gomi-souji-gohan-20261110`（基点 `521f2fc2` = 着手時の `origin/main` の追跡 ref。remote の最新は未照会）
- PR: https://github.com/syouya0618/irori/pull/253（作り直さない。修正は追随の commit で足す）
- commit message（同じディレクトリ）:
  - 2 回目の追随: `commit-message-probe.txt`（probe）、`commit-message-e2e-c24.txt`（Playwright の断言）、`commit-message-docs.txt`（文書）
  - `commit-message-ci-db.txt` と `commit-message.txt` は 1 回目の追随（`35d55586`・`fba35d38`）で使用済み
- PR 本文: `pr-body.md`（同じディレクトリ。PR の本文を差し替える時に使う）
- 追加する migration（加算のみ・この順）:
  1. `20261111100001_event_purposes.sql` — 表 `event_purposes`、RPC、既存表 `calendar_events` / `event_reminders` へのトリガ 3 本
  2. `20261111100002_cleaning_routines.sql` — 表 `cleaning_routines` / `cleaning_logs`、RPC
  3. `20261111100003_dinner_tables.sql` — 表 10（`dinner_settings` `pantry_items` `food_exclusions` `food_preferences` `dish_feedback` `dinner_plan_state` `dinner_plan_entries` `grocery_items` `dinner_ai_usage` `dinner_ai_provider_state`）、RPC
- 既存表の DROP・rename・型変更・既存ポリシーの変更は無い。Realtime publication と `public/sw.js` は変更していない。
- **3 本の migration は、まだどの DB にも適用していない前提で、その場で書き換えてある**（5 件の修正で列と RPC を足した）。手元や preview の DB に古い版を適用したことがあるなら、その DB は `supabase db reset` で作り直す（本番には一度も適用していない）。

## 0. エージェントが実行できなかった検証（CI と人の操作で埋める）

| 検証 | 実行できなかった理由 | 代わりに行ったこと |
|---|---|---|
| `supabase test db`（本物の Supabase local） | Docker 不可 | 手元は PGlite（下の注 1）。CI の結果は下の注 2 |
| DB イメージの最小再現（`scripts/test-db-execute-denial.sh`・`db-image-probe` ジョブ） | Docker 不可 | 手元は shim・mutation・PGlite（下の注 3）。CI の結果は下の注 4 |
| 本物の Auth → PostgREST → RPC（`e2e/chores-rpc-auth.spec.ts`） | ローカルポート bind 不可 | 手元では未実行。`fba35d38` の CI の Playwright で走った。注釈の集計から成功と推すが、spec ごとのログは読めず未確認 |
| 2 接続の並行試験（`scripts/test-chores-concurrency.py`） | Postgres を起動できない | `fba35d38` の CI で成功（`Test chores RPC concurrency on isolated local DB`） |
| Playwright（`e2e/chores-*.spec.ts`、`touch-targets`、`a11y-axe` の追加分） | ローカルポート bind 不可 | 手元では未実行。`fba35d38` の CI の結果は下の注 5 |
| 実ブラウザ（200% 拡大、キーボード、実機） | 同上 | コンポーネントテストのクラス検査まで |
| 無料 AI の実 API | Cloudflare の資格情報とコネクタが無い。アカウントが Workers Free かを API から判定できない | fetch を差し替えた単体テストのみ。**実 API の呼出しは 0 回** |
| Push の実端末受信 | 端末が無い。家族へ無断の試験通知は送らない | 既存の通知経路の単体テストまで |

注:

1. 手元の pgTAP: プロセス内 PGlite（PG 17.5）＋ Supabase スタブ＋本物の pgTAP で、migration 58 本と pgTAP 39 ファイル 1947 件を実行し全緑。
2. CI の pgTAP:
   - `51bd55bc`: CLI 既定の DB イメージ（17.6.1.106・supautils 3.2.0）の不具合で、166 行目に SIGSEGV。
   - `fba35d38`: 17.6.1.156 へ固定し、拒否試験 175 件を含めて成功。
3. 手元の probe（実の image ではない）:
   - `docker` を模した shim で判定の流れを 27 通り。bash 5.3 と macOS の bash 3.2 の両方で流した。
   - mutation 10 本。
   - 独立レビュー 2 周（読むだけ）。1 周目の P1 を直し、2 周目は P1・P2 なし。
   - PGlite で、script が組み立てる SQL を、非 superuser に見立てたロールから確認。
4. CI の probe:
   - 156 の stack: `fba35d38` で成功（旧版の probe）。
   - 106 の throwaway: 旧版が準備の `GRANT … TO CURRENT_USER` で落ちた（supautils#205。期待の拒否に届かず）。
   - 直した版は、実の image では未実行。
   - 直した版では、`--image` は準備を別の接続で commit し、`--container` はロールごとの transaction と ROLLBACK で何も残さぬ。
5. CI の Playwright（`fba35d38`）: 87 passed・1 failed・1 skipped。
   - 失敗の 1 件は、ごはん①の断言の誤り（C-24 と食い違い）で、直した。
   - skip の 1 件は家事以外。

`pnpm build` の結果は `progress.md` の最終ゲートの表に書く。

## 1. 追随の commit・push（人。PR #253 は作り直さない）

2 回目の追随（`fba35d38` の CI を受けたもの）を 3 つの commit に分ける。`-F` の path は、`git -C "$W"` の下では worktree からの相対で読まれる。

```bash
W=<repo の根>/.claude/worktrees/kaji-gomi-souji-gohan-20261110
git -C "$W" status --short
git -C "$W" add scripts/test-db-execute-denial.sh .github/workflows/e2e.yml
git -C "$W" commit -F docs/plans/2026-11-10-household-chores/commit-message-probe.txt
git -C "$W" add e2e/chores-meals.spec.ts
git -C "$W" commit -F docs/plans/2026-11-10-household-chores/commit-message-e2e-c24.txt
git -C "$W" add docs/plans/2026-11-10-household-chores
git -C "$W" commit -F docs/plans/2026-11-10-household-chores/commit-message-docs.txt
git -C "$W" push origin worktree-kaji-gomi-souji-gohan-20261110
```

- `status --short` で、次だけが変わっておることを目で確かめる:
  - `scripts/test-db-execute-denial.sh`
  - `.github/workflows/e2e.yml`（コメントだけ）
  - `e2e/chores-meals.spec.ts`
  - `docs/plans/2026-11-10-household-chores/` の文書と文面
- `scripts/test-db-execute-denial.sh` は実行権限つき（100755）のまま。
- `.next`・`node_modules`・`test-results`・`playwright-report`・`supabase/.temp/` は gitignore 済み。
- PR の本文を今の状態へ差し替えるなら、`pr-body.md` の中身で PR #253 の本文を置き換える（GitHub の画面、または `gh pr edit 253 --repo syouya0618/irori --body-file "$W/docs/plans/2026-11-10-household-chores/pr-body.md"`）。
- 主 checkout（repo 直下。`main` は origin より遅れ、未 commit 変更あり）には触れていない。そちらで `git add -A` をしないこと。
- force push はしない。追加の修正は新しい commit で足す。

## 2. CI（Draft PR 上）

- `CI`（lint・tsc・vitest・build・proxy の検査・検出器）と `E2E` が走る。**どちらも緑になるまで 3 へ進まない。** `skipped` は実行済みに数えない。step が 0 件で終わった失敗は、テストの成功にも失敗にも数えない。
- `51bd55bc` の結果:
  - `CI` は全成功（run 43025441100）。
  - `E2E` は、`supabase test db` の `chores_rpc_security.sql:166` で DB が SIGSEGV（run 43025441011。CLI 既定の image の不具合）。後続は skipped。
- `fba35d38` の結果:
  - `CI` は全成功（run 43117184040）。CodeQL も成功。
  - `E2E`（run 43117183991）は失敗。中身は下の 3 点。
- `fba35d38` の `E2E` の中身:
  - `db-image-probe`: 106 の手順が、準備の `GRANT … TO CURRENT_USER`（supautils#205）で赤。156 の手順は skipped。
  - `e2e` ジョブで成功した手順:
    - 156 の固定、stack の probe
    - `supabase test db`（拒否試験 175 件を含む）
    - 並行試験 2 本、build
  - `e2e` ジョブで残ったもの:
    - Playwright: 87 passed・1 failed（ごはん①の断言）・1 skipped（家事以外）
    - 最後の「異常終了 0 件」の断定は skipped で、一度も走っておらぬ
- 2 回目の追随の後、次の SHA で初めて確かめるもの:
  - `db-image-probe`: 実の image で、次を観測する。
    - 106: 対照のロールが 42501、anon・authenticated が自分の backend の signal 11
    - 156: 4 ロールとも 42501 で稼働を続ける
    - 準備で落ちれば「fixture: …」で赤になり、`--image` では落ちた文がログに出る
  - stack 上の probe（pgTAP の前）に足した 5 つの赤の条件（`progress.md` の「主経路へ足した、未観測の前提」）:
    - 接続するロールが postgres であること
    - transaction の中の状態の行が期待と一致すること
    - 拒否の行が server log に出ること
    - 通った接続のたびに、残存が 0 であること
    - 最初の probe 以後の crash 行が 0 であること
  - Playwright が全て緑。ごはん①は、揃う区画が 0 件・買い足しは別枠で断ずる。
  - 最後の「異常終了 0 件」の断定。
- ブラウザ: 家事の Playwright は全て Chromium。WebKit（`webkit-iphone`）は `webkit-core.spec.ts` の 1 件だけで、家事は含まぬ。
- 落ちやすい箇所:
  - `db-image-probe` の 106: 呼出しで落ちる前提は、コード上の経路と #214 の再現から言うもので、実の image ではまだ観測しておらぬ。
    - 落ちなければ、それ自体が切り分けの結果ゆえ、probe の期待を見直す（期待を弱めて通すことはしない）。
  - stack 上の probe の「拒否の行が server log に出る」: 根拠は image と CLI の設定を読んだことで、stack ではまだ観測しておらぬ。
    - ここだけが赤なら、ログの読み方を直す。最後の「異常終了 0 件」の断定も空振りしておったことになる。
    - 検査を外して通すことはしない。
  - E2E ジョブの上限（`timeout-minutes: 40`）。
- push の前に人の端末で probe を確かめるなら（任意。正本は CI の amd64）:

  ```bash
  docker pull "supabase/postgres@sha256:21ab971149317ea9cd12a8126fe4ebb34def08c8972956b0958cba0924409dab"
  docker pull "supabase/postgres@sha256:ca7871b587ca2c401ac0f325df6249c9aa0d25647ded34631158efc51176767f"
  "$W/scripts/test-db-execute-denial.sh" --image "supabase/postgres@sha256:21ab971149317ea9cd12a8126fe4ebb34def08c8972956b0958cba0924409dab" --expect crash
  "$W/scripts/test-db-execute-denial.sh" --image "supabase/postgres@sha256:ca7871b587ca2c401ac0f325df6249c9aa0d25647ded34631158efc51176767f" --expect clean
  ```

  - 使い捨ての container を起こして終了時に消す。共有の DB や本番には向けない。

  上限で切れた時は、テストを削らずに上限を上げる。落ちた時はエージェントへ失敗のログ（Playwright の artifact と、`Record isolated database runtime`・probe の出力）を渡せば直す。テストを skip・弱い assert へ変えて通すことはしない。権限を足して拒否試験を通すこともしない。
- Supabase CLI は `2.101.0` に pin したまま（`setup-cli@v1`）。DB イメージは `e2e.yml` の `IRORI_DB_IMAGE_TAG` / `IRORI_DB_IMAGE_DIGEST` の 1 か所で固定する（無条件に latest へは追随しない）。
- 手元で `supabase start` するときは、`supabase/.temp/postgres-version` に同じ tag（`17.6.1.156`）を書いてから起動する（README の検証の節）。`.temp` は gitignore ゆえ書かねば 106 のままで、拒否試験で DB が落ちる。`supabase link` はこの値を本番の版で上書きする。

## 3. 本番 DB への適用（人。merge より前）

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

適用後の確認:

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

アプリを戻す場合も DB の追加は残す（DROP で戻さない）。ごみのトリガだけを無効にしたい緊急時は `ALTER TABLE public.calendar_events DISABLE TRIGGER trg_calendar_events_purpose_default;`（残り 2 本は `event_reminders` 上）で、予定と通知の既存機能は元の挙動になる。

## 4. merge と公開後の確認（人）

1. Draft を解除し、保護条件（必須チェック・必要なレビュー）を満たして通常 merge。
2. Vercel の production deployment が merge commit で READY になったことを確認（HTTP 200・build READY・CRUD 成功は別々に確かめる）。
3. 本番で: `/chores` が開く → 既存の `/baby` `/calendar` `/settings` が従来どおり → ごみ分類を 1 件保存して再読込 → 掃除を 1 件作って完了・取り消し → 食材を登録して「今あるもので」。
4. Push の実端末受信は未確認のまま。家族へ無断のテスト通知は送らない。

## 5. 無料 AI の有効化（アダプター実装済み／実接続は資格情報待ち。しなくても全機能が動く）

資格情報を入れない間は呼び出さず、献立は規則ベースの自動献立で動き、献立ページには「AI 補助は設定されていません。」と出る。実 API の呼出しは 0 回。

1. Cloudflare ダッシュボードで、献立に使う Account が **Workers Free**（Paid ではない）であることを人が確認する。Paid なら無料枠の超過分が課金されるので有効化しない。API からは判定できない。
2. Vercel の production env に `MEAL_AI_ENABLED=true`、`MEAL_AI_ACCOUNT_ID`、`MEAL_AI_API_TOKEN`（Workers AI の実行だけを許す token）を入れて再デプロイ。`MEAL_AI_MODEL` は省略可。AI Gateway・プリペイド・有料モデルは使わない。
3. 実 API 試験は最大 3 回。献立ページで希望（例「金曜はカレー」）を入れて「AI 補助」の表示と解釈結果を確認する。家族の名前・誕生日・育児日記・診断は AI へ送らない（送るのは希望文と候補のレシピ ID だけ）。
4. 同じ Account のニュース AI と 1 日 10,000 Neurons の無料枠を共有する。枠が尽きると（内部コード 3036）、次の 09:00 JST まで AI 呼出しを止め、自動献立は続く。詳細は `docs/runbooks/meal-ai.md`。

## 6. 朝に試す操作

- **食材登録 → 今あるもので → 既存の日へ足す**: 家事 → ごはん → 食材 → まとめ入力に「鶏もも肉 300g、玉ねぎ 2個、卵 6個、お米 2kg」→ 内容を確認して登録 → 設定で常備品（油・塩・しょうゆ等）を選ぶ → 「今あるもので」。常備品を選ばないと、調味料が要る料理は「揃う」に出ない（未登録の調味料を在庫ありと数えないため）。「豚肉」「鶏肉」のような総称で登録した在庫は材料に数えない（部位が分からないため。画面に直す導線が出る）。候補の「献立に入れる」は、料理が在る日にも 1 品だけ足す（在る料理と固定はそのまま）。
- **使わない食材**: ごはん → 設定 → 使わない食材。一覧（消費者庁の対象品目）か食材名で登録すると献立と在庫提案から必ず外れる。自由入力で判定できない語は「適用済み」と出ず、対象品目・食材から選び直す釦が出る。手で入れた料理は、材料が未登録・使わない食材に当たる時、保存はできるが献立の確定が止まり、理由が出る。確定した後に除外を足すと、当たる料理の材料は「献立から更新」で買い物から外れ、買い物の画面に料理名と理由が出る（献立はそのまま）。判定できない語をアレルギーとして登録すると、選び直すまで献立の確定と買い物の自動の更新が止まる。買い物のリスト・購入の記録・手で足した項目は残り、「要再確認」と出る。アレルギーで「豆乳」「鶏もも」を選ぶと、「大豆」「鶏肉」を品目として登録する候補と外す範囲が出る（押したときだけ登録。苦手には出ない）。
- **取り分け**: 設定で子どもの「食事の段階」を保護者が選ぶまで、取り分け案内は出ない（月齢だけでは出さない）。
- **金曜を固定 → 7 日分 → 買い物 → 家族のアカウントで購入チェック**: 献立 → 日数を 7 日に → 希望に「金曜はカレー」→「希望を反映」→ 読み取り結果（金曜にカレーを固定）を確かめて「この内容で献立を作る」→「この献立で確定」→「買い物リストを見る」。家族のアカウントで同じ世帯に入り、買い物を開いてチェック。相手の端末への反映は、画面へ戻ったときと表示中の定期再取得（即時の push ではない）。
- **作った → 取り消し**: 一部だけ買った料理を「作った」にしてから取り消すと、買い物の不足が元へ戻る。購入の記録は消えず、在庫は増えない。
- **ごみ**: カレンダーでごみの予定を開く → 「ごみの日にする」→ 範囲（この回だけ／シリーズ全体）と通知（前日 20:00）を選ぶ → 月表示と家事 → ごみで確認。
- **掃除**: 家事 → 掃除 → 項目を追加（テンプレートは入力欄を埋めるだけ）→ 完了 → 直後に取り消し。「実施した日から数える」項目の回をスキップすると、次回はその回の予定日から 1 周期後。
