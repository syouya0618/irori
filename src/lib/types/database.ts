export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type HouseholdRole = "owner" | "member" | "viewer"
export type InviteStatus = "pending" | "accepted" | "expired"
export type BabyLogType =
  | "feeding"
  | "diaper"
  /**
   * 睡眠機能は撤去済み（20260728100001_drop_baby_sleep.sql）。新規に書かれることは
   * 二度とないが、Postgres は ENUM ラベルを削除できず baby_log_type からは
   * 'sleep' が消えない。DB→TS の enum drift（#147/#158）で
   * `logTypeConfig[log_type]` が undefined になるのを避けるため union には残す。
   */
  | "sleep"
  | "temperature"
  | "growth"
  | "memo"
export type FeedingType =
  /** 母乳サイクル（左右の吸わせ回数を breast_left_count/right_count に持つ1行） */
  | "breast"
  /** 移行前の片側行（過去データ専用・新規記録では使わない） */
  | "breast_left"
  /** 移行前の片側行（過去データ専用・新規記録では使わない） */
  | "breast_right"
  | "bottle"
  | "solid"
  | "pumped"
export type DiaperType = "pee" | "poop" | "both"
/**
 * うんちの量（`baby_logs.poop_amount`）。DB 側は TEXT + CHECK（20260909100001）ゆえ
 * migration で値が増えうる — 未知値で画面を倒さず null へ退化させること（enum drift 防御）。
 * NULL は「量の記録なし」（列追加以前の行・量を選ばずに記録した行）。
 */
export type PoopAmount = "small" | "large"
/**
 * 母乳サイクル（feeding_type='breast'）でどちらの側から吸わせ始めたか
 * （`baby_logs.breast_start_side`）。TEXT + CHECK。NULL は不明（列追加以前の行・
 * 旧形式 localStorage から復元したタイマー）。
 */
export type BreastStartSide = "left" | "right"
export type CalendarEventSource = "native" | "google"
/**
 * Google 接続の恒久状態。`needs_reauth` は refresh token 失効（invalid_grant）で、
 * 再連携バナーの出し分けに使う。DB 側は TEXT + CHECK ゆえ migration で値が増えうる
 * — 未知値で画面を倒さず退化表示すること（enum drift 防御）。
 */
export type GoogleConnectionStatus = "active" | "needs_reauth"
/** 同期の一過性状態（`error` は D-5 の一時表示用。恒久失敗は connection_status が持つ） */
export type GoogleSyncStatus = "idle" | "syncing" | "error"
/** 直近の失敗の種別（UI 文言の分岐用） */
export type GoogleSyncErrorKind =
  | "invalid_grant"
  | "gone"
  | "quota"
  | "network"
  | "unknown"

