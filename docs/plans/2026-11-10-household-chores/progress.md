# 家事（ごみ・掃除・ごはん）進捗記録

## 現在地（2026-11-13、公開直前）

- PR #253 は Draft・未 merge。新機能の本番配信と家族端末での確認は未実施。
- `e005eac7` で X-07 の利用者JWT直呼びによる数量検査を追加した。負の在庫・買い物・購入数量、超過補充、補充済み購入の引下げは `22023`、拒否後の状態は不変。
- 上記 HEAD の CI 43335009948、E2E 43335009962（db-image-probe を含む）、CodeQL 43335009964 が成功。検証対象はCIの隔離Supabaseで、本番DBへテストデータは投入していない。
- Vercel個人チームの `irori` プロジェクトを直接照合済み。Productionは `main` の `521f2fc2`、READY。配信中のJavaScript内のSupabase URLが、3本のmigrationを入れた `irori-prod` と一致した。Previewは `e4d7e37b` で READY を確認済み。
- 本番DBバックアップは利用者が取得しないと決定した。バックアップや復元試験を実施したとは扱わない。
- 次は、この文書更新の新SHAでCIとE2Eを再確認し、PRを通常mergeして本番デプロイと公開後の画面動作を検証する。iPhone Safari実機・Push実受信・無料AI接続は未実施。

## 現在地（2026-11-12 夕方。以下は当時の履歴）

- worktree: `.claude/worktrees/kaji-gomi-souji-gohan-20261110`
- branch: `worktree-kaji-gomi-souji-gohan-20261110`（基点 `521f2fc2`。`main` もまだ `521f2fc2` のまま。GitHub の公開 API で確認）
- PR #253（https://github.com/syouya0618/irori/pull/253）は **Draft・未 merge**。head は `314fbd9c`。人が `51bd55bc`〜`314fbd9c` の 7 つの commit を作り、push した。
- `314fbd9c` で `CI`・`E2E`・`CodeQL` が成功した（公開 API で確認）。
- 本番 DB へ migration 3 本を 2026-11-12 に適用済みで、適用後の監査は PASS（利用者の報告）。本番アプリへのデプロイと、本番での実操作は未実施。
- この文書を含む 4 本の公開前の整理は、worktree に未 commit。公開の手順は `handoff.md` の冒頭。詳しくは末尾の「2026-11-12 夕方時点の最終状態」の節。

## 着手時の確認（2026-11-10〜11）

- 主 checkout（`main` = `b50c7eaa`、origin より 21 commit 遅れ）には利用者の未 commit 変更が多数ある。触れずに専用 worktree へ分離した。
- 既知の別作業 `codex/irori-pwa-cron-ux-hygiene-20261102` は worktree が `/private/tmp` にあり prunable。取り込み・破棄・完了扱いはしていない。
- デプロイ先の照合: Supabase コネクタは Irori プロジェクトへの権限が無く、Vercel コネクタは別チームのスコープで 403。設定ファイルと運用文書に記載の project ref までは確認できるが、実接続先との照合は未実施。

## 判断

| 判断 | 理由 |
|---|---|
| BottomNav を 4 タブにし「家事」を追加。起動時ページと SW の APP_PAGES には足さない | 320px で 5 タブは限界。DB CHECK と SW バイト列を動かさず、既存導線を保つ |
| 新規表は SELECT のみ GRANT、書込は SECURITY DEFINER RPC（saved / replayed / conflict） | 2026-10-30 以降の新規表の流儀。直接 DML の権限を持たせない |
| ごみ分類は `(household_id, scope, target_key)` の別表。calendar_events に列を足さない | google 行は authenticated から更新できず、410 再同期で行 ID が変わるため |
| ごみ通知は既存 `event_reminders`（`prev_day_20`）へ接続。新しい kind・cron・worker なし | 二重送信防止と送信直前の再確認を既存経路に任せる |
| ごはんの表は旧名を避ける（`pantry_items` `dinner_plan_entries` `grocery_items` 等） | 旧テーブルの DROP migration が本番適用済みか repo から判定できない |
| レシピカタログはコード同梱、DB seed なし | 投入が常に冪等。本番へテストデータを入れない |
| 他端末反映は visibility refetch + 表示中の定期再取得。Realtime publication には足さない | 既存方針（本番で postgres_changes が間欠不達との注記あり） |
| 献立の AI は希望文の構造化と候補 ID の並べ替えだけ。計画の正本は規則ベースの純関数 | AI 停止・無料枠終了でも全機能が動く |

## 検証環境（着手時の記録。今の結果は末尾の「最終状態」の節）

| 環境 | 状態 |
|---|---|
| vitest / tsc / eslint / next build / CI 検査スクリプト | 利用可（worktree に依存導入済み） |
| DB（migration・RLS・RPC） | Docker とネイティブ Postgres は sandbox で不可。代替としてプロセス内 PGlite（PG 17.5）＋ Supabase スタブ＋本物の pgTAP のハーネスを scratch に用意。現行の migration 55 本・pgTAP 35 ファイル 941 アサーションが全緑になることを確認済み。単一接続のため真の並行性は検証できない。CI の `supabase test db` の代わりにはならない |
| ブラウザ実操作・Playwright | ローカルポート bind が sandbox で不可（EPERM）。未実施 |
| GitHub Actions | push できないため未実行 |

## 失敗した方法と理由

- `git fetch`: git guard が読み取り専用 allowlist 外として拒否。
- `gh auth status`: sandbox が認証情報の読み取りを拒否。
- `docker ps`: Docker socket への接続が拒否。
- `initdb`（Homebrew PostgreSQL 17）: `shmget` が拒否され起動不可。
- ローカルポート bind: EPERM。
- Supabase / Vercel コネクタ: 対象プロジェクトへの権限なし（別アカウント・別チーム）。

## 外部ブロッカー（着手時の記録。commit・push・PR・CI・本番 DB への適用は、その後に人が行った。今の状態は末尾の「最終状態」の節）

| 操作 | 状態 | 解消に必要な最小操作 |
|---|---|---|
| commit / push / PR / CI | blocked（git guard と sandbox） | 人が trusted terminal で commit・push・PR 作成 |
| 本番 DB への migration 適用 | blocked（Supabase CLI の資格情報は sandbox 外。コネクタは権限なし） | CI の DB テスト通過後に人が適用 |
| merge / 本番反映 | blocked（上に依存。運用契約でも人の操作） | 人が実施 |
| 無料 AI の実接続 | blocked（アカウントが Workers Free かを API から判定できず、env にも触れられない） | 人がダッシュボードで Free を確認し env を設定 |

## 経過

| 時刻（JST） | 出来事 |
|---|---|
| 11-10 23:50〜11-11 00:45 | 現状確認、要件台帳の固定、設計メモ、DB 代替ハーネス、一次資料の確認 |
| 00:45〜01:25 | 第 1 波: 共通基盤、献立のカタログ（49 品）・純粋ロジック・DB（10 表・RPC 22 本）・AI アダプターが完了。各担当の単体テストと pgTAP（PGlite）は緑 |
| 01:25 頃 | **利用枠切れで停止**。ごみ・掃除は書きかけ、献立の統合テストは未着手のまま止まった |
| 07:35 | 利用者の「再開」で続行。ごみ・掃除を書きかけから再開し、献立の統合テスト → サーバー層 → Action → 画面 → 横断ゲートを連結して実行 |

第 1 波で分かったこと:

- 既存テスト `src/lib/domain/__tests__/calendar-pending-creates.test.ts` の 5 件が今日の日付で赤（対象ソースは未変更。固定日付と 7 日の期限による時限式の失敗と推測）。横断ゲートで原因確認と最小修正を行う。
- 小麦・大豆のアレルギー指定では、しょうゆ・サラダ油由来で主菜の自動候補が 1〜2 件まで減る。除外規則は緩めず、該当調味料を使わないレシピをカタログへ足して補う。
- AI のエラー本文の形（`errors[].code`）と JSON Mode の指定形は公式ページの要約に基づく実装で、実 API では未確認。

## 2026-11-11 11:10 時点の状態（利用枠切れで 3 度目の停止）

