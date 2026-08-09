export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type MealType = "breakfast" | "lunch" | "dinner" | "snack"
export type MealReaction = "good" | "ok" | "bad"
export type StoreType =
  | "supermarket"
  | "drugstore"
  | "convenience"
  | "online"
  | "other"
export type ItemCategory =
  | "vegetable"
  | "fruit"
  | "meat"
  | "fish"
  | "dairy"
  | "egg"
  | "grain"
  | "seasoning"
  | "frozen"
  | "snack_food"
  | "other_food"
  | "baby"
  | "cleaning"
  | "hygiene"
  | "other_daily"
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
      households: {
        Row: {
          id: string
          name: string
          auto_stock_categories: Json
          baby_name: string | null
          baby_birth_date: string | null
          feeding_interval_min: number
          created_at: string
        }
        Insert: {
          id?: string
          name?: string
          auto_stock_categories?: Json
          baby_name?: string | null
          baby_birth_date?: string | null
          feeding_interval_min?: number
          created_at?: string
        }
        Update: {
          id?: string
          name?: string
          auto_stock_categories?: Json
          baby_name?: string | null
          baby_birth_date?: string | null
          feeding_interval_min?: number
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
      meals: {
        Row: {
          id: string
          household_id: string
          date: string
          meal_type: MealType
          title: string
          is_eating_out: boolean
          template_id: string | null
          created_by: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          household_id: string
          date: string
          meal_type: MealType
          title: string
          is_eating_out?: boolean
          template_id?: string | null
          created_by: string
        }
        Update: {
          date?: string
          meal_type?: MealType
          title?: string
          is_eating_out?: boolean
          template_id?: string | null
        }
        Relationships: []
      }
      meal_reactions: {
        Row: {
          id: string
          meal_id: string
          user_id: string
          reaction: MealReaction
          created_at: string
        }
        Insert: {
          id?: string
          meal_id: string
          user_id: string
          reaction: MealReaction
        }
        Update: {
          reaction?: MealReaction
        }
        Relationships: []
      }
      meal_ingredients: {
        Row: {
          id: string
          meal_id: string
          name: string
          quantity: string | null
          category: ItemCategory
          created_at: string
        }
        Insert: {
          id?: string
          meal_id: string
          name: string
          quantity?: string | null
          category?: ItemCategory
        }
        Update: {
          name?: string
          quantity?: string | null
          category?: ItemCategory
        }
        Relationships: []
      }
      meal_templates: {
        Row: {
          id: string
          household_id: string
          title: string
          description: string | null
          ingredients: Json
          created_by: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          household_id: string
          title: string
          description?: string | null
          ingredients?: Json
          created_by: string
        }
        Update: {
          title?: string
          description?: string | null
          ingredients?: Json
        }
        Relationships: []
      }
      shopping_items: {
        Row: {
          id: string
          household_id: string
          name: string
          quantity: string | null
          category: ItemCategory
          store_type: StoreType
          is_checked: boolean
          checked_by: string | null
          checked_at: string | null
          meal_id: string | null
          sort_order: number
          created_by: string
          created_at: string
        }
        Insert: {
          id?: string
          household_id: string
          name: string
          quantity?: string | null
          category?: ItemCategory
          store_type?: StoreType
          is_checked?: boolean
          checked_by?: string | null
          checked_at?: string | null
          meal_id?: string | null
          sort_order?: number
          created_by: string
        }
        Update: {
          name?: string
          quantity?: string | null
          category?: ItemCategory
          store_type?: StoreType
          is_checked?: boolean
          checked_by?: string | null
          checked_at?: string | null
          sort_order?: number
        }
        Relationships: []
      }
      eating_out_logs: {
        Row: {
          id: string
          meal_id: string
          restaurant_name: string | null
          place_id: string | null
          photo_url: string | null
          memo: string | null
          rating: number | null
          created_at: string
        }
        Insert: {
          id?: string
          meal_id: string
          restaurant_name?: string | null
          place_id?: string | null
          photo_url?: string | null
          memo?: string | null
          rating?: number | null
        }
        Update: {
          restaurant_name?: string | null
          place_id?: string | null
          photo_url?: string | null
          memo?: string | null
          rating?: number | null
        }
        Relationships: []
      }
      stock_items: {
        Row: {
          id: string
          household_id: string
          name: string
          category: ItemCategory
          quantity: number
          unit: string | null
          expires_at: string | null
          created_by: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          household_id: string
          name: string
          category?: ItemCategory
          quantity?: number
          unit?: string | null
          expires_at?: string | null
          created_by: string
        }
        Update: {
          name?: string
          category?: ItemCategory
          quantity?: number
          unit?: string | null
          expires_at?: string | null
        }
        Relationships: []
      }
      purchase_history: {
        Row: {
          id: string
          household_id: string
          item_name: string
          category: ItemCategory | null
          store_type: StoreType | null
          purchased_at: string
        }
        Insert: {
          id?: string
          household_id: string
          item_name: string
          category?: ItemCategory | null
          store_type?: StoreType | null
          purchased_at?: string
        }
        Update: {
          item_name?: string
          category?: ItemCategory | null
          store_type?: StoreType | null
        }
        Relationships: []
      }
      baby_logs: {
        Row: {
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
          diaper_type: DiaperType | null
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
          diaper_type?: DiaperType | null
          temperature?: number | null
          weight_g?: number | null
          height_cm?: number | null
          duration_min?: number | null
          duration_sec?: number | null
          memo?: string | null
        }
        Update: {
          log_type?: BabyLogType
          logged_at?: string
          feeding_type?: FeedingType | null
          amount_ml?: number | null
          breast_left_count?: number | null
          breast_right_count?: number | null
          breast_left_sec?: number | null
          breast_right_sec?: number | null
          diaper_type?: DiaperType | null
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
          id?: string
          household_id: string
          diary_date: string
          content: string
          updated_by?: string | null
        }
        Update: {
          content?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      calendar_events: {
        Row: {
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
          created_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
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
      update_meal_with_ingredients: {
        Args: {
          p_meal_id: string
          p_date: string
          p_meal_type: MealType
          p_title: string
          p_is_eating_out: boolean
          p_ingredients: Json
        }
        Returns: void
      }
    }
    Enums: {
      meal_type: MealType
      meal_reaction: MealReaction
      store_type: StoreType
      item_category: ItemCategory
      household_role: HouseholdRole
      invite_status: InviteStatus
      baby_log_type: BabyLogType
      feeding_type: FeedingType
      diaper_type: DiaperType
    }
  }
}
