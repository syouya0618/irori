-- ============================================================
-- 授乳: 母乳サイクルの左右回数 breast_left_count / breast_right_count（パート2: 列 + CHECK）
-- ============================================================

-- サイクル行（feeding_type='breast'）は「1回の授乳で左を何回・右を何回吸わせたか」を
-- 1行に持つ。ENUM への 'breast' 追加（20260726100001）とは別トランザクションで適用する
-- 必要がある（新 ENUM 値を参照する CHECK は ADD VALUE と同一トランザクション内で使えない）。
--
-- 量の上限 20 は「1回の授乳で片側 20 回以上吸わせ替えることはない」という実用上の
-- 上振れ。合計 >= 1 は「どちらも 0 回のサイクル行＝授乳していない行」を弾く。
--
-- amount_ml については追加の制約は不要: chk_amount_ml（20260721000002）が
-- `amount_ml IS NULL OR feeding_type IN ('bottle','solid','pumped')` ゆえ、
-- 'breast' 行は既に amount_ml NULL を強制されている（サイクル行に量の概念は無い）。

ALTER TABLE baby_logs ADD COLUMN IF NOT EXISTS breast_left_count SMALLINT;
ALTER TABLE baby_logs ADD COLUMN IF NOT EXISTS breast_right_count SMALLINT;

-- ── 双方向とも厳格にする理由（silent corruption の封じ） ──────────────
-- Flutter の編集シートは feeding_type / amount_ml / memo の**部分 update** を行う
-- （flutter/lib/features/baby/data/baby_repository.dart:229-233 の updateFeeding が
-- この3列だけを送る）。breast_left_count / breast_right_count は送らないため、
-- 緩い CHECK（例: 片方向だけの制約）だと **breast 行が counts を残したまま bottle に
-- 化ける**。その行は「ミルクなのに左右回数を持つ」矛盾状態で DB に居座り、集計は
-- bottle として数えるのに UI は左右内訳を出す、という無音の破損になる。
-- 双方向を厳格にしておけば、その部分 update は 42xxx（check_violation）で
-- **fail-loud に拒否**され、Flutter 側にエラーが返る（#159 の未知 enum 値の
-- null 退化＝読み取り側の防御と対になる、書き込み側の防御）。

-- counts を持てるのは breast 行だけ（bottle 等への化けを拒否する向き）
ALTER TABLE baby_logs DROP CONSTRAINT IF EXISTS chk_breast_counts_only_breast;
ALTER TABLE baby_logs ADD CONSTRAINT chk_breast_counts_only_breast
  CHECK (
    (breast_left_count IS NULL AND breast_right_count IS NULL)
    OR feeding_type = 'breast'
  );

-- breast 行は counts を必ず持ち、範囲内で合計 1 以上（counts 欠落を拒否する向き）
ALTER TABLE baby_logs DROP CONSTRAINT IF EXISTS chk_breast_counts_required;
ALTER TABLE baby_logs ADD CONSTRAINT chk_breast_counts_required
  CHECK (
    feeding_type IS DISTINCT FROM 'breast'
    OR (
      breast_left_count IS NOT NULL
      AND breast_right_count IS NOT NULL
      AND breast_left_count BETWEEN 0 AND 20
      AND breast_right_count BETWEEN 0 AND 20
      AND breast_left_count + breast_right_count >= 1
    )
  );
