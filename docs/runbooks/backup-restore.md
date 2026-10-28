# バックアップと復元の手順（2026-10-27 初版）

**この文書は手順書であって、本番から復元できたことの記録ではない。** 2026-10-27 の時点で、本番の
バックアップから復元した実績は**無い**。確かめたのは「架空の 2 世帯のデータを、repo の migration を
当てた隔離 DB（ローカル PGlite）へ論理ダンプで入れ直し、照合する」演習だけじゃ（下の §4）。
演習の結果を「本番のバックアップから復元成功」と書かぬこと。

関連: `docs/plans/production-readiness-2026-10.md` の P2-40（手順の不在を記録した指摘）。

## 0. 守ること

- **実データを検証環境・ローカル・CI・repo へ複製せぬ。** 家族の記録・日記・メール・名前は個人データじゃ。
  演習は架空データだけで行う。本番の dump を取るのは、本番の復元が要る時の運用者だけ。
- **復元先から本物の家族へ通知を飛ばさぬ。** 通知（Web Push）・毎朝のまとめ・Google 同期は cron が起こす
  （`docs/runbooks/notify-cron.md`）。復元先で cron・Vault の秘密・Push の鍵を生かしたままにすると、
  古いデータに基づく通知が本物の端末へ届く。§3 の順で止めてから入れる。
- **本番の鍵（service_role・VAPID・Google の secret・CRON_SECRET）を演習に使わぬ。**
- dump は暗号化して、repo・CI・共有ドライブの外に置く。置き場所と鍵の持ち主を決めてから取る（未決 — §5）。

## 1. いま分かっておること・分かっておらぬこと

| 項目 | 状態 |
|---|---|
| Supabase のプラン（Free / Pro）と、日次バックアップ・PITR の有無 | **未確認**（一度も観測しておらぬ） |
| バックアップの保持期間 | 未確認 |
| 本番から dump を取った実績・置き場所 | 無い |
| 本番の復元演習 | 無い |
| 隔離 DB への合成データの復元演習 | 2026-10-27 にローカル PGlite で実施（§4） |
| 削除の形 | 記録・日記の削除は物理削除。世帯の削除は CASCADE で子の行も消える（取り消しは復元しかない） |

### プランとバックアップを確かめる手順（運用者・読むだけ）

1. Supabase Dashboard → 対象のプロジェクト → **Database → Backups** を開き、日次バックアップの一覧と
   PITR の有無を見る。見た日付・プラン・保持期間を下の「確認の記録」に書く。
2. **Settings → Billing** でプランを確かめる。プランごとの機能は版で変わるゆえ、その日の公式文書で確かめる
   （記憶や過去の文書で書かぬ）。
3. 日次バックアップが無い（Free 等）なら、§2 の手動 dump を「破壊的な migration の前」と「定期」に取る運用を
   決める。決めるのは持ち主（人間）じゃ。

確認の記録（運用者が書く）:

```
YYYY-MM-DD 確認者: ___ プラン: ___ 日次バックアップ: 有/無 保持: ___ PITR: 有/無
```

## 2. 本番の論理ダンプの取り方（運用者だけ・必要な時だけ）

- Supabase CLI の `supabase db dump`（`--data-only` 等の引数はその版の `--help` と公式文書で確かめる）か、
  接続文字列を使った `pg_dump`。接続文字列・パスワードは端末の外へ出さぬ。
- スキーマは repo の `supabase/migrations/` が正本ゆえ、復元はまず migration を当て、その上へデータだけを入れる。
- 取った dump は直ちに暗号化し、平文を消す。ファイル名に世帯名・人名を入れぬ。

## 3. 復元の手順（隔離先へ）

1. **隔離先を用意する**（新しい Supabase プロジェクト、またはローカル）。本番の URL・鍵を設定に入れぬ。
2. **外への経路を止める**（データを入れる前に）:
   - pg_cron のジョブを登録せぬ／登録済みなら `cron.unschedule` で外す（`notify-cron.md` の逆手順）
   - Vault に CRON_SECRET・本番 URL を入れぬ
   - アプリを繋ぐなら `VAPID_*`・Google の secret・SMTP を設定せぬ（Push・メール・同期が起きぬ）
   - Auth のメール送信（招待・マジックリンク）を使わぬ