- 3 機能の実装は出揃い、独立レビュー（8 観点・指摘 48 件、重大 1・高 3 は反証検証で本物と確認）を実施済み。指摘の全文は scratch の `review-findings.md`（repo 外）。
- 修正済み（各担当の単体テスト・pgTAP は緑）: 献立の純粋ロジック（R01 R02 R21〜R29）、共有の保存・再取得（R04 R34 R39〜R41）、ごみ（R05 R07〜R13 R38）、掃除（R15〜R20、R33/R37 の掃除分）。
- **修正の途中で停止**: 献立のサーバー側（R03 R06 R30 R31 R32 R43 R45 R46）と画面側（R35 R44 R48、R33/R37 のごはん分、R01・R45・R46 の画面側）。R03（買うべき食材が買い物リストから消える）は SQL 側に修正が入った形跡があるが、検証を終えていない。
- 停止直前の計測: `tsc --noEmit` エラー 0。PGlite で migration 58 本・pgTAP 38 ファイル 1594 件 緑。vitest 6141 件中 7 件 赤（取り分け案内を「食事段階が未設定なら出さない」へ厳しくした修正に伴う fixture の更新待ち。`recipe-detail.test.tsx` 4、`pantry-now-recipe-settings-pages.test.tsx` 1、`server/__tests__/views.test.ts` 2）。その後に担当 2 本が編集を始めて中断したため、**再開時はまず tsc と vitest を流して現状を測り直すこと**。
- 未着手: 全体ゲートの再実行、要件台帳の証拠記入（全 ID が `pending` のまま）、引き継ぎ手順書、`src/lib/types/database.ts` の掃除 2 表への `cadence_epoch: number` 追記、本メモ「設計」節の更新（ごみ RPC の 7 引数化、掃除の周期の世代）。
- 未実行のまま: `pnpm build`（sandbox で完走せず 3 回停止）、Playwright、実ブラウザ、CI、本番 DB、無料 AI の実 API、commit / push / PR。

## 2026-11-11 13:40 時点の状態（修正ラウンド完了）

- 上の「修正の途中で停止」分を再開して完了した。献立のサーバー側（R03 R06 R30 R31 R32 R43 R45 R46）は中断前の実装が成立しており変異で検知力を確認、純粋ロジックの結果を画面へ運ぶ配線を追加。画面側（R35 R44 R48、R33/R37、R01・R45・R46 の表示）も修正。
- 独立レビューの指摘 48 件（重複 6 組を含む）は、重大 1・高 3 を含め全件に手を入れた。反証は 1 件（食材画面の R35 は送信中に編集釦が無効で再現しない）。一部だけ直して制限を残したものは下に列挙する。指摘の全文は `review-findings.md`（同ディレクトリ）。
- 残した既知の制限（利用者に見える影響）。**R48・R03・R17・R35 は 17:30 の節の ①〜④ で修正済み**（ここは当時の記録として残す）:
  - ~~R48: 「今あるもので」・レシピ詳細から献立へ入れられるのは、その日に献立がまだ無いときだけ（既存の枠へ 1 品足す op が無い）。~~ → ④
  - ~~R03: 「作った」を取り消しても、差し引いた購入量は戻らない。~~ → ①。同日に同じ料理が複数あると、日付が過ぎるまで差し引かれない。購入を「在庫へ追加」でなく食材画面で手入力すると二重に数える。
  - R05: 今日以降に通知の付いた回が 1 つしか無いシリーズを予定シートで「なし」にすると、個別の停止として記録される（勝手に戻さない側）。
  - ~~R17: 鍵が予定日から逃げた回をスキップすると、次回が 1 日後ろへずれる。~~ → ②
  - ~~R35: 保存応答が送信中に開いた別のシートを閉じる件は、ごはんの画面だけ修正。掃除・ごみの画面は未修正（入力が消えるだけで、誤保存はしない）。~~ → ③
  - 小麦・大豆などのアレルギーでは候補が減る（主菜 9〜10 件）。7 日に足りなければ不足枠として表示する。
  - 材料つきで登録した手動料理は、料理名と登録した材料だけで除外を判定する。料理名にも材料にも品目が現れないもの（例: かにアレルギー ×「クリームコロッケ」に じゃがいも だけ登録）は警告されない。⑤ で、材料が未登録・辞書に無い材料の料理は「未確認」として確定を止めるようにした。登録した材料が全部辞書で解決でき、どれも当たらない場合は従来どおり「問題なし」になる（登録した材料が実物と違う場合は見抜けない）。
  - 「使わない食材」の自由入力で、品目名を 1 つも含まない語（例「からいもの」）は何も除外できない。苦手なら登録時と一覧にその旨を出し、アレルギーなら献立を自動では確定しない。
- 要件台帳は監査担当が証拠を記入した（112 行: verified 71 / in_progress 33 / blocked 8。**2026-11-11 夕方の時点では verified 67 / in_progress 37 / blocked 8**。実 Supabase での確認を利用者が求めた X-06・X-07・C-71・V-AUTH を、PGlite だけでは verified と言わぬよう in_progress へ戻した）。in_progress の大半は「受け入れ手順が画面の実操作を求めるが、jsdom のコンポーネントテストまで」。監査の指摘を受け、名前の一致が無い「苦手」の自由入力を、含まれる品目へ広げて除外するよう直した（「卵料理」→ 卵）。修正後の全体テストも 6250 件 緑。
- 最終ゲート（13:36〜13:40 に実行）:

| ゲート | 結果 |
|---|---|
| `pnpm lint` | 指摘 0 |
| `pnpm exec tsc --noEmit` | エラー 0 |
| `pnpm exec vitest run` | 328 ファイル 6250 件 全緑 |
| `check-transition-reject-guard.py --strict` | 違反 0（checked 21） |
| `check-transition-all.py --strict` | 違反 0（checked 770） |
| `check-supabase-error-destructure.py --strict` | 直接実行は hook が拒否。同じ検出器を src 全体へ流す `src/lib/__tests__/check-supabase-error-destructure.test.ts` は上の全体実行に含まれ緑 |
| PGlite（既定） | migration 58 本、pgTAP 38 ファイル 1594 件 全緑 |
| PGlite（`--default-privileges revoked`、家事の 3 本） | 653 件 全緑 |
| `pnpm build` / `check-proxy-effective.py` | **未実行**（sandbox で完走せず） |
| Playwright / 実ブラウザ / CI / 本物の Supabase / 本番 / 無料 AI の実 API | **未実行** |

## 2026-11-11 17:30 時点の状態（残っていた 5 件の修正・X-07 の検査・CI への追加）

利用者の指示（2026-11-11）で、上に「残した既知の制限」としていた 5 件を限界として残さず直した。どれも先に赤で再現し、修正後に緑、修正を一時的に戻して赤へ戻ることを確かめ、元のバイト列へ戻したことを shasum で照合した。

| 件 | 原因 | 修正 | 赤の証拠 |
|---|---|---|---|
| ① 作った／取り消しの数量（旧 R03 の残り） | 「作った」で購入の数量そのものを減らしていた。取り消しても戻らず、他の端末の追加購入と区別できない | 購入（`purchased_quantity`）は事実として残し、作った料理への充当を別の列（`consumed_quantity`・`consumptions` の内訳）で持つ。取り消しは自分の充当だけを外し、二重に戻さない。在庫の充当量は 購入 − 補充 − 充当 | pgTAP（dinner_tables.sql）と Action テストが修正前に赤 |
| ② B-07f（旧 R17） | after_done のスキップが「鍵の日付の翌日」を起点にしていた | 回の予定日をサーバーが `cleaning_logs.scheduled_on` に記録し、スキップはその予定日から 1 周期後を次回にする（JST）。最後に実施した日は動かさない。再送で二度進まない | cleaning_routines.sql と cleaning-schedule.test.ts が修正前に赤 |
| ③ 遅れた保存応答（旧 R35 の掃除・ごみ分） | 応答が、送信中に開いた別のシートを閉じ、入力を消していた | 保存のたびに編集の回（利用者・世帯・対象・回の番号・操作 ID）を捕まえ、同じ回のときだけ閉じる・消す・エラーを出す。同じ対象を開き直しても新しい回 | use-chore-save.test.tsx と画面のテストが修正前に赤 |
| ④ 在庫提案から既存の日へ足す（旧 R48） | 「献立に入れる」が献立の作り直し（generate）を流用し、料理の無い日しか送れなかった | 1 品だけを足す操作（`add_recipe` / `addDinnerRecipe`）を足した。在る料理と固定は触らない。差し替えは明示の対象があるときだけ。最初の押下で ID・位置・人数・状態を固定し、再送で二重にならない。新しい RPC は無く、既存の `save_dinner_entry` に版 NULL で 1 行を入れる | 画面のテスト 14 件中 6 件が修正前に赤 |
| ⑤ 手動料理の除外（旧 R02 の残り） | 料理名だけで判定し、材料が未登録・辞書に無い材料を「当たらない」と扱っていた | 判定を「問題なし／当たる／未確認」の 3 つにした。材料の正規化 ID・派生・アレルゲンでも当て、原材料が分からなければ未確認。確定は当たる・未確認が 1 品でも在れば止める（固定・手動の料理を含む）。部分一致の誤り（焼きそば→そば、豆乳→乳、鶏もも→もも、さけるチーズ→さけ）を隠す語の一覧で防ぐ。解決できない語は「適用済み」と見せず、具体的な品目を選び直す釦を出す | 判定 73 件中 11 件、Action 2 件が修正前に赤 |

