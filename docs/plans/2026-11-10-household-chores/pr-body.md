## 概要

家事タブを足し、ごみ・掃除・ごはんの 3 機能を入れる。AI が無くても全機能が動く。

AI 補助は**アダプター実装済み・実接続は未実施・既定 OFF**。Cloudflare Workers AI の無料枠だけを使う経路で、実 API への呼出しは 0 回。Workers Free の契約の確認は未完了。

## 状態（2026-11-13）

- 追加検証 `e005eac7` で、実 Auth の利用者JWTから PostgREST → RPC を直接呼び、負の数量・購入量超過補充・補充済み購入量の引き下げを `22023` で拒否し、状態不変を確認。X-07 は verified。
- `e005eac7` の CI 43335009948・E2E 43335009962（DB probe含む）・CodeQL 43335009964 が成功。
- Vercel `irori` の本番接続を確認済み。Productionは `main` でREADY、配信JSのSupabase URLは本番migrationを適用した `irori-prod` と一致。PRはまだDraft、未merge。
- バックアップは利用者の判断で取得しない。復旧可能なバックアップが存在すると主張しない。
- 下の「2026-11-12」の履歴には、その時点の状態を残す。最新状況は本節を優先。

## 状態（2026-11-12、当時の記録）

- 最後にコードを変えた commit `314fbd9c` で、`CI`・`E2E`・`CodeQL` が成功した。`main` の必須チェックは `ci` と `e2e`。
- 本番 DB（Supabase `irori-prod`）へ、migration 3 本を 2026-11-12 に適用した。以下は、人が行った適用と監査の報告による。
  - 本番の既存の履歴 55 本は GitHub と一致した。
  - 適用後の SQL 監査は PASS（migration 3/3・表 13/13・RLS 13/13・トリガ 3/3・書き込みポリシー 0・anon/authenticated の直接の書き込み権限 0）。
- **Draft・未 merge。** 本番アプリへのデプロイと、本番での実操作はまだ。
- 文書の更新（この本文を含む）を commit した後、その SHA でも `ci`・`e2e` が緑になってから merge する。
- 公開の手順・公開後の確認・戻し方は、`docs/plans/2026-11-10-household-chores/handoff.md` の冒頭。

## 中身

- **ごみ**: カレンダーの予定を「ごみの日」に分類する（この回だけ／シリーズ全体）。前日 20:00 の通知は既存の `event_reminders` へつなぐ（新しい cron・worker は無い）。
- **掃除**: ルーティーン（固定の日・実施した日から数える）。1 タップで完了・取り消し・スキップ。
- **ごはん**:
  - 食材・今あるもので・7 日の献立・買い物
  - 使わない食材（消費者庁の対象 29 品目＋自由入力）
    - 判定できない語のアレルギーがある間は、献立の確定と買い物の自動の更新を止める。今のリスト・購入の記録・手で足した項目は残し、「要再確認」と出す。
    - アレルギーで「豆乳」「鶏もも」を選ぶと、「大豆」「鶏肉」を品目として登録する候補と、外す範囲を出す。押したときだけ登録し、既存の登録は広げない。苦手には出さない。
  - 子どもの取り分けの案内（保護者が食事の段階を選ぶまで出さない）
- 下のタブは「育児・予定・家事・設定」の 4 本。

## DB

- 加算のみの migration 3 本: `20261111100001_event_purposes` / `20261111100002_cleaning_routines` / `20261111100003_dinner_tables`。本番へ適用済み。以後この 3 本は書き換えず、直すなら新しい migration で足す。
- 既存の表の DROP・rename・型変更・既存ポリシーの変更は無い。
- 新しい 13 表は **SELECT の RLS だけ**。`anon`/`authenticated` に書き込みの GRANT もポリシーも無い。
- 書き込みは、利用者・承認・世帯・対象の世帯を確かめる SECURITY DEFINER RPC だけ。RPC は `SET search_path = ''` で、PUBLIC と anon には EXECUTE を与えない。
- 既存の `calendar_events`（INSERT と `start_date` の UPDATE）と `event_reminders`（INSERT・DELETE）にトリガ 3 本を足した。ごみに分類した予定にだけ作用する。本番では適用の時点から有効。
- `supabase/tests/chores_rpc_security.sql`（175 件）は、書き込み RPC 30 本を、未ログイン・子どもの閲覧招待・世帯内 viewer・未承認・世帯なしの 5 種で呼び、すべて 42501 になることを確かめる（この試験が CI 用の DB の不具合を見つけた）。

## 検証（`314fbd9c`）

- `CI`: lint・型検査・vitest・production build・proxy の検査・検出器 3 本。
- `E2E`:
  - `db-image-probe`: 2 つの手順が成功した。probe の script は、次の条件を全て満たした時だけ通る（結果は script の判定による。ログの本文は読めておらぬ）。
    - 旧 image 17.6.1.106 では、hint_roles（anon・authenticated）だけが EXECUTE の拒否で backend ごと落ち、対照のロールは 42501 になる。
    - 固定した 17.6.1.156 では、4 ロールとも 42501 で稼働を続ける。
  - `e2e` ジョブ:
    - 156 への固定と、image ID の断定
    - stack 上の probe
    - `supabase test db`（拒否試験 175 件を含む pgTAP）
    - 2 接続の並行試験 2 本
    - 実 Auth の JWT で RPC を直に呼ぶ試験（`e2e/chores-rpc-auth.spec.ts`）
    - Playwright: 88 passed・1 skipped（skip は家事以外）
    - 最後の「DB の異常終了 0 件」の断定
- `CodeQL`: javascript-typescript・python・actions が成功。PR の差分の新しい警告は 0 件（人が確認）。

