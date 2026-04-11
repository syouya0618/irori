import type { BabyLogType, FeedingType, DiaperType } from "./database"

export interface BabyLogData {
  id: string
  log_type: BabyLogType
  logged_at: string
  logged_by: string
  feeding_type: FeedingType | null
  amount_ml: number | null
  diaper_type: DiaperType | null
  ended_at: string | null
  temperature: number | null
  weight_g: number | null
  height_cm: number | null
  duration_min: number | null
  memo: string | null
  created_at: string
}