あわせて直したもの:

- **補充の上限を RPC で守る**: `restock_pantry_from_grocery` が、量で追う購入は 購入 − 補充 − 充当 を超える補充を 22023 で拒む（以前は Action だけが守り、RPC を直に呼ぶと購入より多く足せた）。量の分からぬ補充は充当量を減らさぬゆえ、1 行につき 50 回までは繰り返せる（量の勘定は崩れない）。
- **判定できないアレルギーの説明を正確にした**:
  - 旧: 「どの料理も自動では確定しません」。⑤の後は、全料理が未確認になり、確定は自動でも手でも止まる（`confirmDinnerPlan` と 1 品の追加が未確認の料理を拒む）。
  - 新: 「料理の原材料を確かめられず、献立を確定できません」。今あるもので・献立・今夜・設定（登録の前・後・登録済みの一覧）の文を直した。
  - 画面のテストに「自動では確定」と出ないことの確認を足した。旧い文言を期待していた 10 件は、文言の変更で赤になったのを確かめてから期待値を直した。
- **X-07 の採用方式を確定**: 「SELECT 用の RLS ＋ 直接 DML の GRANT もポリシーも無し ＋ 認可済みの SECURITY DEFINER RPC だけが書く」。ポリシー数を揃えるための書込 GRANT・拒否ポリシーは足さない。新しい横断検査 `supabase/tests/chores_rpc_security.sql`（175 件）で実効の権限を確かめる。権限を 3 か所緩める変異で 3 件が赤になることを確認した。
- **アレルゲン一覧の照合**: `allergens.ts` の 29 品目（義務 9・推奨 20）が、消費者庁の別添の逐語と一致することを確かめた。カシューナッツは義務、ピスタチオとマカダミアナッツは推奨に在り、まつたけは無い。変更は不要だった。
- **CI に足した検証**（どれも E2E ジョブの中で、ローカルの Supabase に対して走る）:
  - `e2e/chores-rpc-auth.spec.ts`: 本物の Auth でパスワードログインした利用者の JWT で RPC を直に呼ぶ（Action を通さない）。他の世帯・子ども閲覧招待の受諾者・未ログインは 42501、直接の INSERT も 42501、再送は replayed、古い版は conflict。
  - `scripts/test-chores-concurrency.py`: 2 本の接続で本当に同時に書く。掃除の同時完了、取り消しと完了、同じ版での名前の変更、買い物の購入と「作った」の取り消し、古い版の購入。片方がロックを待っていることを `pg_stat_activity` で確かめてから進める。
  - 献立・掃除・ごみの Playwright（5 件それぞれと、在庫登録 → 在庫提案 → 既存の日へ追加 → 7 日分 → 買い物 → 再読込の流れ、2 アカウントで献立と購入の共有）。家事の 10 画面を 360px で横にはみ出さないかの検査。

最終ゲート（独立レビュー 2 回目の修正の後、18:29〜18:35 に統括が実行）:

| ゲート | 結果 |
|---|---|
| `pnpm lint` | 指摘 0 |
| `pnpm exec tsc --noEmit`（e2e を含む） | エラー 0 |
| `pnpm exec vitest run` | 329 ファイル 6370 件 全緑。統括が 3 回続けて流し、3 回とも全緑。担当の全体実行で 1 回だけ `calendar-pending-creates` の storage イベントの 1 件が落ちた（単独・再実行では緑）。揺れは 1 回で、原因は確かめておらぬ。CI で再び出たら、カレンダーの保存の応答の処理（`calendar-view.tsx`）との関係から見る |
| `check-transition-reject-guard.py --strict` | 違反 0（checked 21） |
| `check-transition-all.py --strict` | 違反 0（checked 771） |
| PGlite（既定） | migration 58 本、pgTAP 39 ファイル 1944 件 全緑（dinner_tables 461、chores_rpc_security 175） |
| PGlite（`--default-privileges revoked`） | 39 ファイル中 35 緑。落ちる 4 本（child_sharing・children_scope・feeding_amount_history・membership_gate_rls）は、家事の migration 3 本を除いた写しでも同じ 42501 で落ちる。もともと既定の権限に頼っている既存の試験で、今回の差分とは関係ない（CI の Supabase は既定の権限ありで、そこでは緑） |
| 並行試験の筋（同じ RPC 呼出しを PGlite で順に流す） | 30 件 全緑（scratch。書き換わった script の筋に合わせて取り直した。真の並行性の証拠ではない） |
| `scripts/test-chores-concurrency.py` | py_compile のみ |
| `pnpm build` | **未完走**。4 回目は、`next/font/google` が取りに行くフォントの取得先（fonts.googleapis.com・fonts.gstatic.com）を許して試した。それでも前の 3 回と同じ「Creating an optimized production build ...」で 10 分以上止まり、止めた。原因はフォントの取得ではない。sandbox の中で Turbopack の build が進まぬ理由は特定できておらぬ。これ以上は試さず、CI の `Build` と proxy の検査で確かめる。追跡しておるファイル（`next-env.d.ts`）は変わっておらぬ |
| Playwright / `supabase test db` / 2 接続の並行試験 / CI / 本番 / 無料 AI の実 API | **未実行**（CI でだけ走る。本番と AI は人の操作） |

### 5 件の修正の独立レビュー（2 回目、2026-11-11 夕方）

修正を書いた担当とは別の担当が、コードを読んで確かめた（読むだけで、実行はしておらぬ）。指摘は 8 件。各担当が赤で再現してから直し、変異で検知力を確かめた。

| 指摘 | 中身 | 結果 |
|---|---|---|
| 重 1（⑤） | 確定済みの手動料理を、除外に当たる内容へ直しても確定のまま残る。取り消しでも検査なしで確定へ戻る | 修正済み。判定が「問題なし」でなければ提案へ落として知らせる（`actions-review.test.ts`、修正前は 5 件が赤）。料理名「オムレツ」の例は再現せず（料理名から材料を知る辞書が無い）。テストの例は「たまごサラダ」に替えた |
| 重 1 の関連 | 除外を足した時点で確定済みの料理が、買い物の自動計算に入り続ける | 修正済み。献立は書き換えず、同期の時に、献立の画面と同じ判定で「問題なし」でない確定の料理（当たる・未確認）の材料を必要量から外す。買い物の画面に料理名と理由を出す。除外を読めない時は同期を止める（fail-closed）。修正前は 2 件が赤。e2e ⑥ を追加 |
| 重 2（①） | 過ぎた日の確定の枠で「作らなかった」→ 取り消すと、充当の記録が失われる | 修正済み。記録は消さずに眠らせ、また食べた扱いになれば起こす。台帳を書く処理を `irori_private.dinner_grocery_settle` 1 つにまとめた |
| 重 3（①） | 補充の上限が、同期でしか更新されぬ充当量に頼っておる | 修正済み。「作った」・購入・補充の RPC が、書く前に台帳を枠の今の状態へ合わせる |
| 中 4（①） | 画面からは「作った後に別の端末で +100」を記録できぬ | 修正済み。購入の版は「購入を最後に書いた時刻（`purchase_updated_at`）以後で、今の版を超えない」なら通す。購入の事実が後から変わっていれば conflict のまま。手動の項目の品名・単位の変更と、同期による単位の変更も購入の版を進める（単位が変わる前の画面の量を、新しい単位で書かぬため。わっちの点検で見つけ、修正前は 4 件が赤）。e2e「作る前に家族の端末で開いた買い物から、作った後に +100g …」を追加 |
| 中 5（④） | 結果不明の追加を確かめ直すと、他の端末が消した料理が蘇る | 修正済み。最初の押下で献立の版を固定し、行が無く版が違えば書かずに conflict（修正前は 1 件が赤） |
| 軽 6（①） | RPC を直に呼ぶ時の守り（同期の出所・購入量の下限・状態の遷移） | 修正済み。同期の出所は世帯の確定の枠だけで、出所の量の合計は必要量まで。購入の合計は「在庫へ足した量＋充当」より下げられぬ。新しい枠は提案か確定だけで、作った ↔ 作らなかった の直の付け替えは不可。どれも 22023 |
| 中 7（③） | ごみの遅れた応答が、別の予定・同じシートの通知の欄を古い値へ戻す | 修正済み。今の編集の回の時だけ、かつ通知の書込が送信中でない時だけ読み直す（修正前は 2 本が赤） |
| 低 8（⑤） | 「なす科」が「なす」へ縮んで、適用済みに見える | 修正済み。「〜科」は「含む」で解決せず、判定できない語として扱う（修正前は 2 件が赤） |

