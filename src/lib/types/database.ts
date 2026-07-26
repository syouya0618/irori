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
          pumping_interval_min: number
          created_at: string
        }
        Insert: {
          id?: string
          name?: string
          auto_stock_categories?: Json
          baby_name?: string | null
          baby_birth_date?: string | null
          pumping_interval_min?: number
          created_at?: string
        }
        Update: {
          id?: string
          name?: string
          auto_stock_categories?: Json
          baby_name?: string | null
          baby_birth_date?: string | null
          pumping_interval_min?: number
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
          diaper_type: DiaperType | null
          ended_at: string | null
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
          diaper_type?: DiaperType | null
          ended_at?: string | null
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
          diaper_type?: DiaperType | null
          ended_at?: string | null
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
    }
    Views: Record<string, never>
    Functions: {
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
