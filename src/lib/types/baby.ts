import type {
  BabyLogType,
  FeedingType,
  DiaperType,
  PoopAmount,
  BreastStartSide,
} from "./database"

export interface BabyLogData {
  child_id?: string
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
  /**
   * 母乳サイクルでどちらの側から吸わせ始めたか。`feeding_type='breast'` の行のみ
   * 非 NULL 可（chk_breast_start_side_only_breast）。NULL は不明（列追加以前の行・
   * 旧形式 localStorage から復元したタイマー）。counts / sides は順序を持たぬため
   * 開始側はこの列でしか表せない。
   */
  breast_start_side: BreastStartSide | null
  diaper_type: DiaperType | null
  /**
   * うんちの量（少量 / 大量）。`diaper_type` が poop / both の行のみ非 NULL 可
   * （chk_poop_amount_only_poop）。NULL は「量の記録なし」（列追加以前の行・
   * クイック記録で量を選ばなかった行）ゆえ、表示は量なしとして退化させる。
   */
  poop_amount: PoopAmount | null
  temperature: number | null
  weight_g: number | null
  height_cm: number | null
  duration_min: number | null
  duration_sec: number | null
  memo: string | null
  created_at: string
  /**
   * 最終更新時刻（DB トリガー trg_baby_logs_updated_at が UPDATE ごとに now() を振る）。
   * 二つの役目がある:
   * - 編集の版（P2-07）: 編集シートは開いた時点のこの値を updateLog へ送り、サーバは
   *   この版を条件に書く。表記のまま運ぶこと（`new Date()` でマイクロ秒が落ちる）。
   * - 到着順の逆転対策: 古い版で新しい版を上書きせぬ比較（applyUpdatedLog / isOlderLogVersion）。
   * 楽観 append の行も作成の応答の版を持つ（buildOptimisticLog）。optional なのは、版を
   * 持たぬ形（テストの断片等）でも比較を飛ばして置き換えられるようにするため。
   */
  updated_at?: string | null
}

/** 育児日記（1世帯・1日1本、baby_diaries）。SELECT で使う実データ形。 */
export interface BabyDiaryData {
  child_id?: string
  id: string
  diary_date: string
  content: string
  updated_at: string
}