台帳の修正（重 2・重 3・中 4・軽 6）は pgTAP の §20（53 本）と §21（13 本）で固めた（dinner_tables は 461 本）。修正前は §20 で 15 件、§21 で 4 件が赤。修正を一時的に戻す変異も 7 種でそれぞれ赤を確かめた。

利用者から見える影響（安全側として据え置き）: 判定できないアレルギーの登録が 1 件でも在ると、全料理が未確認になる。献立の確定が止まり、買い物の自動の項目も全部外れる。設定で一覧から選び直せば、該当する料理だけが外れる。画面はその理由と直す場所を出す。→ **2026-11-11 夜に改めた**: 買い物の自動の項目は外さず、自動の更新を止めて今のリストを残す（下の「2026-11-11 23:30 時点」）。

利用者に決めてほしいこと: 「豆乳」「鶏もも」のように食材止まりで登録したアレルギーを、アレルゲン全体（大豆・鶏肉）へ広げるか。今は R23 の方針どおり食材止まりで、「豆乳」アレルギーでも豆腐の料理は外れない。広げる場合は辞書の `allergySpread` で一括に決める。→ **2026-11-11 夜に決定**: 黙って広げず、品目として登録する候補と範囲を示す（下の節）。

## 2026-11-11 23:30 時点の状態（PR #253 の初回 CI を受けた追随。→ 人が `35d55586`・`fba35d38` として commit・push 済み）

### 初回 CI の結果（利用者の報告。エージェントは `gh` の資格情報を読めず、ログを直に見ておらぬ）

| run | 結果 |
|---|---|
| `CI`（43025441100） | 全成功: lint・型検査・329 ファイル 6370 件・production build・追加検査。手元で止まった build の原因は未特定のまま（CI では成功） |
| `E2E`（43025441011） | 失敗: `supabase test db` の `chores_rpc_security.sql:166` で Postgres が SIGSEGV。175 件中 25 件の後に接続を失った。後続（並行試験・実 Auth・Playwright）は skipped で、実行済みに数えない |

### DB のクラッシュ: 原因と直し方

| 項目 | 確かめたこと（一次資料） |
|---|---|
| 原因 | CLI 2.101.0 の既定 `supabase/postgres:17.6.1.106` は supautils 3.2.0 を同梱（supabase/postgres の tag `17.6.1.106` の `nix/ext/supautils.nix`）。3.2.0〜3.2.1 は `supautils.hint_roles`（anon・authenticated・service_role）が EXECUTE を持たぬ関数を呼ぶと、42501 ではなく backend が落ちる（supabase/postgres#2112、supabase/supautils#214。3.2.2 の supabase/supautils#190 で修正。保守者の記述では影響は 17.6.1.099〜.112、修正は 17.6.1.155 以降）。166 行目は anon が EXECUTE の無い RPC を呼ぶ `throws_ok` で、25 件の数も合う |
| 固定した版 | `17.6.1.156`（supautils 3.4.0。同じ nix 定義）。Docker Hub の index digest `sha256:ca7871b587ca2c401ac0f325df6249c9aa0d25647ded34631158efc51176767f`。この digest は、#2112 の独立報告「amd64 で 42501・2 回同じ結果」の digest と一致する。CLI 本体も 2026-07-29〜08-05 にこの版を既定として出した（CLI の Dockerfile の commit 履歴） |
| CLI の仕組み | CLI 2.101.0 の `apps/cli-go/pkg/config/config.go` の `Load` は、`supabase/.temp/postgres-version` があればその tag で DB イメージを差し替える（`replaceImageTag` は前後の空白を落とす）。`internal/utils/docker.go` の `DockerPullImageIfNotCached` は、docker.io のとき `supabase/postgres:<tag>` が手元にあれば pull しない。CLI の起動処理の版による分岐は「15.8.1.005 未満か」だけで、106 と 156 は同じ分岐を通る |
| 直し方（`e2e.yml`） | tag と digest を workflow の env の 1 か所へ置く。`supabase start` の前に、digest で pull して CLI が使う名前で tag を付け、`.temp/postgres-version` を書く。起動後、container の image ID が固定した digest の image ID と一致することを断ずる（違えば赤）。pgTAP の前に stack 上で最小再現の probe を流す。ジョブの最後に DB のログで異常終了 0 件を断ずる。時間の枠は 40 分 |
| 最小再現（`scripts/test-db-execute-denial.sh`） | 単純な SQL 関数を作って EXECUTE を外し、ロールになって呼ぶ。1 つの transaction の中で作って ROLLBACK するので、関数もロールも残さぬ（2026-11-12 に改めた。`--image` は準備・呼出し・後始末を別の接続へ分け、`--container` はロールごとの transaction と ROLLBACK のまま。下の「`fba35d38` の CI」の節）。別ジョブ `db-image-probe` で、Docker だけで（CLI も stack も通さず）2 版を digest で起こす: 106 は anon・authenticated が signal 11 で落ち、hint_roles に無いロールは 42501（対照）。156 は 4 ロールとも 42501 で、同じ接続も server も生き続ける。どちらかの期待が外れれば赤 |
| 採らなかった方法 | 権限を足す・拒否試験を消す・静的な権限確認だけにする・skip・continue-on-error。CLI の更新（2.101.0 の固定を保つ）、17.11 系への更新（minor が変わる） |
| ライブラリの版の記録 | PostgreSQL 17 の supautils は module magic に版を持たぬ（`PG_MODULE_MAGIC_EXT` は 18 以上）。SQL からは版を読めないので、probe は `.so` の sha256 と path を記録し、版は image の nix 定義から言う。決め手は amd64 での挙動 |

手元で行った確認（Docker は sandbox が拒み、`initdb` は `shmget` で止まるので、実の Postgres では走らせておらぬ）:

- `shellcheck`: 警告 0。
- probe の判定の流れ: `docker` を模した shim で 10 通り、全て期待どおり（正常 2・陰性の対照 5・入力の拒否 3）。陰性の対照は次の 5 つ:
  - 固定版で「落ちる」を期待すると赤;
  - anon が落ちるのに「42501」を期待すると赤;
  - 対照のロールまで落ちると赤;
  - 接続が切れても server のログに異常終了が無ければ赤;
  - supautils が読み込まれておらねば赤。
- probe の SQL: PGlite（PG 17.5）で 4 ロールとも 42501。ROLLBACK の後に関数もロールも残らぬ。supautils が無いので、落ちる経路そのものは PGlite では見られぬ。
- workflow: YAML を読み、次を確かめた:
  - 2 ジョブ・22 手順の順序（pin → start → 記録と digest の断定 → probe → pgTAP → 並行試験 → Playwright → 異常終了 0 件）;
  - `continue-on-error` も条件つきの手順も無い（`if: failure()` の 2 つを除く）。

**CI ではまだ一度も走っておらぬ。** 人が push した後の `E2E` で初めて確かめられる（→ `fba35d38` で走った結果は下の節）。

### 前回決めた追記の反映

