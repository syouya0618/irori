-- ============================================================
-- 育児記録から睡眠機能を撤去（睡眠行・ended_at・睡眠専用 index / CHECK の削除）
-- ============================================================
--
-- ① なぜ消すか
--    ユーザー要望による機能廃止。「睡眠」「起きてる」の記録・表示・集計を
--    育児記録から完全に取り除く（ダッシュボードのトグル、睡眠中/起きてる表示、
--    睡眠時間の集計、タイムライン行、編集シート、PDF/週間サマリー）。
--    アプリ側は本マイグレーションと同一 PR で ended_at を読まない・書かない形に
--    変更済み（BABY_LOG_COLUMNS / BabyLogData / 各 Server Action / 集計純関数）。
--
-- ② ENUM 値 'sleep' は残す
--    Postgres は ENUM ラベルを削除できない（ALTER TYPE ... DROP VALUE は存在せず、
--    型の作り直しは baby_logs.log_type への依存ゆえテーブル再構築を要する）。
--    ゆえに baby_log_type の 'sleep' はそのまま残し、「コードが二度と 'sleep' を
--    書かない」ことで無害化する。列挙型の値が減らないため、TypeScript 側の
--    BabyLogType からも 'sleep' は外さない（DB→TS の enum drift で
--    logTypeConfig[log_type] が undefined になり得る #147/#158 の再発を避ける）。
--
-- ③ 消したデータは復元不能
--    DELETE した睡眠行はバックアップ以外から戻せない。本番の睡眠行は **1 件**
--    （2026-07-28 に `supabase db dump --linked --data-only` の実体を数えて確認。
--    同時点で授乳 87 件・おむつ 50 件ゆえ、睡眠機能はほぼ使われていなかった）。
--    ローカル dev DB は適用前 0 件を実測。
--
-- ④ ended_at を他の log_type が使っていないことの根拠
--    grep ではなく DB 側で保証されている。20260410000001_baby_logs.sql:63-65 の
--      CONSTRAINT chk_ended_at CHECK (ended_at IS NULL OR log_type = 'sleep')
--    により「ended_at が非 NULL なら log_type は必ず 'sleep'」が全行で成立する。
--    ゆえに睡眠行を消した時点で ended_at は全行 NULL であり、列の DROP で
--    失われる情報は無い。
--
-- ⑤ 適用順序（コードが先・マイグレーションが後）
--    1. アプリのデプロイ（ended_at を SELECT / INSERT / UPDATE しないコード）
--    2. 本マイグレーションの適用
--    新コードは ended_at 列が残っている DB に対しても正常に動くが、逆順
--    （列を先に落として旧コードが残る）だと旧 SELECT の ended_at が
--    PostgREST の 400 になり /baby が全滅する。必ずこの向きで適用すること。
--    ローカルは `supabase db reset`（全マイグレーション再適用）で確認する。

-- 1. 睡眠行の削除（ended_at 非 NULL の行はこの時点で全て消える）
DELETE FROM baby_logs WHERE log_type = 'sleep';

-- 2. 睡眠専用 index の削除
--    idx_baby_logs_active_sleep  : 進行中の睡眠セッション検索（partial）
--    idx_one_active_sleep        : 世帯あたり 1 つのアクティブ睡眠を保証（partial unique）
--    どちらも述語に log_type = 'sleep' AND ended_at IS NULL を含み睡眠専用。
--    （DROP COLUMN でも暗黙に消えるが、意図を明示するため個別に落とす）
DROP INDEX IF EXISTS idx_baby_logs_active_sleep;
DROP INDEX IF EXISTS idx_one_active_sleep;

-- 3. 睡眠専用 CHECK 制約の削除（ended_at 依存ゆえ列より先に落とす）
ALTER TABLE baby_logs DROP CONSTRAINT IF EXISTS chk_ended_at;

-- 4. ended_at 列の削除
ALTER TABLE baby_logs DROP COLUMN IF EXISTS ended_at;
