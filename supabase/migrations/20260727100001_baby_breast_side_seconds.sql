-- ============================================================
-- 授乳: 母乳サイクルの左右別授乳時間 breast_left_sec / breast_right_sec
-- ============================================================

-- サイクル行（feeding_type='breast'）に「左を何秒・右を何秒」を持たせる。
-- ENUM 追加なしのため単一マイグレーションでよい（ADD VALUE と CHECK の分離則は非該当）。
--
-- 設計原則:
-- ① 両方セットか両方 NULL（片side だけの中途半端な行を作らない）
-- ② duration_sec は常に「左右の和」（合計との二重真値源を禁止。書込はサーバが
--    sides から導出する1経路 — recordFeeding / updateLog の validateBreastSideSeconds）
-- ③ 旧サイクル行（#165 期・sides 概念なし）は両方 NULL のまま合法 = 「合計のみ持つ行」
--    として退化表示。左右の配分は原理的に復元不能ゆえ backfill で捏造しない。
--    localStorage 旧形式から復元した走行中タイマーも同じ理由で sides NULL で保存する。
--
-- 等式に IS NOT DISTINCT FROM を使う理由（NULL 穴の封鎖）:
-- `duration_sec = (left + right)` だと duration_sec IS NULL の行が NULL 評価で
-- CHECK を素通りし、「左右の時間は持つが合計は NULL」という無音の不整合が合法化する
-- （chk_breast_counts_only_breast で塞いだのと同型の穴。Postgres の CHECK は NULL を
-- 許容と扱う）。IS NOT DISTINCT FROM なら sides 非 NULL のとき duration_sec の
-- NULL も不一致も false になり拒否される。
--
-- 上限 10800 は chk_duration_sec の合計上限と同じ（クライアントは合計が超えないよう
-- **側ごとに比例縮小してから和を取る** — resolveBreastSideSeconds。合計を clamp して
-- から sides を送ると等式違反で記録が恒久失敗するため、その構成は禁止）。

ALTER TABLE baby_logs ADD COLUMN IF NOT EXISTS breast_left_sec SMALLINT;
ALTER TABLE baby_logs ADD COLUMN IF NOT EXISTS breast_right_sec SMALLINT;

-- sides を持てるのは breast 行だけ（counts と同じ NULL 穴封鎖形）
ALTER TABLE baby_logs DROP CONSTRAINT IF EXISTS chk_breast_side_sec_only_breast;
ALTER TABLE baby_logs ADD CONSTRAINT chk_breast_side_sec_only_breast
  CHECK (
    (breast_left_sec IS NULL AND breast_right_sec IS NULL)
    OR feeding_type IS NOT DISTINCT FROM 'breast'
  );

-- 両方セットか両方 NULL
ALTER TABLE baby_logs DROP CONSTRAINT IF EXISTS chk_breast_side_sec_pair;
ALTER TABLE baby_logs ADD CONSTRAINT chk_breast_side_sec_pair
  CHECK ((breast_left_sec IS NULL) = (breast_right_sec IS NULL));

-- セット時は各 0..10800 かつ合計 = duration_sec（NULL 穴なしの等式）
ALTER TABLE baby_logs DROP CONSTRAINT IF EXISTS chk_breast_side_sec_total;
ALTER TABLE baby_logs ADD CONSTRAINT chk_breast_side_sec_total
  CHECK (
    breast_left_sec IS NULL
    OR (
      breast_left_sec BETWEEN 0 AND 10800
      AND breast_right_sec BETWEEN 0 AND 10800
      AND duration_sec IS NOT DISTINCT FROM (breast_left_sec + breast_right_sec)
    )
  );