| 件 | 中身 | 赤の証拠 |
|---|---|---|
| 未解決アレルギーの保留 | 判定できないアレルギーの登録がある間は、買い物の同期を送らない（`grocery-sync.ts` の `held`）。今のリスト・購入量・手動項目・充当の台帳はそのまま。画面は「要再確認」の帯と自動項目の印、献立を変えた後・補充の後の応答も同じ理由を返す（「献立から更新を押して」とは言わない）。献立の画面は「買い物が古い」と言わず、保留の文に買い物を止めておることを足した | 修正前: 未知語を足した同期で、必要な自動行が 11 → 0 件（買った豚こまは「不要」にされ出所が消えた）。修正を外す変異で赤へ戻る |
| 未知語の追加 → 解決 → 再計算 | 購入 300g は残り、豚こまの行は 1 本のまま（同じ ID）、止めておる間に作った 300g は 1 回だけ数え、2 回同期し直しても変わらない | shopping/actions.test.ts の同名の試験 |
| 大豆・鶏肉の品目の候補 | アレルギーで「豆乳」「鶏もも」を選ぶ・打つと、含む対象品目を品目として登録する候補と、個別・品目それぞれで外す範囲を出す。押したときだけ品目を登録（同じ「誰の分」）。登録済みの一覧でも、元の登録は書き換えず「も品目として登録」を出す。苦手には出さぬ | 変異 3 種（苦手にも出す・加工品の値を根拠にする・既に広がる品目も出す）でそれぞれ狙った試験だけが赤 |
| 「オムレツ」 | 材料の無い手動料理は既に未確認として確定を止める。料理名の辞書は足さぬ | — |
| 無料 AI の記述 | 「任意」を「アダプター実装済み／実接続は資格情報待ち」へ: README・`env.example`・`CHANGELOG.md`・献立とニュースの runbook。無課金の条件と、資格情報が無いときに呼ばぬ構成は変えておらぬ | — |

### 独立レビュー（3 回目、今回の差分。読むだけで実行はしておらぬ）

