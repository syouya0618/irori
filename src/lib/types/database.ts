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
