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

export interface Database {
  public: {
    Tables: {
      households: {
        Row: {
          id: string
          name: string
          created_at: string
        }
        Insert: {
          id?: string
          name?: string
          created_at?: string
        }
        Update: {
          id?: string
          name?: string
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
    }
    Enums: {
      meal_type: MealType
      meal_reaction: MealReaction
      store_type: StoreType
      item_category: ItemCategory
      household_role: HouseholdRole
      invite_status: InviteStatus
    }
  }
}