| 指摘 | 中身 | 結果 |
|---|---|---|
| P2-1 | 止めておる間に料理を「作った」にすると、RPC が充当（300g）を記録するが必要量（500g）は古いまま。「あと 500g」と出て、「必要量まで購入」は 800g を記録しうる | 修正済み。台帳（`consumptions`）で数えておる記録のある枠の出所の量を、今の必要量から引く（`outstandingRequired`）。正しく同期した後は重ならぬので 0。読めない要素・眠った記録は引かない（必要量を減らす側へ倒さない）。修正前は赤（あと 500g）、修正を外す変異で 2 件が赤。前提の形（settle は `sources` を書き換えず、台帳に `k`＝枠の ID・`on=true` の記録を積む。同期は出所の JSON をそのまま保存し、`set_grocery_purchase` は `required_quantity` を使わぬ）は migration の本文で確かめ、pgTAP `dinner_tables.sql` §20 (iii') の 3 件で固定した |
| P2-2 | 止めておる間に確定の料理を直して提案へ戻すと、文が「今のリストはそのまま」と「買い物リストからも外れます」を同時に言う | 修正済み。止めておる間は「材料はリストに残ります。要再確認」と言う。修正前に赤 |
| P3 | 「品目で登録済み」を品目の登録だけで数えていた（素の食材「大豆」の登録も大豆全体を外す） | 修正済み。判定と同じ `buildExclusionSet` のアレルゲンの規則で数える。苦手は数えない。修正前に赤 |
| P3 | 最後の異常終了の確認で、`docker logs` の失敗を grep の「一致なし」として通しうる | 修正済み。ログを先に受け取る（失敗すれば手順が赤） |
| P3 | 「任意」の残り（ニュースの runbook の 73 行・`env.example`・`CHANGELOG.md`） | 修正済み。変数が省略できる意味の「任意」は残した |
| P3 | 到達しない分岐（保留の理由の文）、古い文の fixture、空のリストの説明が「確定を押すと並ぶ」と言う | 修正済み。空のリストの説明は、止めておる間は確定できないことを言う（試験を足した） |
| P3（未検証として） | probe の script が 100644 で commit されると `./scripts/…` で起動できない | 確かめた: `core.fileMode=true`、ファイルは `-rwxr-xr-x`。`git add` で 100755 が記録される |

### ゲート（23:20〜23:25、統括が実行）

| ゲート | 結果 |
|---|---|
| `pnpm lint` | 指摘 0 |
| `pnpm exec tsc --noEmit`（e2e を含む） | エラー 0 |
| `pnpm exec vitest run` | 330 ファイル 6392 件 全緑 |
| `check-transition-all.py --strict` / `check-transition-reject-guard.py --strict` | 違反 0（checked 772 / 21） |
| `shellcheck scripts/test-db-execute-denial.sh` | 警告 0 |
| probe の shim 10 通り・PGlite の SQL・workflow の構造検査 | 全て期待どおり（scratch） |
| PGlite（既定）＋本物の pgTAP | migration 58 本、pgTAP 39 ファイル 1947 件 全緑（dinner_tables 464） |
| `pnpm build` | 手元では再実行しておらぬ（前回まで sandbox で完走せず。51bd55bc の CI では成功） |
| `supabase test db`・2 接続の並行試験・実 Auth・Playwright（e2e ⑦⑧ を含む）・`db-image-probe` | **未実行**（CI でだけ走る） |

ブラウザの範囲: Playwright の `chromium` は全ての spec（家事を含む）。`webkit-iphone` は `E2E_WEBKIT=1` のとき `webkit-core.spec.ts` の 1 件だけで、家事は含まぬ。暗号化した再送の保存は別の script で Chromium と WebKit の両方。ゆえに**家事の機能を WebKit で確かめたとは言えぬ**。

## 2026-11-12 時点の状態（`fba35d38` の CI を受けた追随。→ 人が `bf4568ff`・`060db833`・`2b1fae6e` として commit・push 済み）

人が上の節の追随を 2 つの commit にして push した（`35d55586` CI 用 DB の固定、`fba35d38` 保留・候補・AI の記述）。この節は、その SHA の CI で見えた事実と、それを受けた追随じゃ。

### `fba35d38` の CI の結果

確かめ方: 公開 API の job・step・注釈で見た。job のログ本体は 403 で読めぬ。

| run | 結果 |
|---|---|
| `CI`（43117184040） | 全成功: lint・型検査・試験・build・proxy の検査・検出器 3 本 |
| `CodeQL`（43117183941） | 成功 |
| `E2E`（43117183991）の `db-image-probe` | 失敗。106 の手順が赤で、準備の段階で接続が切れた（利用者の報告とも一致）。156 の手順は skipped で、実行済みに数えない |
| `E2E` の `e2e` | 成功した手順は下の一覧。Playwright は失敗（注釈の集計: 87 passed・1 failed・1 skipped）。最後の「異常終了 0 件」の断定は skipped で、一度も走っておらぬ |

`e2e` ジョブで成功した手順:

- 156 の固定、stack の起動、image ID の断定
- stack 上の probe（旧版。156 では 4 ロールとも 42501）
- `supabase test db`（家事の拒否試験 175 件を含む pgTAP）
- 並行試験 2 本
- `.env.e2e` の生成
- Next.js build
- 暗号化した再送の保存（Chromium と WebKit）

本命の修正（156 への固定）は、stack の probe と pgTAP の拒否試験で確かめられた。106 で「hint_roles だけが落ちる」ことは、まだ観測しておらぬ（probe が準備で止まったため）。

### probe の準備の失敗: 原因と直し方

| 項目 | 確かめたこと（一次資料） |
|---|---|
| 原因 | 下の 4 点。確かめたい #214 とは別の不具合 |
| 名前を書けば通る理由 | `AccessPriv.priv_name` と `RoleSpec.rolename` は同じ offset にあり、名前の grantee では正しい文字列が読まれる（#205 の説明）。#207 の表でも `GRANT r TO postgres` は通る。`postgres` は `supautils.reserved_roles` に無い |
| 呼出しで落ちる前提（コード上の経路。未観測） | 下の 4 段。#214 の再現（同じ形の単純な SQL 関数・17.6.1.104）と合う |
| 直し方 | 下の一覧 |
| ログの前提 | image は `logging_collector = off`（`postgresql-stdout-log.conf`）で、server log は `docker logs` に出る。CLI 2.101.0 は `postgres -D /etc/postgresql` を引数なしで起動し、`config.toml` に `[db.settings]` は無い。`log_min_messages`・`track_activities` は既定ゆえ、ERROR 行と `Failed process was running` が出る |
| throwaway の container の前提 | `postgres` は image の migration `20230201083204` で anon・authenticated・service_role を付与されておる。CLI の初期化に依らず `SET LOCAL ROLE` が通る |
| 期待 | 変えておらぬ。106: 対照のロールは 42501、anon・authenticated は signal 11。156: 4 ロールとも 42501 で稼働を続ける |

原因:

1. 旧 probe は、準備で `GRANT irori_execute_denial_plain TO CURRENT_USER;` を流した。
2. supautils 3.2.0 の `src/supautils.c`（505〜534 行）の `T_GrantRoleStmt` は、非 superuser のとき grantee の要素を `AccessPriv` として読み、`is_reserved_role(priv->priv_name)` へ渡す。
3. `CURRENT_USER` の `RoleSpec.rolename` は NULL で、`strcmp(NULL, …)` が落ちる（supabase/supautils#205・#207）。修正は v3.2.3（= #205 の merge commit `d8167fe4`）。
4. image の postgres は `10000000000000_demote-postgres.sql` で NOSUPERUSER ゆえ、この hook が走る。

呼出しで落ちる前提（コード上の経路。未観測）:

1. 同じ版の `supautils_executor_start` は、hint_roles のロールで 42501 を捕まえると、`find_missing_perm` で relation を探す。
2. `SELECT f()` には relation の権限情報が無いゆえ、`relid = InvalidOid` のまま残る。
3. `get_rel_name` は NULL を返す。
4. `quote_qualified_identifier(NULL, NULL)` で落ちる。

直し方（両方の mode に共通）:

- 準備は `GRANT … TO postgres` にする。接続するロールが postgres であることを前提として断ずる。
- 準備の後、呼ぶ前に、probe する全ロールが EXECUTE を持たず、postgres が対照のロールになれることを断ずる（`has_function_privilege`・`pg_has_role`）。
- 期待の crash は、その手順で増えたログ行の中で、次の 2 行を 1 組（PID の行の直後が DETAIL）として照合して数える。
  - 呼んだ接続の PID の `terminated by signal 11`
  - `Failed process was running: SELECT public.irori_execute_denial_probe(`
- 42501 の手順は、拒否が server log に出たことも断ずる（ログを読めておる陽性対照）。
- PASS の前に、最初の probe 以後の crash 行が、ちょうど期待の数であることを断ずる（clean は 0、crash は 2）。

準備と呼出しの分け方は、mode で変える。

- `--image`（使い捨ての container。crash を期待できるのはここだけ）:
  - 準備を別の接続で commit する。準備中の crash は「準備の失敗」として赤にし、psql の終了コード（2 と 3）で報告を分ける。
  - 呼出しは別の接続で行い、最後の接続で後始末して、何も残らぬことを断ずる。
  - 利用者の求めた「準備の失敗と、期待の SIGSEGV の区別」は、期待の SIGSEGV が在るこの mode で効く。
- `--container`（pgTAP の前の stack。常に clean）:
  - ロールごとに 1 つの接続・1 つの transaction で、準備 → 状態の行 → 呼出し → ROLLBACK を行う。
  - 何も commit しないゆえ、DB が落ちても、script が止められても、何も残らない。
  - 通った接続のたびに、関数もロールも残っておらぬことも断ずる。
  - 段は同じ接続の中の印で分ける。状態の行が無ければ「準備の失敗」、状態の行があって接続が切れれば「呼出しで落ちた」と報告する。
  - 同じ名前が既にあれば、消さずに赤にする（作っておらぬ物は消さない）。
  - 1 回目のレビューの P1 を受けて、こう改めた（下の表）。準備を commit する形では、DB が落ちた直後の recovery の間は後始末が接続できず、stack に残りうる。

### Playwright の 1 件: 原因と直し方

| 項目 | 中身 |
|---|---|
| 失敗 | `chores-meals.spec.ts:125`（ごはん①）。在庫が空のとき `now-candidate` を頁全体で 0 件と断じたが、3 件あった（再試行 2 回も同じ） |
| 原因 | 試験の断言の誤り（下の 3 点） |
| 直し方 | 下の一覧。画面は変えておらぬ |
| 1 skipped | 家事の spec には skip も serial も無い。skip は家事以外の条件つきのものだけ。どの試験かはログが読めず名指しできぬ |
| 他の家事の試験 | 注釈の集計と上の事実から、成功したと推す。spec ごとの合否は未確認 |

原因:

- 要件 C-24（verified）は「揃う候補が 0 件なら黙って緩めず、別枠で買い足し候補を示す」。
- 在庫が空でも「買い足せば作れる」に候補が出るのが契約で、`catalog-integration.test.ts`「在庫が空なら「揃う」は 0 件…」ほか 3 本が断じておる。
- 在庫が空・既定の設定（常備品なし）で実カタログを jsdom に描くと、頁全体で 3 件・全て「買い足し」になった。CI の 3 件と一致する（一時の試験で確かめて消した）。

直した断言:

- 揃う区画と「分量を確認」の区画に、候補が 0 件。
- 「揃う候補は 0 件です。」と、登録への誘導が出る。
- 「買い足せば作れる」の候補は 1 件以上で、どれも「買い足し」の印を 1 つ持ち、「揃う」とは言わない。
- 頁全体の候補の数は、買い足しの区画の数に等しい（区画の外に候補を出さない。1 回目のレビューの P3）。
- 区画の名前は exact で当てる。

### 手元で行った確認

実 Docker は sandbox が socket を拒み、Playwright は port の bind が拒まれるゆえ、どちらも未実行。

- `shellcheck`: 警告 0。script の index の mode は 100755。
- probe の判定の流れ: `docker` を模した shim で 27 通り、全て期待どおり（実の image ではない）。
  - shim は、crash の後の recovery の間、新しい接続を全て拒む。crash 行を遅れて書くこともできる。
  - bash 5.3.9 と macOS の `/bin/bash` 3.2.57 の両方で流した。
  - 内訳: 正常 3、陰性の対照 19、入力の拒否 3、赤の再現 2。
  - 赤の再現（HEAD 版）: CI と同じ「could not set up its function (status 2)」で赤。
  - 赤の再現（1 回目の追随の版）: 106 の stack で fixture が残った。新しい版は同じ case で赤になり、何も残さぬ。
- mutation 10 本: 全て、狙った試験の結果を変えた。元の script の sha256 は前後で一致。外した守りは次の 10 個:
  - 準備を `TO CURRENT_USER` に戻す;
  - PID を照合しない;
  - 文を照合しない;
  - ログの陽性対照を外す;
  - `--container` の接続の中で fixture を commit する（接続ごとの残存の検査が止める）;
  - `--container` の状態の確認を外す;
  - `--image` の状態の確認を外す;
  - 終了コードで分けない;
  - 最後の crash 行の数の確認を外す;
  - 接続を失った失敗の報告の前に、crash 行を待たない（遅れた crash 行が「0 行」と報告される）。
- probe の SQL: script が組み立てる SQL そのものを抜き出し（定義の部分だけを評価）、PGlite（PG 17.5）で流した。image の postgres に見立てた非 superuser（CREATEROLE）へ `SET SESSION AUTHORIZATION` してから流した。
  - `--container`: 4 ロールとも、transaction の中の状態の行が期待と一致し、42501 で、同じ接続は続き、接続ごとに残存 0。
  - `--image`: fixture は commit され、状態の行が期待と一致した。4 ロールとも 42501。後始末の後に何も残らぬ。
  - default privileges が API ロールへ付与した EXECUTE も外れる。
  - 対照:
    - GRANT を抜くと、`SET ROLE` が拒まれ、状態の行も外れる。
    - superuser のままなら素通りする（見立ての非 superuser が要る理由）。
    - 接続の中で commit すると、残存の照会が 2 を返す。
- workflow の構造: 2 ジョブ・22 手順の順序と、`continue-on-error` が無いことは変わらず。差分はコメントだけ。
- `pnpm lint` 0。`pnpm exec tsc --noEmit`（e2e を含む）0。
- vitest 全体: 330 ファイル・6392 件が緑。C-24 の単体試験 5 ファイル・248 件も緑。
- 検出器: `check-transition-reject-guard.py --strict` 0（21 か所）、`check-transition-all.py --strict` 0（772 か所）。`check-supabase-error-destructure.py` は hook が名前で拒んだゆえ手元では未実行（今回の差分は `src` に触れず、`fba35d38` の CI では成功）。

src・migration・pgTAP・並行試験・build の設定は変えておらぬ。

### 独立レビュー（4 回目、今回の差分。読むだけで実行はしておらぬ）

| 指摘 | 中身 | 結果 |
|---|---|---|
| P1-1 | `--container` で fixture を commit する形は、106 のままの stack で anon が DB を落とすと、終了時の後始末が recovery 中で接続できず、ロールと関数が残る。commit の後に印を受け取る前に接続が切れても残る。旧版（1 つの transaction で ROLLBACK）には無かった退行 | 修正済み。shim で赤（残った）を再現してから、mode で分けた。`--container` はロールごとの transaction と ROLLBACK に戻し、接続ごとに残存 0 を断ずる。同じ case が赤で何も残らぬことを、bash 5 と 3.2 で確かめた |
| P3 | crash の 2 行（PID の行と DETAIL）を別々に照合していた | 修正済み。PID の行の直後の行で照合する（変数へ受けて here-string で照合） |
| P3 | 42501 の手順で、拒否の行が見えた後の crash 行がどの窓にも入らぬ | 修正済み。最初の probe 以後の crash 行の数を、PASS の前にちょうど期待の数（0 か 2）と断ずる。窓の外の crash を模した case と mutation で確かめた |
| P3 | Playwright の頁全体の守りが消えた | 修正済み。頁全体の候補の数が、買い足しの区画の数に等しいことを断ずる |
| P3 | コメント: 「3.2.3 で修正」と、影響の範囲（#207 は 17.6.1.147） | 直した。タグ v3.2.3 が #205 の merge commit `d8167fe4` を指すこと（タグの一覧で確かめた）と、#207 が 17.6.1.147 で再現したことを書いた |
| 未確認として | script の実行権限 | 確かめた: index は 100755 |

### 独立レビュー（5 回目、script に絞った再レビュー。読むだけで実行はしておらぬ）

結果は P1・P2 ともに無く、P3 が 2 件。4 回目の P1 は、全ての経路で消えたと確かめられた。経路は次の 4 つ:

- 途中で DB が落ちる;
- script が止められる;
- commit の印を受け取る前に接続が切れる;
- 他人の物を消す。

`--container` は一度も commit せず、DROP も持たない。

| 指摘 | 中身 | 結果 |
|---|---|---|
| P3-1 | コメントは「接続ごとに残存を確かめる」と言うが、確かめるのは通った接続の後だけ（失敗の分岐は先に終わる） | 直した。「何も commit しない。通った接続のたびに残存 0 も断ずる」と書いた（script の頭と `e2e.yml`）。何も commit せぬゆえ害は無かった |
| P3-2 | 呼出しの失敗の分岐は、ログを待たずに 1 度だけ読む。接続を失った直後は、crash があっても「0 行」と報告しうる（結果の赤は変わらぬ） | 直した。接続を失った時（psql の終了コード 2）は、crash 行を最大 15 秒待ってから報告する（準備と同じ）。crash 行を遅れて書く shim の case と mutation で確かめた |
| INFO | 106 のままの stack へ `--container` を向けると、anon の呼出しでその DB は落ちる | 落ちること自体が検出で、何も残らぬ。CI では image ID の断定が先に赤にするゆえ届かぬ |

再レビューが答えた問い（コードと一次資料による。実行はしておらぬ）:

- **crash の行の数**: 106 の正しい run では、crash 行はちょうど 2 になる。PG17 の `HandleChildCrash` は、最初の crash の子だけを LOG で記録する。recovery 中に刈られる他の子の終了は DEBUG2 で、既定では出ない。
- **2 行の組**: PID の行と DETAIL の行は、1 つの ereport を 1 回の write で書く（PIPE_BUF 未満ゆえ分かれぬ）。

### 主経路へ足した、未観測の前提（→ `314fbd9c` の E2E で、stack 上の probe の step が成功した。下の「最終状態」の節）

stack 上の probe（`e2e` ジョブで pgTAP の前）に、新しい赤の条件を 5 つ足した。どれも stack ではまだ一度も観測しておらぬ（`fba35d38` の stack で走ったのは旧版）。

1. 接続するロールが postgres であること（`current_user` と `rolsuper` を読む）。旧版と同じく `psql -U postgres` で接続する。
2. transaction の中の状態の行が期待と一致すること。
   - 内容: 4 ロールとも EXECUTE なし、postgres が対照のロールになれる。
   - 根拠: PGlite で非 superuser から確かめた。image の default privileges も外れる。
3. 拒否の行が server log（`docker logs`）に出ること。
4. 通った接続のたびに、残存が 0 であること。PGlite で確かめた。
5. 最初の probe 以後の crash 行が 0 であること。

3 と 5 の根拠は、image と CLI の設定を読んだことだけじゃ。

- image: `logging_collector = off`、`log_min_messages` は既定。
- CLI: `postgres -D` を引数なしで起動する。

もし CI で 3 か 5 だけが赤になれば、最後の「異常終了 0 件」の断定も空振りしておったという発見じゃ。検査を外す理由にはしない（ログの読み方を直す）。

## 2026-11-12 夕方時点の最終状態（`314fbd9c`。公開前）

人が上の節の追随を 3 つの commit にして push し、CodeQL の指摘への修正を `314fbd9c` として足した。本番 DB への適用も人が行った。2026-11-12 の朝に予定した「追随の commit・push」「`CI` と `E2E`」「本番 DB へ migration 3 本」は済んだ。前の節の「未 commit」「未実行」「未観測」は、書いた時点の記録じゃ。

確かめ方:

- CI・PR・branch: エージェントが GitHub の公開 API（run・job・step・注釈・PR・branch）で確かめた。job のログ本文は、認証が要るゆえ読めておらぬ。
- 本番 DB と、CodeQL の新しい警告の数: 利用者の報告。エージェントは本番に接続できず、警告の一覧も読めぬ（認証が要る）。照合はしておらぬ。

### commit（head `314fbd9c`。origin の branch と PR の head が同じ）

| commit | 中身 |
|---|---|
| `bf4568ff` | probe の grantee を `postgres` と名指しし、fixture を mode ごとに分けた（上の節） |
| `060db833` | ごはん①の断言を区画ごとに直した（C-24。上の節） |
| `2b1fae6e` | 文書（`fba35d38` の CI の結果と追随） |
| `314fbd9c` | CodeQL の指摘への修正（人が作成。下の表） |

`314fbd9c` の中身（差分を読んで書いた。どの警告に当たるかは見ておらぬ）:

| 場所 | 変更 | 効く範囲と試験 |
|---|---|---|
| `.github/workflows/e2e.yml` | workflow 全体に `permissions: contents: read` を足した | E2E の 2 つの job。`bf4568ff` の workflow の差分はコメントだけだったが、ここで権限の行が入った |
| `src/lib/meals/server/plan-requests.ts` の `isOpRequest` | 外から来た `op` の名で guards を直に引かず、許可された項目の中から名前が一致するものを選んで呼ぶ | 献立・人数・買い物の要求の型ガード。新しい試験 `op-request-security.test.ts` が断ずる: `__proto__`・`constructor`・`toString` などを拒む、正しい操作は通す、正しい操作名でも不正な引数は拒む |
| `src/lib/supabase/log-error.ts` | scope と summary を書式文字列へ埋め込まず、`"[%s] %s"` の引数で渡す | 共有の `logSupabaseError` / `logSupabaseErrorRedacted` ゆえ、**家事以外の全ての呼び出し元に効く**。試験は `%o`・`%d` を解釈せぬことを断ずる。既存の画面の試験 2 本（招待・承認待ち）の期待を、新しい呼び方へ直した |

この commit は人が作ったもので、独立レビューの記録は無い（CI と CodeQL は通った）。merge の前にレビューするかは、人が決める（`handoff.md` の冒頭の手順 4）。

### `314fbd9c` の CI の結果

| run | 結果 |
|---|---|
| `CI`（43182408888） | 成功: lint・型検査・試験・build・proxy の検査・検出器 3 本 |
| `E2E`（43182408848） | 成功。2 つの job の全ての step が成功（失敗の時だけ動く 2 つの step は skipped） |
| `CodeQL`（43182408844） | 成功: javascript-typescript・python・actions。PR の差分の新しい警告 0 件は、利用者の報告 |

3 本とも 1 回目の実行（再実行なし）。

`E2E` の中身:

- `db-image-probe`:
  - 106 の手順（hint_roles だけが EXECUTE 拒否で落ちる）と、156 の手順（42501 で稼働を続ける）が成功。
  - script は条件を全て満たした時だけ PASS で終わる。ゆえに、106 では対照のロールが 42501、anon と authenticated が自分の backend の signal 11。156 では 4 ロールとも 42501。ログの本文は読めておらぬ。
  - `fba35d38` の赤（準備の失敗）は再発しておらぬ。
- `e2e` ジョブ:
  - 次が全て成功: 156 の固定と image ID の断定、stack 上の probe、`supabase test db`、並行試験 2 本、build、暗号化した再送の保存（Chromium と WebKit）、Playwright、最後の「異常終了 0 件」の断定。
  - stack 上の probe の成功は、上の節の「主経路へ足した、未観測の前提」の 5 つが全て満たされたことを意味する（script の判定による）。
  - Playwright の集計（注釈）: 88 passed・1 skipped。flaky の行は無い。`fba35d38` の 87 passed・1 failed・1 skipped から、直したごはん①が通った（合計はどちらも 89 件）。
  - 家事の spec は skip を持たぬゆえ、skip の 1 件は家事以外。

ブラウザの範囲:

- 家事の Playwright は `chromium` project（Desktop Chrome の設定）だけで走る。
- `webkit-iphone`（iPhone 15 の模擬・WebKit）は `webkit-core.spec.ts` だけで、家事を含まぬ。
- 家事を iPhone Safari・実機で確かめたことは、まだ無い。

`main` の保護が求める必須チェックは `ci` と `e2e`。`main` は `521f2fc2` のままで、branch の基点と同じ。PR は Draft・未 merge。

### 本番 DB（利用者の報告。2026-11-12）

- 対象: 本番の Supabase `irori-prod`。project ref も利用者の報告に在る（公開 repo ゆえ、この文書には書かぬ）。
- Vercel の production のアプリが実際に接続する先と、`irori-prod` との照合は、エージェントはしておらぬ（着手時の「デプロイ先の照合」から変わらず）。公開の前に人が確かめる（`handoff.md` の冒頭の手順 4）。
- 適用: `20261111100001`〜`20261111100003` の 3 本。
- 既存の履歴: 本番の 55 本が GitHub と一致した。照合した時点は報告に無い（repo の migration は 58 本 = 既存 55 本＋家事 3 本）。
- 適用後の SQL 監査: PASS。migration 3/3、表 13/13、RLS 13/13、トリガ 3/3、書き込みポリシー 0、anon・authenticated の直接の書き込み権限 0。
- 適用の方法と dry-run の結果は、報告に含まれておらぬ。
- バックアップの取得と復元の試験: 記録が無い。完了扱いにせぬ。
- トリガ 3 本は、適用の時点から本番で有効。旧アプリの予定・通知の書き込みでも動く（分類した予定にだけ作用する設計）。
- 本番アプリへのデプロイと、本番での実操作は未実施。

### 台帳の更新（2026-11-12）

- verified へ上げた: X-06・C-71・V-AUTH・V-DB。
  - 利用者が 2026-11-11 に「実 Supabase・CI で確かめる」として in_progress へ戻した行と、受け入れ手順が DB の試験の行じゃ。
  - CI の実 Supabase・実 Auth・2 接続の試験で、台帳に書いてあった残りが埋まった。
- X-07 は in_progress のまま。JWT・再送・版・権限・2 接続は CI で埋まった。残りは 1 つで、数量の守り（22023）を利用者の JWT で PostgREST から試す試験が無い（claims を手で入れた pgTAP だけ）。台帳に記録した利用者の基準に照らし、上げなんだ。利用者がこの範囲で受け入れるなら上げられる。
- D 行: D-01〜D-04 は verified（D-04 は利用者の報告）。D-05・D-06 は未実施（pending）。D-07 は blocked のまま。
- V-BROWSER: blocked から in_progress へ。Chromium の自動の操作は通ったが、実機は未。
- 画面を伴う行は、Chromium の CI が通っても in_progress のまま。証拠の欄に、通った CI の試験の名を足しただけ。
- 状態の数（112 行）: verified 74・in_progress 34・pending 2・blocked 2（直す前は verified 67・in_progress 37・blocked 8）。blocked に残るのは、無料 AI の C-82 と D-07 じゃ。

### この時点で残るもの

- 文書 4 本（この節を含む）の commit・push（人）。新しい SHA で `ci`・`e2e`・`db-image-probe`・CodeQL が緑になるまで merge しない。
- PR の本文の差し替え（人）。GitHub 上の本文は `51bd55bc` の頃のまま。
- Vercel の production の接続先が `irori-prod` であることの確認（人。エージェントは照合しておらぬ）。
- `314fbd9c`（人の commit。独立レビューの記録なし）を、merge の前にレビューするかの判断（人）。
- 本番 DB のバックアップの取得・復元の試験（記録なし。未完了）。
- Draft の解除と merge、Vercel の production deployment の確認、本番での確認（人。`handoff.md` §4 のチェックリスト）。
- iPhone Safari・実機での家事の確認と、Push の実端末での受信（未確認）。
- 無料 AI の実接続（既定 OFF。Workers Free の契約の確認は未完了）。

### この整理で行ったこと・行わなかったこと

- 変えたのは文書 4 本（`progress.md`・`handoff.md`・`pr-body.md`・`requirements-ledger.md`）だけ。アプリのコード・SQL migration・workflow・テストは変えておらぬ。
- 本番 DB の操作、commit・push・PR の更新・Draft の解除・merge・デプロイは行っておらぬ。
- 独立したレビュー（読むだけ）を 1 回行った。指摘は P1 2 件・P2 3 件・P3 5 件。根拠のコードを読んで全て確かめ、全て直した。
  - P1: 公開後のごみの確認を初期値のまま行うと、前日 20:00 の通知が付いたまま残り、家族の端末へ届く。分類の初期値は「前日 20:00 に通知する」、解除の初期値は「通知設定は変えない」じゃ（`garbage-purpose-form.tsx`）。「通知を止める」は既存の通知も消す。→ 試し用の単発の予定で「通知設定は変えない」を選ぶ手順へ直した（`handoff.md` §4・§6）。
  - P1: project ref の照合を、根拠なく済みと書いていた。→ 報告の範囲だけを書き、D-04 の verified を「適用と、適用後の監査」に限った。Vercel の production の接続先の確認を、公開前の手順へ足した。
  - P2: 履歴 55 本の一致を「適用の前に」と書いていた（時点は報告に無い）。`314fbd9c` にも独立レビューがあったと読めた。X-07 の verified が、記録した利用者の基準を満たしておらなんだ。→ 全て直し、X-07 は in_progress へ戻した。
  - P3: 次の 5 件を直した。
    - 「全ての step が成功」の言い過ぎ
    - 「同じ回の同時完了」は、実は逐次の呼出し
    - step の成功からの推論に、出所を添えておらなんだ
    - `handoff.md` の参照（§ の範囲・「§2 の末尾」・`W` の定義）
    - HEAD から在った表の崩れ（上の「中 7」「低 8」の 2 行を表へ戻した）

## 次の具体的作業（人）

`handoff.md` の冒頭の「今の公開の手順」の順に進める。

1. 文書 4 本の commit・push。
2. 新しい SHA の `CI`・`E2E`・`CodeQL` が緑になるのを待つ。
3. PR の本文を `pr-body.md` で差し替える。
4. Vercel の production の接続先が `irori-prod` であることを確かめ、次を決める（`handoff.md` の冒頭の手順 4）: バックアップを取るか、`314fbd9c` をレビューするか、未検証のものを残したまま公開してよいか。
5. Draft の解除と merge、デプロイの確認、本番でのチェックリスト（`handoff.md` §4）。
6. 無料 AI の有効化（任意。`handoff.md` §5）。