export interface Database {
  public: {
    Tables: {
      news_ai_cache: { Row: { key: string; result: Json; created_at: string }; Insert: { key: string; result: Json }; Update: { result?: Json }; Relationships: [] }
      news_ai_budget: { Row: { day: string; calls: number }; Insert: { day: string; calls: number }; Update: { calls?: number }; Relationships: [] }
      news_batches:{Row:{user_id:string;day:string;household_id:string;region_key:string;article_ids:string[]};Insert:never;Update:never;Relationships:[]}
      news_preferences:{Row:{user_id:string;region_key:string|null;enabled:boolean;enabled_from:string;updated_at:string};Insert:never;Update:never;Relationships:[]}
      news_articles:{Row:{ai_category:string|null;ai_summary:string|null;region_key:string;id:string;title:string;url:string;published_at:string|null;source_key:string;first_seen_at:string;min_months:number|null;max_months:number|null};Insert:{ai_category?:string|null;ai_summary?:string|null;region_key:string;id:string;title:string;url:string;published_at:string|null;source_key:string;min_months?:number|null;max_months?:number|null};Update:{ai_category?:string|null;ai_summary?:string|null};Relationships:[]}
      news_source_runs:{Row:{region_key:string;source_key:string;claimed_at:string;last_success_at:string|null;last_error_at:string|null};Insert:never;Update:{last_success_at?:string;last_error_at?:string|null};Relationships:[]}
      news_deliveries:{Row:{id:string;recipient_id:string;household_id:string;region_key:string;day:string;subscription_id:string|null;article_ids:string[];sent_at:string|null;accepted_at:string|null;skipped_at:string|null};Insert:never;Update:{sent_at?:string|null;accepted_at?:string|null;skipped_at?:string|null};Relationships:[]}
      // ── ごみ（予定の用途）ここから: supabase/migrations/20261111100001_event_purposes.sql ──
      /**
       * 予定の用途（ごみの日）と前日通知の既定。世帯単位・authenticated は SELECT のみ
       * （書込は下の Functions の `save_event_purpose` 等だけ）。
       *
       * `calendar_events` とは鍵で結び **FK は張らぬ**（Google の 410 完全再同期が行を
       * DELETE→INSERT し直すため）:
       *   - `scope: "event"` … `target_key` = `calendar_events.event_uid`
       *   - `scope: "series"` … native は `series_id`、google は `google_calendar_id|recurring_event_id`
       *
       * `scope` / `purpose` / `remind_default` は DB では text + CHECK。読む側は未知の値を
       * 退化させること（`src/lib/domain/garbage.ts` の `parseEventPurposeRow`）。ここの型は
       * migration 時点の値域を書いておるだけで、将来の値を拒む根拠にせぬ。
       */
      event_purposes: {
        Row: {
          id: string
          household_id: string
          scope: string
          target_key: string
          /** "garbage" / "normal"（この回だけ通常へ戻す）/ null（通知の明示 OFF だけを持つ行） */
          purpose: string | null
          /** ごみの名称（1〜20 文字）。purpose が "garbage" の時だけ非 null */
          garbage_kind: string | null
          /** series だけが持つ。"prev_day_20" / "none" */
          remind_default: string | null
          /** event だけが意味を持つ。この回の通知を明示的に止めた印 */
          reminder_opt_out: boolean
          created_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: never
        Update: never
        Relationships: []
      }
      // ── ごみ（予定の用途）ここまで ──
      // ── ごはん（献立・在庫・買い物）ここから: supabase/migrations/20261111100003_dinner_tables.sql ──
      // 全表が世帯単位。authenticated は SELECT のみ（書込は下の Functions の RPC だけ）。
      // 版は updated_at（PostgREST の表記のまま運ぶ）。numeric / bigint 列は JSON の number で届く。
      /** 世帯のごはん設定。行が無い世帯は既定値（2 人分・汁物なし・時間上限なし・常備品なし）として扱う。 */
      dinner_settings: {
        Row: { household_id: string; servings: number; include_soup: boolean; max_cook_minutes: number | null; staples: string[]; child_stages: Json; updated_by: string | null; updated_at: string; created_at: string }
        Insert: never
        Update: never
        Relationships: []
      }
      /** 在庫。`ingredient_id` が null の行は食材辞書へ未解決（名前のまま扱い、提案の材料に数えない）。 */
      pantry_items: {
        Row: { id: string; household_id: string; ingredient_id: string | null; name: string; quantity: number | null; unit: string | null; status: "have" | "low" | "out"; use_soon: boolean; storage: "fridge" | "freezer" | "pantry" | null; expires_on: string | null; confirmed_on: string; created_by: string | null; updated_at: string; created_at: string }
        Insert: never
        Update: never
        Relationships: []
      }
      /** 必須除外（アレルギー・苦手）。正規メンバーなら誰でも登録・削除できる。`dedupe_key` は DB の生成列。 */
      food_exclusions: {
        Row: { id: string; household_id: string; subject_kind: "household" | "member" | "child"; subject_profile_id: string | null; subject_child_id: string | null; reason: "allergy" | "dislike"; target_kind: "allergen" | "ingredient" | "custom"; target_id: string | null; custom_label: string | null; created_by: string | null; updated_at: string; created_at: string; dedupe_key: string }
        Insert: never
        Update: never
        Relationships: []
      }
      /** 好み（採点用）。`scope='personal'` は `profile_id` の本人だけが変更・削除できる（読むのは世帯の正規メンバー全員）。 */
      food_preferences: {
        Row: { id: string; household_id: string; scope: "household" | "personal"; profile_id: string | null; target_kind: "recipe" | "ingredient" | "tag"; target_id: string; sentiment: "like" | "dislike"; updated_at: string; created_at: string }
        Insert: never
        Update: never
        Relationships: []
      }
      /** 食後評価（本人・料理・日付で 1 件）。本人だけが書ける。`dish_key` は DB の生成列。 */
      dish_feedback: {
        Row: { id: string; household_id: string; profile_id: string; recipe_id: string | null; dish_title: string; eaten_on: string; taste: number | null; effort: number | null; again: boolean | null; exclude_from_learning: boolean; updated_at: string; created_at: string; dish_key: string }
        Insert: never
        Update: never
        Relationships: []
      }
      /** 献立全体の版。行が無い世帯の版は 0。`grocery_revision` は買い物の自動項目を最後に同期したときの献立の版。 */
      dinner_plan_state: {
        Row: { household_id: string; revision: number; last_operation_id: string | null; last_request_hash: string | null; grocery_operation_id: string | null; grocery_request_hash: string | null; grocery_revision: number | null; updated_at: string }
        Insert: never
        Update: never
        Relationships: []
      }
      /** 献立の 1 枠。`recipe_id`（+ `recipe_version`）か `custom_title` のどちらか一方。`custom_ingredients` はアプリの `RecipeIngredient[]`。 */
      dinner_plan_entries: {
        /** `prior_status` = 「作った」「作らなかった」にする直前の状態（取り消しで戻す先）。RPC が遷移の時に保持する。 */
        Row: { id: string; household_id: string; plan_date: string; role: "main" | "side" | "staple" | "soup"; position: number; recipe_id: string | null; recipe_version: number | null; custom_title: string | null; custom_ingredients: Json | null; servings: number; pinned: boolean; status: "proposed" | "confirmed" | "cooked" | "skipped"; prior_status: "proposed" | "confirmed" | null; origin: "auto" | "manual" | "ai_assisted"; created_by: string | null; updated_at: string; created_at: string }
        Insert: never
        Update: never
        Relationships: []
      }
      /**
       * 買い物項目。`origin='auto'` は `item_key`（食材ID|単位族）で再計算のたびに upsert され、`origin='manual'` は `'manual|' + id`。
       * `section` は利用者の上書き（null = 食材辞書の既定）。
       * `purchased_quantity` / `purchased` は**購入の事実**（購入の操作だけが書く。「作った」・同期では書き換えない）。
       * `purchase_updated_at` = 購入の事実か、その意味（品名・単位）を最後に変えた時刻（null = 一度も変えていない）。
       *   `set_grocery_purchase` は送られた版が「これ以後で、今の `updated_at` を超えない」なら通す（購入の事実と意味が
       *   変わっていなければ、必要量・充当・補充・メモだけが変わった後の画面からも購入を記録できる）。
       * `consumptions` / `consumed_quantity` は作った料理へ充当した量の台帳と合計（`irori_private.dinner_grocery_settle`
       *   だけが書く。同期・献立の状態の保存・購入・補充の RPC が書く前に呼ぶ）。要素は
       *   `{ k: 枠 ID | "settled", q: 量, m: 印のまとまりか, d?: 枠の日付, on: 充当中か, pc?: 眠らせた時に印を戻したか }`。
       *   `on=false` は眠り（数えない。枠がまた消費済みになれば起こす）。`consumed_quantity` は `on` の `q` の合計。
       *   `purchase_consumed` = 購入の印を作った料理で使い終えたか（画面の印 = `purchased && !purchase_consumed`）。
       * 残り（不足）= `required_quantity −（purchased_quantity − restocked_quantity − consumed_quantity）`（後者は 0 未満にしない）。
       * `still_needed=false` は献立からは不要になったが購入・メモ・補充・充当の記録があるので残っている自動項目。
       * `sources` はアプリの `GrocerySource[]`、`restock_ids` は在庫へ反映済みの在庫行 ID。
       * Insert / Update は `never`（authenticated に書込の GRANT もポリシーも無い。書込は RPC だけ）。
       */
      grocery_items: {
        Row: { id: string; household_id: string; origin: "auto" | "manual"; item_key: string; ingredient_id: string | null; name: string; section: string | null; required_quantity: number | null; unit: string | null; required_note: string | null; needs_stock_check: boolean; sources: Json; purchased_quantity: number; purchased: boolean; purchased_at: string | null; purchased_by: string | null; purchase_updated_at: string | null; restocked_quantity: number; restock_ids: string[]; consumptions: Json; consumed_quantity: number; purchase_consumed: boolean; note: string | null; plan_revision: number | null; still_needed: boolean; created_by: string | null; updated_at: string; created_at: string }
        Insert: never
        Update: never
        Relationships: []
      }
      /** AI 補助の回数計上（世帯 × UTC 日）。authenticated には GRANT なし（RPC 経由のみ）。 */
      dinner_ai_usage: {
        Row: { household_id: string; usage_day: string; calls: number }
        Insert: never
        Update: never
        Relationships: []
      }
      /** 無料枠の枯渇による全世帯の停止（単一行）。authenticated には GRANT なし。 */
      dinner_ai_provider_state: {
        Row: { id: boolean; exhausted_until: string | null; updated_at: string }
        Insert: never
        Update: never
        Relationships: []
      }
      // ── ごはん ここまで ──
      // ── 掃除（ルーティーンと履歴）ここから: supabase/migrations/20261111100002_cleaning_routines.sql ──
      // 両表とも世帯単位。authenticated は SELECT のみ（書込は下の Functions の RPC だけ）。
      // 版は updated_at（PostgREST の表記のまま運ぶ）。date 列は "YYYY-MM-DD"。
      // cadence_unit / schedule_mode / kind は DB では text + CHECK。読む側は未知の値を退化させること
      // （`src/lib/domain/cleaning.ts` の `parseCleaningRoutine` / `parseCleaningLog`）。
      /** 掃除の項目の定義。前回実施日は持たぬ（正本は cleaning_logs の有効な done）。 */
      cleaning_routines: {
        Row: { id: string; household_id: string; name: string; location: string | null; cadence_unit: string; cadence_interval: number; schedule_mode: string; anchor_date: string; postponed_occurrence: string | null; postponed_until: string | null; paused_at: string | null; resume_floor: string | null; archived: boolean; cadence_epoch: number; created_by: string | null; updated_by: string | null; updated_at: string; created_at: string }
        Insert: never
        Update: never
        Relationships: []
      }
      /**
       * 掃除の履歴。`occurrence` は閉じた回の鍵（過去日の追記は null）。`scheduled_on` はスキップした回の
       * 予定日（skip だけが持つ。DB の record_cleaning_log が計算して入れる）。取り消しは `voided_at`（行は残る）。
       */
      cleaning_logs: {
        Row: { id: string; household_id: string; routine_id: string; kind: string; done_on: string | null; occurrence: string | null; scheduled_on: string | null; cadence_epoch: number; note: string | null; voided_at: string | null; voided_by: string | null; created_by: string | null; updated_at: string; created_at: string }
        Insert: never
        Update: never
        Relationships: []
      }
      // ── 掃除 ここまで ──
      custom_fields: {
        Row:{id:string;household_id:string;label:string;value_type:"number"|"boolean"|"text"|"datetime"|"choice";options:Json;archived:boolean;updated_at:string;created_at:string}
        Insert:never
        Update:never
        Relationships:[]
      }
      custom_records: {
        Row:{id:string;household_id:string;child_id:string;field_id:string;field_label:string;value_type:"number"|"boolean"|"text"|"datetime"|"choice";field_options:Json;value:Json;logged_at:string;memo:string|null;voided:boolean;created_by:string|null;updated_at:string;created_at:string;search_text:string}
        Insert:never
        Update:never
        Relationships:[]
      }
      medical_records: {
        Row: { id:string;household_id:string;child_id:string;kind:"vaccination"|"checkup";title:string;dose:number|null;status:"planned"|"completed"|"cancelled";scheduled_date:string;completed_date:string|null;memo:string|null;remind:boolean;source_key:string;created_by:string|null;updated_at:string;created_at:string }
        Insert: never
        Update: never
        Relationships: []
      }
      sleep_sessions: {
        Row: { id: string; household_id: string; child_id: string; started_at: string; ended_at: string | null; started_by: string | null; ended_by: string | null; memo: string | null; voided: boolean; updated_at: string; created_at: string }
        Insert: never
        Update: never
        Relationships: []
      }

      child_shares: {
        Row: { id: string; household_id: string; child_id: string; invitation_id: string; viewer_id: string | null; allow_daily: boolean; allow_diary: boolean; allow_health: boolean; allow_custom: boolean; expires_at: string | null; revoked_at: string | null; created_at: string }
        Insert: never
        Update: never
        Relationships: []
      }
      children: {
        Row: { id: string; household_id: string; name: string; birth_date: string | null; sex: string | null; is_legacy: boolean; feeding_interval_min: number; bottle_default_ml: number | null; created_at: string; updated_at: string }
        Insert: { id?: string; household_id: string; name: string; birth_date?: string | null; sex?: string | null; is_legacy?: boolean; feeding_interval_min?: number; bottle_default_ml?: number | null }
        Update: { name?: string; birth_date?: string | null; sex?: string | null; feeding_interval_min?: number; bottle_default_ml?: number | null }
        Relationships: []
      }

      feeding_amount_history: {
        Row: { user_id: string; household_id: string; child_id: string; feeding_type: string; amount_ml: number; use_order: number }
        Insert: never
        Update: never
        Relationships: []
      }
      households: {
        Row: {
          id: string
          name: string
          baby_name: string | null
          baby_birth_date: string | null
          feeding_interval_min: number
          /** いつものミルク量（ml・1〜999）。NULL は未設定（migration 20261025100001） */
          bottle_default_ml: number | null
          created_at: string
        }
        Insert: {
          id?: string
          name?: string
          baby_name?: string | null
          baby_birth_date?: string | null
          feeding_interval_min?: number
          bottle_default_ml?: number | null
          created_at?: string
        }
        Update: {
          id?: string
          name?: string
          baby_name?: string | null
          baby_birth_date?: string | null
          feeding_interval_min?: number
          bottle_default_ml?: number | null
          created_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          id: string
          household_id: string | null
          display_name: string
          avatar_url: string | null
          role: HouseholdRole
          is_approved: boolean
          default_page: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id: string
          household_id?: string | null
          display_name?: string
          avatar_url?: string | null
          role?: HouseholdRole
          is_approved?: boolean
          default_page?: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          household_id?: string | null
          display_name?: string
          avatar_url?: string | null
          role?: HouseholdRole
          is_approved?: boolean
          default_page?: string
          updated_at?: string
        }
        Relationships: []
      }
      invitations: {
        Row: {
          purpose: "member" | "child_share"
          id: string
          household_id: string
          invited_by: string
          token: string
          role: HouseholdRole
          status: InviteStatus
          expires_at: string
          accepted_by: string | null
          created_at: string
        }
        Insert: {
          id?: string
          household_id: string
          invited_by: string
          token?: string
          role?: HouseholdRole
          status?: InviteStatus
          expires_at?: string
          accepted_by?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          status?: InviteStatus
          accepted_by?: string | null
        }
        Relationships: []
      }
      baby_logs: {
        Row: {
          child_id: string
          id: string
          household_id: string
          log_type: BabyLogType
          logged_at: string
          logged_by: string
          feeding_type: FeedingType | null
          amount_ml: number | null
          /** 母乳サイクルで左を吸わせた回数（feeding_type='breast' の行のみ非 NULL・0..20） */
          breast_left_count: number | null
          /** 母乳サイクルで右を吸わせた回数（feeding_type='breast' の行のみ非 NULL・0..20） */
          breast_right_count: number | null
          /** 母乳サイクルの左の授乳秒数（両 sides セット or 両 NULL・duration_sec = 左+右） */
          breast_left_sec: number | null
          /** 母乳サイクルの右の授乳秒数（同上） */
          breast_right_sec: number | null
          /** 母乳サイクルの開始側（breast 行のみ非 NULL 可・NULL は不明） */
          breast_start_side: BreastStartSide | null
          diaper_type: DiaperType | null
          /** うんちの量（diaper_type が poop / both の行のみ非 NULL 可・NULL は記録なし） */
          poop_amount: PoopAmount | null
          temperature: number | null
          weight_g: number | null
          height_cm: number | null
          duration_min: number | null
          duration_sec: number | null
          memo: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          child_id?: string | null
          id?: string
          household_id: string
          log_type: BabyLogType
          logged_at?: string
          logged_by: string
          feeding_type?: FeedingType | null
          amount_ml?: number | null
          breast_left_count?: number | null
          breast_right_count?: number | null
          breast_left_sec?: number | null
          breast_right_sec?: number | null
          breast_start_side?: BreastStartSide | null
          diaper_type?: DiaperType | null
          poop_amount?: PoopAmount | null
          temperature?: number | null
          weight_g?: number | null
          height_cm?: number | null
          duration_min?: number | null
          duration_sec?: number | null
          memo?: string | null
        }
        Update: {
          child_id?: string | null
          log_type?: BabyLogType
          logged_at?: string
          feeding_type?: FeedingType | null
          amount_ml?: number | null
          breast_left_count?: number | null
          breast_right_count?: number | null
          breast_left_sec?: number | null
          breast_right_sec?: number | null
          breast_start_side?: BreastStartSide | null
          diaper_type?: DiaperType | null
          poop_amount?: PoopAmount | null
          temperature?: number | null
          weight_g?: number | null
          height_cm?: number | null
          duration_min?: number | null
          duration_sec?: number | null
          memo?: string | null
        }
        Relationships: []
      }
      baby_diaries: {
        Row: {
          child_id: string
          id: string
          household_id: string
          /** JST の暦日 "YYYY-MM-DD"（1世帯・1日につき1本、UNIQUE） */
          diary_date: string
          content: string
          updated_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          child_id?: string | null
          id?: string
          household_id: string
          diary_date: string
          content: string
          updated_by?: string | null
        }
        Update: {
          child_id?: string | null
          content?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      calendar_events: {
        Row: {
          child_id: string | null
          id: string
          household_id: string
          title: string
          memo: string | null
          is_all_day: boolean
          start_date: string // YYYY-MM-DD (JST)
          end_date: string // YYYY-MM-DD (JST, inclusive)
          start_at: string | null // ISO 8601 (timed only)
          end_at: string | null
          source: CalendarEventSource
          series_id: string | null // 繰り返しシリーズ識別子(単発は null)
          google_event_id: string | null
          google_calendar_id: string | null
          etag: string | null
          ical_uid: string | null
          /** 由来の購読（ON DELETE SET NULL: 購読が消えても予定は残る = V9） */
          subscription_id: string | null
          /** どの配偶者の接続経由で入った行か（google 行のみ） */
          source_user_id: string | null
          location: string | null
          html_link: string | null
          /** 繰り返しの親 id（singleEvents=true で展開された各回に付く） */
          recurring_event_id: string | null
          google_updated: string | null
          synced_at: string | null
          /**
           * 削除→再挿入（410 フル再同期）をまたいで不変な同一性キー（**生成列**）。
           * google 行は `google_calendar_id|google_event_id`、native 行は `id`。
           * `event_reminders` の結合キーじゃ。
           *
           * ⚠️ **`CALENDAR_EVENT_COLUMNS` には入れておらぬ**（入れると migration より
           * 先にコードが出た瞬間に、この定数を共有する 4 画面が同時に落ちる）。
           * 必要な箇所が `.select("id, event_uid")` のように個別に取ること。
           *
           * ⚠️ 生成列ゆえ **書けぬ** → `Insert` / `Update` には出しておらぬ。
           */
          event_uid: string
          medical_record_id?: string | null
          created_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          child_id?: string | null
          id?: string
          household_id: string
          title: string
          memo?: string | null
          is_all_day?: boolean
          start_date: string
          end_date: string
          start_at?: string | null
          end_at?: string | null
          source?: CalendarEventSource
          series_id?: string | null
          google_event_id?: string | null
          google_calendar_id?: string | null
          etag?: string | null
          ical_uid?: string | null
          subscription_id?: string | null
          source_user_id?: string | null
          location?: string | null
          html_link?: string | null
          recurring_event_id?: string | null
          google_updated?: string | null
          synced_at?: string | null
          created_by?: string | null
        }
        Update: {
          child_id?: string | null
          title?: string
          memo?: string | null
          is_all_day?: boolean
          start_date?: string
          end_date?: string
          start_at?: string | null
          end_at?: string | null
          series_id?: string | null
          // source / google_* は native 行の編集で触らない(型上も出さない)
        }
        Relationships: []
      }
      /**
       * 予定への通知設定（B-2・**世帯単位**）。夫が付けた通知は妻にも届く。
       *
       * ⚠️ `calendar_events` へは **FK を張っておらぬ**。`event_uid` で結ぶ
       * （410 フル再同期が google 行を DELETE→INSERT し直すため、行 id で結ぶと
       * CASCADE で全滅／SET NULL で迷子になる）。
       *
       * ⚠️ `remind_at` は **BEFORE トリガが導出する唯一の真値**ゆえ、
       * `Insert` / `Update` に出しておらぬ。送っても列 GRANT が無く `42501` で落ちる。
       * 同様に `created_by` / `created_at` / `updated_at` もトリガと DEFAULT の領分。
       */
      event_reminders: {
        Row: {
          id: string
          event_uid: string
          household_id: string
          remind_kind: string
          remind_minutes_before: number | null
          remind_at: string
          created_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          event_uid: string
          household_id: string
          remind_kind: "minutes" | "prev_day_20"
          remind_minutes_before?: number | null
        }
        Update: {
          remind_kind?: "minutes" | "prev_day_20"
          remind_minutes_before?: number | null
        }
        Relationships: []
      }
      /**
       * 通知の個人設定（**ユーザー単位**）。event_reminders が世帯単位なのと
       * 意図的に非対称じゃ:「いつ通知を出すか」は世帯の合意、「既定でどれを選ぶか」は
       * 個人の好み。
       *
       * ⚠️ `digest_time` は TZ を持たぬ `TIME` ゆえ **JST 壁時計として解釈する契約**
       * （列 COMMENT が正本）。素で UTC 比較すると 9 時間ずれる。
       */
      notification_preferences: {
        Row: {
          user_id: string
          event_default_minutes: number | null
          digest_time: string | null
          feeding_reminder_minutes: number | null
          updated_at: string
        }
        Insert: {
          user_id: string
          event_default_minutes?: number | null
          digest_time?: string | null
          feeding_reminder_minutes?: number | null
        }
        Update: {
          event_default_minutes?: number | null
          digest_time?: string | null
          feeding_reminder_minutes?: number | null
        }
        Relationships: []
      }
      /**
       * 通知の配信キュー兼履歴（**世帯単位**・B-3）。
       *
       * ⚠️ **書き手は service role の配信ジョブただ 1 つ**じゃ。IUD の RLS ポリシーも
       * GRANT も無く、authenticated から撃てば 42501 で落ちる（型が書けるように
       * 見えるのは `google_connections` と同じ事情）。
       *
       * ⚠️ 冪等キーは `(kind, event_key, subscription_key, dedupe_day)` の
       * **UNIQUE NULLS NOT DISTINCT**。`subscription_id` を鍵に入れてはならぬ
       * （FK の ON DELETE SET NULL が 2 台目の端末失効で 23505 を起こし、
       * DELETE ごと中断する。migration 20260808100003 の核 ③）。
       */
      notification_deliveries: {
        Row: {
          id: string
          household_id: string
          kind: string
          /** `event_reminders.event_uid` の不変コピー（FK は張らぬ）。digest は null */
          event_key: string | null
          /** 生きておる購読への指し先。失効すると SET NULL で null になる */
          subscription_id: string | null
          /** 冪等キー用の不変コピー。購読が消えても動かぬ */
          subscription_key: string
          /** scheduled_at の JST 暦日（**実行日ではない**） */
          dedupe_day: string
          scheduled_at: string
          /** claim 兼 送信済み印 */
          sent_at: string | null
          skipped_at: string | null
          skip_reason: string | null
          created_at: string
        }
        Insert: {
          household_id: string
          kind: string
          event_key?: string | null
          subscription_id?: string | null
          subscription_key: string
          dedupe_day: string
          scheduled_at: string
          sent_at?: string | null
          skipped_at?: string | null
          skip_reason?: string | null
        }
        Update: {
          scheduled_at?: string
          sent_at?: string | null
          skipped_at?: string | null
          skip_reason?: string | null
        }
        Relationships: []
      }
      /**
       * 配信ジョブの心拍（**1 行固定**・id = 1 を CHECK が強制する）。
       *
       * 「最終配信」（MAX(sent_at)）だけでは**故障と無風を区別できぬ**ゆえに在る。
       * 認証済みなら誰でも読めるが、書き手は service role のみ。
       */
      notification_heartbeat: {
        Row: {
          id: number
          ran_at: string
          sent_count: number
          skipped_count: number
          failed_count: number
        }
        Insert: {
          id: number
          ran_at: string
          sent_count: number
          skipped_count: number
          failed_count: number
        }
        Update: {
          ran_at?: string
          sent_count?: number
          skipped_count?: number
          failed_count?: number
        }
        Relationships: []
      }
      /**
       * 要望・改善提案（20261025200001）。読めるのは**投稿者本人と運用者**だけ
       * （同じ世帯の家族にも開かぬ）。
       *
       * ⚠️ **書込は RPC のみ**（submit_feedback / operator_update_feedback /
       * operator_release_feedback / mark_feedback_seen）。authenticated には INSERT /
       * UPDATE / DELETE の GRANT もポリシーも無く、直接撃てば 42501 で落ちる。
       * ゆえに `Insert` / `Update` は空にしてある（push_subscriptions と同じ型）。
       *
       * ⚠️ `status = 'released'` は `released_commit_sha` と `released_verified_at` を
       * **必ず**伴う（DB の双方向 CHECK）。画面で「反映済み」と描くかは `releaseOf()` で決める。
       */
      feedback_items: {
        Row: {
          id: string
          submitter_id: string
          /** 投稿時に RPC が profiles から写した表示名（別世帯の運用者にも読める） */
          submitter_name: string
          client_request_id: string
          title: string
          body: string
          /** DB の CHECK が縛る 5 値。読むときは `parseFeedbackStatus` で未知値を退化させる */
          status: string
          version: number
          released_commit_sha: string | null
          released_note: string | null
          released_observed_deploy: string | null
          released_verified_at: string | null
          created_at: string
          updated_at: string
          last_operator_activity_at: string | null
          submitter_seen_at: string
          operator_seen_at: string | null
          /** 生成列: 投稿者に未読の更新があるか */
          submitter_has_unseen: boolean
        }
        Insert: Record<string, never>
        Update: Record<string, never>
        Relationships: []
      }
      /**
       * 要望の履歴（追記のみ）。
       *
       * ⚠️ **`actor_id` / `client_request_id` は Row に載せておらぬ。** 列 GRANT で
       * authenticated から隠してあり（投稿者に運用者の利用者 id を見せぬ）、
       * `select("*")` は 42501 で落ちる（pgTAP feedback_rls.sql の (11)）。列は必ず明示する。
       */
      feedback_events: {
        Row: {
          id: string
          feedback_id: string
          kind: string
          actor_role: string
          from_status: string | null
          to_status: string | null
          comment: string | null
          /** 「取り込み済み」の任意の記録。**本番反映ではない** */
          merge_ref: string | null
          release_commit_sha: string | null
          release_note: string | null
          release_observed_deploy: string | null
          release_verified_at: string | null
          created_at: string
        }
        Insert: Record<string, never>
        Update: Record<string, never>
        Relationships: []
      }
      /**
       * 要望の Push 配信キュー（受信者 × 端末）。
       *
       * ⚠️ **API ロールには deny-all**（RLS 有効・ポリシー 0 本・GRANT 無し）。読み書きは
       * 配信ジョブ（service role）だけ。運用者の画面は `get_feedback_push_summary` で数だけ見る。
       * `sent_at` は claim の印であって配達の証ではない。2xx の受理は `accepted_at`。
       */
      feedback_notifications: {
        Row: {
          id: string
          event_id: string
          recipient_id: string
          audience: string
          subscription_id: string | null
          subscription_key: string
          scheduled_at: string
          sent_at: string | null
          accepted_at: string | null
          skipped_at: string | null
          skip_reason: string | null
          created_at: string
        }
        Insert: Record<string, never>
        Update: {
          sent_at?: string | null
          accepted_at?: string | null
          skipped_at?: string | null
          skip_reason?: string | null
        }
        Relationships: []
      }
      /**
       * インスタンス運用者の名簿（20261002100002）。
       *
       * ⚠️ **service role だけが読める**（RLS 有効・ポリシー 0 本・anon / authenticated の
       * 権限を剥がしてある）。authenticated の経路は `is_app_operator()` RPC で真偽だけを得る。
       * ここに型を置くのは配信ジョブ（service role）が要望の知らせの宛先を確かめるためじゃ。
       */
      app_operators: {
        Row: {
          user_id: string
          created_at: string
        }
        Insert: Record<string, never>
        Update: Record<string, never>
        Relationships: []
      }
      /**
       * Google カレンダー接続（ユーザー単位・非機密）。
       * authenticated は SELECT と「本人の行の DELETE」だけができる。
       * **INSERT / UPDATE は RLS ポリシーも GRANT も無い = service role 専用**
       * （型は書けるように見えるが、authenticated から撃てば 42501 で落ちる）。
       */
      /**
       * Web Push の購読（端末単位）。
       *
       * ⚠️ **`endpoint` / `p256dh` / `auth` は Row に載せておらぬ。**
       * 列 GRANT で authenticated から隠してあり、`select("*")` は
       * `42501 permission denied` で落ちる（pgTAP B-6 が固定）。型に載せると
       * 「読める」と誤解した実装を誘発するため、意図的に省いてある。
       * 送信で必要になるのは配信ジョブ（B-3・service role）だけじゃ。
       *
       * 書込は `upsert_push_subscription()` のみ。ゆえに `Insert` / `Update` は
       * **空オブジェクト**にしてある（型の形としては三点必要だが、書ける列は無い）。
       * 直接 INSERT/UPDATE を書こうとすると型で止まり、pgTAP B-7/B-8 が実行時にも
       * `42501` で止める。
       */
      push_subscriptions: {
        Row: {
          id: string
          user_id: string
          /** 端末の見分け用の要約（`summarizeUserAgent` の出力）。取れねば null */
          user_agent: string | null
          created_at: string
          last_success_at: string | null
          last_failure_at: string | null
          failure_count: number
        }
        Insert: Record<string, never>
        Update: Record<string, never>
        Relationships: []
      }
      google_connections: {
        Row: {
          id: string
          household_id: string
          /** 接続した本人（profiles.id） */
          user_id: string
          /** Google の不変 ID（userinfo の sub）。取得には `openid email` スコープが要る */
          google_account_id: string
          google_email: string
          connection_status: GoogleConnectionStatus
          sync_status: GoogleSyncStatus
          last_error_kind: GoogleSyncErrorKind | null
          /** 同期完了シグナル（V7: Realtime を使わずこの列の前進をポーリングする） */
          last_synced_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          household_id: string
          user_id: string
          google_account_id: string
          google_email: string
          connection_status?: GoogleConnectionStatus
          sync_status?: GoogleSyncStatus
          last_error_kind?: GoogleSyncErrorKind | null
          last_synced_at?: string | null
        }
        Update: {
          google_email?: string
          connection_status?: GoogleConnectionStatus
          sync_status?: GoogleSyncStatus
          last_error_kind?: GoogleSyncErrorKind | null
          last_synced_at?: string | null
        }
        Relationships: []
      }
      /**
       * Google カレンダーの購読状態。
       *
       * ⚠ `sync_token` / `sync_lease_until` は**秘密**で、authenticated の列 GRANT の
       * 外にある。ゆえに authenticated クライアントからの `select("*")` は
       * **42501 で落ちる** — 列を明示して SELECT すること。これらの列に触れてよいのは
       * service role（同期エンジン）だけじゃ。
       * authenticated が UPDATE できるのは `is_selected` のみ（列 GRANT）。
       * INSERT / DELETE はポリシーも GRANT も無い = service role 専用。
       */
      google_calendar_subscriptions: {
        Row: {
          id: string
          connection_id: string
          household_id: string
          google_calendar_id: string
          /** Google のカレンダー表示名。NULL / 空なら google_calendar_id にフォールバックする */
          summary: string | null
          is_selected: boolean
          /** 秘密（service role 専用）。増分同期のトークン */
          sync_token: string | null
          /** 秘密（service role 専用）。二重同期防止のリース期限 */
          sync_lease_until: string | null
          last_synced_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          connection_id: string
          household_id: string
          google_calendar_id: string
          summary?: string | null
          is_selected?: boolean
          sync_token?: string | null
          sync_lease_until?: string | null
          last_synced_at?: string | null
        }
        Update: {
          summary?: string | null
          is_selected?: boolean
          sync_token?: string | null
          sync_lease_until?: string | null
          last_synced_at?: string | null
        }
        Relationships: []
      }
      /**
       * Google OAuth トークン（**機密・平文**）。
       * RLS 有効かつポリシー 0 本 = deny-all、GRANT も無い。読み書きできるのは
       * service role（BYPASSRLS）のみ。**ポリシーを足すな** — 1 本足せば同世帯の
       * 全員に平文の refresh token が開く。
       */
      google_tokens: {
        Row: {
          /** google_connections.id（1 接続 = 1 行。接続削除で CASCADE 消滅） */
          connection_id: string
          refresh_token: string
          access_token: string | null
          access_token_expires_at: string | null
          /** 実際に同意されたスコープ（calendar.readonly 欠落の検知用） */
          scope: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          connection_id: string
          refresh_token: string
          access_token?: string | null
          access_token_expires_at?: string | null
          scope?: string | null
        }
        Update: {
          refresh_token?: string
          access_token?: string | null
          access_token_expires_at?: string | null
          scope?: string | null
        }
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: {
      claim_news_ai_call: { Args: { p_day: string; p_limit: number }; Returns: boolean }
      news_source_statuses:{Args:Record<string,never>;Returns:Json}
      news_source_status:{Args:Record<string,never>;Returns:string|null}
      save_news_preferences:{Args:{p_region:string|null;p_enabled:boolean;p_version:string|null};Returns:Json}
      claim_news_source:{Args:{p_region:string;p_now:string};Returns:boolean}
      prepare_news_deliveries:{Args:{p_now:string};Returns:number}
      claim_news_delivery:{Args:{p_id:string;p_now:string};Returns:Json}
      // ── ごみ（予定の用途）ここから: supabase/migrations/20261111100001_event_purposes.sql ──
      // 世帯は auth.uid() から導出（引数で受けない）。正規メンバーでなければ 42501、入力不正は 22023。
      /**
       * 予定の分類と、その時に選んだ通知の扱いを書く。→ `{ status, purpose: 行 | null }`。
       * p_scope: "event" | "series" / p_action: "garbage" | "normal" | "clear" /
       * p_reminder: "prev_day_20" | "off" | "keep"。鍵（event_uid / シリーズの鍵）はサーバが引く。
       * `conflict` は「通常へ戻す」の元になるシリーズ既定が既に無い時、または画面が見ていた版
       * （p_seen_series / p_seen_event = event_purposes.updated_at。行が無ければ null）が今の版と違い、
       * 適用すると何かが変わる時（何も書いておらぬ）。
       */
      save_event_purpose: { Args: { p_event_id: string; p_scope: string; p_action: string; p_garbage_kind: string | null; p_reminder: string; p_seen_series: string | null; p_seen_event: string | null }; Returns: Json }
      /** 予定が見つからぬ分類の手動整理。→ `{ status }`（saved = 消した / replayed = 既に無い / conflict = 予定が在るので消さぬ）。 */
      delete_orphan_event_purpose: { Args: { p_id: string }; Returns: Json }
      /** 利用者が native の予定を削除した直後の掃除（予定が 1 つも無い鍵の行だけ消す）。→ 消した行数。 */
      cleanup_deleted_event_purposes: { Args: { p_event_ids: string[]; p_series_id: string | null }; Returns: number }
      // ── ごみ（予定の用途）ここまで ──
      // ── ごはん（献立・在庫・買い物）ここから: supabase/migrations/20261111100003_dinner_tables.sql ──
      // 全て jsonb を返す。保存系は { status: "saved" | "replayed" | "conflict", ... }。
      //   * 世帯は auth.uid() から導出（引数で受けない）。正規メンバーでなければ 42501、入力不正は 22023。
      //   * 版つきで送った行が既に無い（別端末が削除した・献立の作り直しで置き換わった）ときは
      //     { status: "conflict", <entity>: { id, deleted: true } }。行の列は載らないので、列を読む前に `deleted` を見ること。
      //   * delete_* は行が既に無ければ { status: "replayed", id }。
      /** → { status, settings }。p_staples は重複を除き昇順で保存。p_child_stages は { [childId]: 食事段階 }（世帯の子だけ）。 */
      save_dinner_settings: { Args: { p_version: string | null; p_servings: number; p_include_soup: boolean; p_max_cook_minutes: number | null; p_staples: string[]; p_child_stages: Json }; Returns: Json }
      /** → { status, item }。p_item: { ingredient_id, name, quantity, unit, status, use_soon, storage, expires_on, confirmed_on }（未知の鍵は 22023）。 */
      save_pantry_item: { Args: { p_id: string; p_version: string | null; p_item: Json }; Returns: Json }
      /** → { status, id } / 版違いは { status: "conflict", item }。 */
      delete_pantry_item: { Args: { p_id: string; p_version: string }; Returns: Json }
      /** まとめ入力（1〜50 件・1 トランザクション）。p_items: [{ id, ...p_item }]。→ { status, saved, replayed, items }。同じ id で内容が違えば 23505。 */
      add_pantry_items: { Args: { p_items: Json }; Returns: Json }
      /** → { status, exclusion }。別の id で同じ除外が既にあれば conflict（既存行を返す）。同じ id で内容を変えると 23505。世帯外の対象者は 42501。 */
      save_food_exclusion: { Args: { p_id: string; p_subject_kind: string; p_subject_profile_id: string | null; p_subject_child_id: string | null; p_reason: string; p_target_kind: string; p_target_id: string | null; p_custom_label: string | null }; Returns: Json }
      delete_food_exclusion: { Args: { p_id: string }; Returns: Json }
      /** → { status, preference }。personal の持ち主は常に呼び手。他人の personal 行は 42501。同じ対象が別の id で既にあれば conflict。 */
      save_food_preference: { Args: { p_id: string; p_version: string | null; p_scope: string; p_target_kind: string; p_target_id: string; p_sentiment: string }; Returns: Json }
      delete_food_preference: { Args: { p_id: string }; Returns: Json }
      /** → { status, feedback }。本人だけが書ける（他人の行は 42501）。食べた日は今日（JST）以前。料理・日付は作成後に変えられない。 */
      save_dish_feedback: { Args: { p_id: string; p_version: string | null; p_recipe_id: string | null; p_dish_title: string; p_eaten_on: string; p_taste: number | null; p_effort: number | null; p_again: boolean | null; p_exclude_from_learning: boolean }; Returns: Json }
      delete_dish_feedback: { Args: { p_id: string }; Returns: Json }
      /**
       * 範囲（最大 7 日）内の「固定でも調理済みでもない」枠を置き換える。→ { status, revision, entries, skipped }。
       * p_entries: [{ id, plan_date, role, position, recipe_id, recipe_version, custom_title, custom_ingredients, servings, pinned, status, origin }]。
       * 固定・調理済みの枠を指す要素は書かず `skipped`（{ id, kept_id, plan_date, role, position, reason }）で返す。
       * 版違いは conflict（最新の revision と範囲内の行）。同じ p_operation_id の再送は replayed、内容が違えば 23505。
       */
      apply_dinner_plan: { Args: { p_operation_id: string; p_expected_revision: number; p_range_start: string; p_range_end: string; p_entries: Json }; Returns: Json }
      /** 1 枠の作成・編集。→ { status, entry, revision }。p_entry は apply_dinner_plan の要素から id を除いた形。移動先の枠が埋まっていれば 23505。 */
      save_dinner_entry: { Args: { p_id: string; p_version: string | null; p_entry: Json }; Returns: Json }
      /** → { status, id, revision } / 版違いは { status: "conflict", entry, revision }。 */
      delete_dinner_entry: { Args: { p_id: string; p_version: string }; Returns: Json }
      /**
       * 提案（proposed）の枠を 1 トランザクションで確定にする。→ { status: "saved", revision, confirmed }。
       * p_entries: [{ id, version }]（1〜300 件 = 7 日 × 1 日の枠の上限を覆う）。献立の版が違う・枠が無い・枠の版が違う・提案でない枠が 1 つでも在れば、
       * 何も書かずに { status: "conflict", revision, detail: "stale_plan" | "gone" | "row_changed" }。成功で版は 1 回だけ進む。
       */
      confirm_dinner_entries: { Args: { p_expected_revision: number; p_entries: Json }; Returns: Json }
      /**
       * 自動項目を item_key で upsert（冪等）。→ { status, revision, synced, retained, removed, used }（conflict / replayed は { status, revision }）。
       * p_items: [{ item_key, ingredient_id, name, required_quantity, unit, required_note, needs_stock_check, sources }]（最大 200 件）。
       * sources の要素: { date, recipeId, title, quantity, entryId?, buy? }（entryId = 献立の枠、buy = その枠が買い物へ載せた正味量）。
       * 購入の事実・補充・メモ・売場の上書き・手動項目は保持する。新しい必要量から外れた出所のうち「作った」枠・確定のまま
       * 日が過ぎた枠は、充当の台帳（consumptions）へ 1 回だけ記録する（量 = min(buy, その時点で充てられる購入)）。
       * 取り消し・作らなかった・再び必要量に載った枠の記録は、その記録だけを外す（献立の変更で外れた分は記録しない）。
       * p_plan_revision が現在の献立の版と違えば conflict。
       */
      sync_grocery_auto_items: { Args: { p_operation_id: string; p_plan_revision: number; p_items: Json }; Returns: Json }
      /** → { status, item }。 */
      save_grocery_manual_item: { Args: { p_id: string; p_version: string | null; p_name: string; p_quantity: number | null; p_unit: string | null; p_section: string | null; p_note: string | null }; Returns: Json }
      /** 手動項目と still_needed=false の自動項目だけ消せる（必要な自動項目は 23514）。→ { status, id }。 */
      delete_grocery_item: { Args: { p_id: string; p_version: string }; Returns: Json }
      /**
       * p_purchased_quantity は購入の**事実の合計量**（0 で取り消し。充てられる量・残りを合計として送らない）。
       * 同じ内容の判定は (量の事実, purchased && !purchase_consumed)。書けば purchase_consumed は false。→ { status, item }。
       */
      set_grocery_purchase: { Args: { p_id: string; p_version: string; p_purchased_quantity: number; p_purchased: boolean }; Returns: Json }
      /** → { status, item }。 */
      update_grocery_item_meta: { Args: { p_id: string; p_version: string; p_note: string | null; p_section: string | null }; Returns: Json }
      /** 確認した量を新しい在庫行（id = p_pantry_item_id）として 1 度だけ反映。→ { status, item, pantry_item }。同じ p_pantry_item_id の再送は replayed。 */
      restock_pantry_from_grocery: { Args: { p_grocery_id: string; p_grocery_version: string; p_pantry_item_id: string; p_quantity: number | null }; Returns: Json }
      /** → { status: "ok", used, limit } | { status: "household_limit", used, limit } | { status: "provider_exhausted", resets_at }。p_limit は 1..10。 */
      claim_dinner_ai_call: { Args: { p_limit: number }; Returns: Json }
      /** 表示用（計上しない）。→ { used, provider_exhausted, resets_at }。 */
      dinner_ai_status: { Args: Record<string, never>; Returns: Json }
      /** service_role 専用。p_until は今より後・26 時間以内。 */
      mark_dinner_ai_exhausted: { Args: { p_until: string }; Returns: Json }
      // ── ごはん ここまで ──
      // ── 掃除（ルーティーンと履歴）ここから: supabase/migrations/20261111100002_cleaning_routines.sql ──
      // 世帯は auth.uid() から導出（引数で受けない）。正規メンバーでなければ 42501、入力不正は 22023。
      /** 定義の作成（p_version null）・編集・アーカイブ。→ `{ status, routine }`。同内容は版を見ずに replayed。 */
      save_cleaning_routine: { Args: { p_id: string; p_version: string | null; p_name: string; p_location: string | null; p_cadence_unit: string; p_cadence_interval: number; p_schedule_mode: string; p_anchor_date: string; p_archived: boolean }; Returns: Json }
      /** p_action: "pause" | "resume" | "postpone" | "clear_postpone"。p_occurrence / p_until は postpone の時だけ。→ `{ status, routine }`。 */
      set_cleaning_routine_state: { Args: { p_id: string; p_version: string | null; p_action: string; p_occurrence: string | null; p_until: string | null }; Returns: Json }
      /**
       * 完了（done）・スキップ（skip）・過去日の追記（done で p_occurrence が null）。
       * → `{ status: "saved" | "replayed" | "conflict" | "already_closed", log?, routine }`。
       * `already_closed` は同じ回を閉じる有効な履歴が既に在る時（行を作らず既存行を返す）。
       * 同じ p_id で内容が違えば 23505。p_done_on は今日（JST）以前。
       */
      record_cleaning_log: { Args: { p_id: string; p_routine_id: string; p_routine_version: string | null; p_kind: string; p_done_on: string | null; p_occurrence: string | null; p_note: string | null }; Returns: Json }
      /** 実施日・メモの訂正（閉じた回の鍵は変えぬ）。→ `{ status, log }`。 */
      update_cleaning_log: { Args: { p_id: string; p_version: string | null; p_done_on: string | null; p_note: string | null }; Returns: Json }
      /** 取り消し（行は残す）。→ `{ status, log }`。既に取り消し済みなら replayed。 */
      void_cleaning_log: { Args: { p_id: string; p_version: string | null }; Returns: Json }
      /** 有効な履歴の要約（SECURITY INVOKER = RLS が効く）。p_routine_id を省けば世帯の全項目。 */
      cleaning_log_marks: { Args: { p_routine_id?: string | null }; Returns: { routine_id: string; last_done_on: string | null; max_occurrence: string | null; max_skip_occurrence: string | null; last_skip_scheduled_on: string | null }[] }
      // ── 掃除 ここまで ──
      save_custom_field:{Args:{p_id:string;p_version:string|null;p_label:string;p_type:string;p_options:Json;p_archived:boolean};Returns:Json}
      save_custom_record:{Args:{p_id:string;p_child:string;p_version:string|null;p_field:string;p_value:Json;p_logged_at:string;p_memo:string|null;p_voided:boolean};Returns:Json}
      export_child_records:{Args:{p_child:string;p_from?:string|null;p_to?:string|null};Returns:Json}
      save_medical_record: { Args:{p_id:string;p_child:string;p_version:string|null;p_value:Json};Returns:Json }
      start_sleep: { Args: { p_id: string; p_child: string; p_start?: string | null; p_end?: string | null; p_memo?: string | null }; Returns: Json }
      stop_sleep: { Args: { p_id: string; p_child: string; p_version: string; p_stop_id: string; p_end?: string | null }; Returns: Json }
      edit_sleep: { Args: { p_id: string; p_child: string; p_version: string; p_start: string; p_end: string; p_memo?: string | null; p_voided?: boolean }; Returns: Json }

      create_child_share: { Args: { p_child_id: string; p_daily: boolean; p_diary: boolean; p_health: boolean; p_custom: boolean; p_until?: string | null }; Returns: Json }
      accept_child_share: { Args: { p_token: string }; Returns: string }
      revoke_child_share: { Args: { p_share_id: string }; Returns: boolean }
      list_child_shares: { Args: { p_owned?: boolean }; Returns: Json }
      shared_child_snapshot: { Args: { p_share_id: string }; Returns: Json }

      enqueue_feeding_delivery: {
        Args: { p_household_id: string; p_log_id: string; p_subscription_id: string; p_scheduled_at: string }
        Returns: string | null
      }
      claim_feeding_delivery: {
        Args: { p_delivery_id: string; p_logged_at: string; p_interval: number; p_lead: number; p_scheduled_at: string }
        Returns: boolean
      }
      /**
       * push 購読の**唯一の書込経路**（SECURITY DEFINER）。
       * `push_subscriptions` は authenticated に INSERT/UPDATE の GRANT も
       * ポリシーも持たぬため、クライアントからの登録は必ずこれを通る。
       */
      upsert_push_subscription: {
        Args: {
          p_endpoint: string
          p_p256dh: string
          p_auth: string
          p_user_agent?: string | null
        }
        Returns: string
      }
      /**
       * サインアウト時に自分の購読を endpoint 指定で解除する。
       * `DELETE ... WHERE endpoint = $1` は endpoint への SELECT 権限を要求し、
       * その列は GRANT から外してあるため RPC でしか消せぬ。
       */
      delete_my_push_subscription: {
        Args: { p_endpoint: string }
        Returns: boolean
      }
      /**
       * 設定カードの「解除」。id で自分の行を消し、それが**呼び出し元の
       * ブラウザの購読だったか**だけを返す（endpoint そのものは返さぬ —
       * 端末 A のブラウザへ端末 B の送信先を渡さぬため）。
       *
       * 戻り値は 3 値。BOOLEAN + NULL にすると「消えなかった」と
       * 「消えたが別端末」が呼び出し側の `if (data)` で畳まれる。
       */
      delete_my_push_subscription_by_id: {
        Args: { p_id: string; p_endpoint?: string | null }
        Returns: "not-found" | "deleted-this-device" | "deleted-other-device"
      }
      get_my_household_id: {
        Args: Record<string, never>
        Returns: string
      }
      get_invitation_by_token: {
        Args: { invite_token: string }
        Returns: {
          id: string
          household_id: string
          household_name: string
          role: HouseholdRole
          status: InviteStatus
          expires_at: string
        }[]
      }
      accept_invitation: {
        Args: { invitation_uuid: string }
        Returns: void
      }
      /**
       * 呼び手がインスタンス運用者（`app_operators`）か。サインアップの承認は
       * 運用者の権能で、世帯 owner の権能ではない（20261002100002）。
       * 承認カードを出すかはこれで決める（owner であることでは決めぬ）。
       */
      is_app_operator: {
        Args: Record<string, never>
        Returns: boolean
      }
      /** 運用者にだけ承認待ちを返す（他は空集合）。 */
      get_pending_approvals: {
        Args: Record<string, never>
        Returns: {
          id: string
          display_name: string
          email: string
          created_at: string
        }[]
      }
      approve_user: {
        Args: { target_user_id: string }
        Returns: void
      }
      create_household: {
        Args: { p_name: string }
        Returns: string
      }
      /**
       * 要望の投稿（冪等）。`created=false` は同じ鍵の要望が既に在った（再送）。
       * 同じ鍵で別の内容なら IRF01、24 時間で 21 件目は IRF02。
       */
      submit_feedback: {
        Args: { p_client_request_id: string; p_title: string; p_body: string }
        Returns: { feedback_id: string; created: boolean }[]
      }
      /** 運用者の状態変更・返信（released 以外）。版が合わねば IRF03。 */
      operator_update_feedback: {
        Args: {
          p_feedback_id: string
          p_client_request_id: string
          p_expected_version: number
          p_status: string | null
          p_comment: string | null
          p_merge_ref: string | null
        }
        Returns: { version: number; created: boolean }[]
      }
      /** 「本番で反映を確かめた」の確定。`p_production_verified` が true でなければ拒む。 */
      operator_release_feedback: {
        Args: {
          p_feedback_id: string
          p_client_request_id: string
          p_expected_version: number
          p_commit_sha: string
          p_release_note: string | null
          p_observed_deploy: string | null
          p_production_verified: boolean
          p_comment: string | null
        }
        Returns: { version: number; created: boolean }[]
      }
      mark_feedback_seen: {
        Args: { p_feedback_id: string }
        Returns: void
      }
      /** 運用者だけ。知らせの配信状況を「数だけ」返す（端末の識別子は返さぬ）。 */
      get_feedback_push_summary: {
        Args: { p_feedback_id: string }
        Returns: {
          event_id: string
          queued: number
          accepted: number
          unconfirmed: number
          gone: number
          expired: number
          revoked: number
          superseded: number
        }[]
      }
    }
    Enums: {
      household_role: HouseholdRole
      invite_status: InviteStatus
      baby_log_type: BabyLogType
      feeding_type: FeedingType
      diaper_type: DiaperType
    }
  }
}