3. **migration を当てる**（repo の `supabase/migrations/` を順に）。
4. **データを入れる**: トリガを止めて入れる（`pg_dump --disable-triggers` 相当。psql なら
   `SET session_replication_role = replica;` の後に流し、終わったら `DEFAULT` へ戻す）。
   - ⚠️ トリガを止めずに入れると、`auth.users` の `on_auth_user_created` が `profiles` を先に作り、
     `profiles` の行を入れる所で主キーの重複で止まる（演習で確かめた — §4）。
   - 生成列（`calendar_events.event_uid` 等）は INSERT に書けぬ。DB が計算し直す（dump の道具が除く）。
   - トリガを止めると外部キーの検査も止まる。入れ終わった後に孤児の行を数える（§3-5）。
5. **照合する**（元の件数・内容と比べる）:
   - 表ごとの件数
   - 時刻の表記（`logged_at::text`・`updated_at::text` がマイクロ秒まで同じ — 版の楽観的排他が保たれる）
   - 授乳の左右秒（`breast_left_sec + breast_right_sec = duration_sec`。CHECK が守るが件数でも見る）
   - 外部キーの孤児が 0（記録 → 世帯・記録者、プロフィール → 利用者、日記 → 世帯）
   - 世帯の境界: `authenticated` で各世帯の利用者として読み、他の世帯の行が 0
   - 検索（`memo ILIKE`）と書き出しの並び（`logged_at, id`）が元と同じ
6. 隔離先を本番へ切り替える判断は、照合の記録を見た持ち主（人間）がする。この文書は切り替えを指示せぬ。

## 4. 合成データの復元演習（ローカル PGlite）

**これは「ローカル PGlite の合成データ演習」じゃ。** 本番の Supabase・本番のバックアップ・実データは使っておらぬ。
PGlite（PostgreSQL 17 の WASM）に Supabase の最小の互換層（ロール・`auth.users`・`auth.uid()`・storage の表・
publication・既定の権限。pgcrypto の `CREATE EXTENSION` は除き `gen_random_bytes` を代える）を自作して当てた。
GoTrue・Storage API・Realtime・pg_cron・pg_net・Vault は無い。

- harness: 作業ディレクトリの `work/restore-drill/`（`drill.mjs` と `shim.sql`。repo には入れておらぬ —
  PGlite は repo の依存に足さず、作業用の場所へ `@electric-sql/pglite@0.3.12` を入れて使った）
- 実行: `node drill.mjs <repoRoot> <pglite の dist> <outDir>`
- 2026-10-27 の結果: 26 項目すべて PASS（`work/evidence/restore-drill.log`）
  - 架空の 2 世帯・3 人・記録 6 件（母乳の左右秒・ミルク・おむつ・体温・成長）・日記 2 件・予定 1 件
  - 論理ダンプ（INSERT の SQL）→ 新しい DB へ `session_replication_role = replica` で復元
  - 全列の text 表記が一致（マイクロ秒の時刻・版・左右秒・開始側を含む）。ミリ秒へ丸めた版では行が当たらぬ
    ことも対照として確かめた（照合の検知力）
  - 外部キーの孤児 0、記録者の名前が引ける
  - 世帯の境界（RLS を `authenticated` で実際に通す）: 世帯 A の利用者から世帯 B の行は 0
  - `memo ILIKE` の検索と `(logged_at, id)` の並びが元と同じ
  - 復元後も、表記のままの版で更新は 1 行・古い版は 0 行（楽観的排他が働く）
  - トリガを止めずに入れると `profiles_pkey` の重複で止まる（§3-4 の注意の根拠）
  - cron / net / vault のスキーマが無い（演習から外へ通知・HTTP は飛ばぬ）

演習で確かめておらぬこと: 本番の dump の形（`supabase db dump` の出力）・Storage の中身・Auth の他の表
（identities・sessions 等）・Realtime・大量データの時間。

## 5. 未決（持ち主の判断が要る）

- 日次バックアップのあるプランにするか、手動 dump の定期運用にするか
- dump の置き場所・暗号化の鍵の持ち主・保持期間
- 破壊的な migration（DROP・型変更）の前に dump を必須にするか（推奨）
- 本番の復元演習（隔離した新しいプロジェクトへ）をいつ・誰が行うか