**ブラウザの範囲**: 家事の Playwright は Chromium（Desktop Chrome の設定）だけで走る。WebKit（iPhone 15 の模擬）は記録の中核の `webkit-core.spec.ts` だけで、家事は含まない。**家事を iPhone Safari・実機で確かめたことは、まだ無い。**

手元の検証（PGlite＋本物の pgTAP、probe の shim と mutation など）の記録は `progress.md` にある。CI の代わりにはしていない。

## CI を緑にするまでに直したもの

1 と 2 の段では、独立レビュー（読むだけ）を行い、P1 を含む指摘を直した（詳しくは `progress.md`）。3 の `314fbd9c` は人の commit で、独立レビューの記録は無い（CI と CodeQL は通った）。

1. **初回の CI（`51bd55bc`）の後**（`35d55586`・`fba35d38`）:
   - CI 用 DB のクラッシュ:
     - 原因: CLI 2.101.0 の既定 `supabase/postgres:17.6.1.106` は supautils 3.2.0 を同梱する。`anon` 等が EXECUTE の無い関数を呼ぶと、42501 ではなく backend が SIGSEGV で落ちる（supabase/postgres#2112、supabase/supautils#214。3.2.2 で修正）。
     - 直し方: `17.6.1.156`（supautils 3.4.0）へ tag と digest で固定し、最小再現 `scripts/test-db-execute-denial.sh` を足した。
     - 権限の追加・拒否試験の削除・skip・continue-on-error は使っていない。CLI は 2.101.0 のまま。
   - 判定できないアレルギーの間の買い物: 自動の更新を止め、今のリスト・購入量・手動項目・充当を残す（以前は未購入の自動項目を消していた）。
   - 大豆・鶏肉の品目の候補（上の「中身」）。
   - AI の記述を「アダプター実装済み／実接続は資格情報待ち」へそろえた。
2. **2 回目の CI（`fba35d38`）の後**（`bf4568ff`・`060db833`）:
   - `db-image-probe` の準備:
     - 起きたこと: 準備の `GRANT … TO CURRENT_USER` が、supautils 3.2.0 の別の不具合（supabase/supautils#205・#207）を踏んだ。確かめたい拒否に届かなかった。
     - 直し方: grantee を `postgres` と名指しし、準備と呼出しを分けた。
     - 期待（106 の crash・156 の 42501）は変えていない。この commit の workflow の差分はコメントだけ。
   - Playwright のごはん①:
     - 起きたこと: 在庫が空のとき、候補を頁全体で 0 件と断じていた。
     - 原因: 要件 C-24（買い足し案は別枠で示す）と食い違う、試験の誤り。
     - 直し方: 区画ごとの断言に直した。画面は変えていない。
3. **CodeQL の指摘**（`314fbd9c`）:
   - `e2e.yml`: workflow 全体に `permissions: contents: read` を足した。
   - `isOpRequest`（献立・人数・買い物の要求の型ガード）: 外から来た `op` の名で関数を直に引かず、許可された項目の中から選ぶ。`__proto__`・`constructor` などを拒む試験を足した。
   - `log-error.ts`: scope と summary を書式文字列へ埋め込まず、`"[%s] %s"` の引数で渡す。共有の関数ゆえ、家事以外の全ての呼び出し元に効く。

## 先に直した 5 件（`51bd55bc` に含む）

各件とも、先に赤で再現してから直した。修正を一時的に戻して赤へ戻ることも確かめた。その後の独立レビューの指摘 8 件も、赤で再現してから直した。

1. **「作った」と取り消しの数量**: 購入（事実）と作った料理への充当を別の列で持つ。取り消しは自分の充当だけを外す。
2. **実施日起点の回のスキップ**: その回の予定日（JST）から 1 周期後を次回にする。
3. **遅れて届いた保存の応答**: 掃除とごみで、同じ編集の回のときだけシートを閉じ、入力を消す。
4. **料理が在る日へ 1 品だけ足す**: 在る料理と固定は残す。再送で重複しない。他の端末の変更は conflict で読み直させる。
5. **手で入れた料理の除外**: 判定は「問題なし／当たる／未確認」の 3 つ。原材料が分からなければ確定を止める。

## 公開の前と後に残るもの

- 文書の commit の後、その SHA で `ci`・`e2e`（と `db-image-probe`・CodeQL）が緑になること。
- Vercel の production の接続先が、migration を入れた `irori-prod` であることの確認。
- `314fbd9c`（人の commit）を、merge の前にレビューするかの判断。独立レビューの記録は無い（CI と CodeQL は通った）。
- 本番 DB のバックアップの取得と復元の試験。記録が無く、未完了。
- Draft の解除と merge、デプロイの確認、本番での確認（既存の画面の回帰、ごみ・掃除・ごはんの実操作）。`handoff.md` §4 のチェックリスト。
- iPhone Safari・実機での家事の確認。未実施。
- Push の実端末での受信。未確認。家族へ無断の試験通知は送らない。
- 無料 AI: アダプター実装済み・実接続は未実施・既定 OFF。有効化の前に、Account が Workers Free であることを人が確かめる（未完了）。

既知の限界（安全側に倒したもの）:

- 判定できないアレルギーの登録がある間は、全料理が未確認になる。献立の確定と買い物の自動の更新が止まる。画面は理由と直す場所を出す。
- 止めている間に献立から外した料理（削除・作らなかった）の材料は、選び直して更新するまでリストに残る（要再確認の範囲）。
- 設定を保存しても、買い物は自動では計算し直さない。外れるのは「献立から更新」の後で、それまでは画面が「古い可能性」と当たる料理を出す。
- 材料を全部登録した手動料理は、登録した材料で判定する。登録した材料が実物と違う場合は見抜けない。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
