import { describe, it, expect } from "vitest"
import { BABY_LOG_COLUMNS } from "../baby-log-columns"
import type { BabyLogData } from "@/lib/types/baby"

/**
 * BABY_LOG_COLUMNS ⇄ BabyLogData の両方向 drift 検出器。
 *
 * SELECT 文字列から列を落としても型は通り実体だけが undefined になる
 * （baby-log-columns.ts の docstring が警告する罠）。ミューテーション実測 M14 では
 * breast counts 2列を落としても vitest 883 本が全緑で生き残り、網は e2e のみだった。
 *
 * - リテラル COMPLETE は BabyLogData 型注釈により**フィールド欠落で tsc が落ちる**
 *   （型にフィールドを足したら、ここと BABY_LOG_COLUMNS の両方の更新が強制される）
 * - 実行時の集合比較により、SELECT 側の落とし・余分・タイポも赤になる
 */
const COMPLETE: BabyLogData = {
  id: "",
  log_type: "feeding",
  logged_at: "",
  logged_by: "",
  feeding_type: null,
  amount_ml: null,
  breast_left_count: null,
  breast_right_count: null,
  breast_left_sec: null,
  breast_right_sec: null,
  diaper_type: null,
  ended_at: null,
  temperature: null,
  weight_g: null,
  height_cm: null,
  duration_min: null,
  duration_sec: null,
  memo: null,
  created_at: "",
}

describe("BABY_LOG_COLUMNS", () => {
  it("BabyLogData の全フィールドと過不足なく一致する（SELECT 落とし・タイポの drift 検出）", () => {
    const columns = BABY_LOG_COLUMNS.split(",")
      .map((c) => c.trim())
      .sort()
    const fields = Object.keys(COMPLETE).sort()
    expect(columns).toEqual(fields)
  })
})
