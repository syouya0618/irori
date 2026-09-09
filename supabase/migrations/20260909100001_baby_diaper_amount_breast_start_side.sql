-- ============================================================
-- 育児記録: うんちの量（poop_amount）と母乳サイクルの開始側（breast_start_side）
-- ============================================================
--
-- ① poop_amount — 「うんち」記録に量（少量 / 大量）の属性を持たせる
--    別の log_type / diaper_type を増やさず、diaper 行の属性として足す。
--    既存行は NULL のまま（= 量の記録なし）で合法。backfill はしない（量は
--    事後に復元できない情報ゆえ捏造しない）。
--
-- ② breast_start_side — 母乳サイクル行（feeding_type='breast'）が「どちらの側から
--    吸わせ始めたか」を持つ。counts / sides（左右の回数・秒）は順序を持たぬため、
--    開始側は別列でしか表せない。既存行は NULL（不明）で合法。旧形式の localStorage
--    から復元した走行中タイマーも開始側を知らぬため NULL で保存してよい。
--
-- どちらも ENUM ではなく TEXT + CHECK にする。値を増やす時に ADD VALUE と CHECK を
-- 別 migration へ割る必要が無く（CLAUDE.md の罠）、クライアントは未知値を null へ
-- 退化させる（enum drift 防御）だけで済む。
--
-- CHECK は NULL 穴を塞ぐ形で書く（Postgres の CHECK は NULL を「許容」と扱う）:
-- `poop_amount IS NULL OR diaper_type IN ('poop','both')` だと diaper_type IS NULL の
-- 行に量が付いても式が NULL 評価で素通りする。IS NOT DISTINCT FROM で 3 値論理を
-- 潰す（chk_breast_counts_only_breast と同型）。

ALTER TABLE baby_logs ADD COLUMN IF NOT EXISTS poop_amount TEXT;
ALTER TABLE baby_logs ADD COLUMN IF NOT EXISTS breast_start_side TEXT;

COMMENT ON COLUMN baby_logs.poop_amount IS
  'うんちの量（small=少量 / large=大量）。diaper_type が poop / both の行のみ非 NULL。NULL は「量の記録なし」';
COMMENT ON COLUMN baby_logs.breast_start_side IS
  '母乳サイクル（feeding_type=breast）でどちらの側から吸わせ始めたか（left / right）。NULL は不明（列追加以前の行・旧形式タイマー復元）';

-- 値の集合（TEXT ゆえ CHECK で締める）
ALTER TABLE baby_logs DROP CONSTRAINT IF EXISTS chk_poop_amount_value;
ALTER TABLE baby_logs ADD CONSTRAINT chk_poop_amount_value
  CHECK (poop_amount IS NULL OR poop_amount IN ('small', 'large'));

ALTER TABLE baby_logs DROP CONSTRAINT IF EXISTS chk_breast_start_side_value;
ALTER TABLE baby_logs ADD CONSTRAINT chk_breast_start_side_value
  CHECK (breast_start_side IS NULL OR breast_start_side IN ('left', 'right'));

-- 量を持てるのは「うんちを含む」おむつ行だけ（pee 行・非 diaper 行への付着を拒否）
ALTER TABLE baby_logs DROP CONSTRAINT IF EXISTS chk_poop_amount_only_poop;
ALTER TABLE baby_logs ADD CONSTRAINT chk_poop_amount_only_poop
  CHECK (
    poop_amount IS NULL
    OR diaper_type IS NOT DISTINCT FROM 'poop'
    OR diaper_type IS NOT DISTINCT FROM 'both'
  );

-- 開始側を持てるのは母乳サイクル行だけ（bottle 等への化けを拒否する向き。
-- counts / sides と同じく「種別変更時は必ず同時に NULL 化する」契約を DB で強制）
ALTER TABLE baby_logs DROP CONSTRAINT IF EXISTS chk_breast_start_side_only_breast;
ALTER TABLE baby_logs ADD CONSTRAINT chk_breast_start_side_only_breast
  CHECK (
    breast_start_side IS NULL
    OR feeding_type IS NOT DISTINCT FROM 'breast'
  );
