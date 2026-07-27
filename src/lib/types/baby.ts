import type { BabyLogType, FeedingType, DiaperType } from "./database"

export interface BabyLogData {
  id: string
  log_type: BabyLogType
  logged_at: string
  logged_by: string
  feeding_type: FeedingType | null
  amount_ml: number | null
  /**
   * 母乳サイクルで左を吸わせた回数。`feeding_type='breast'` の行のみ非 NULL。
   * DB CHECK（chk_breast_counts_required / chk_breast_counts_only_breast）と対。
   */
  breast_left_count: number | null
  /** 母乳サイクルで右を吸わせた回数（同上） */
  breast_right_count: number | null
  /**
   * 母乳サイクルで左を吸わせた秒数。両 sides セットか両方 NULL（旧サイクル行は
   * NULL = 合計のみ保持）。セット時は duration_sec = 左 + 右 が CHECK で強制される
   * （chk_breast_side_sec_total）。
   */
  breast_left_sec: number | null
  /** 母乳サイクルで右を吸わせた秒数（同上） */
  breast_right_sec: number | null
  diaper_type: DiaperType | null
  ended_at: string | null
  temperature: number | null
  weight_g: number | null
  height_cm: number | null
  duration_min: number | null
  duration_sec: number | null
  memo: string | null
  created_at: string
}

/** 育児日記（1世帯・1日1本、baby_diaries）。SELECT で使う実データ形。 */
export interface BabyDiaryData {
  id: string
  diary_date: string
  content: string
  updated_at: string
}
