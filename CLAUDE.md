@AGENTS.md

## Advisor へ（本質の番人・二人称）

Advisor、あなたへ。これは世帯単位の献立・買い物 PWA で、要は Liquid Glass の一貫した手触り、世帯データの分離、そして「訓練データの記憶で Next.js を書かない」ことだ。全履歴を読み、**通常のレビューに加えて**、判断を特に次の3軸で重く点検せよ:

1. **Liquid Glass デザインの一貫性を崩していないか** ― `glass` カード/warm orange/`transition-colors` のみ/44px タッチ/絵文字は meal reaction のみ。独自スタイルや `transition-all` を持ち込んでいれば、止めよ。
2. **世帯（household）単位のデータ分離を破っていないか** ― RLS は SELECT/UPDATE/DELETE 分離（FOR ALL 禁止）、SECURITY DEFINER は `SET search_path=public`、在庫の重複使用防止。分離を緩めていれば、止めよ。
3. **現行 Next.js 16 / React 19 の実APIに忠実か** ― 記憶で書かず `node_modules/next/dist/docs/` を読んだか（`unstable_retry`、form auto-reset 無効化 等）。記憶ベースの古いAPIで書いていれば、止めよ。

衝突したら本質を優先せよ。指摘は短く。**3軸に該当せずとも本質を損なう判断を見れば遠慮なく指摘せよ。**

## Tech Stack

- **Framework**: Next.js 16.2.6 (App Router)
- **React**: 19.2
- **Tailwind CSS**: v4.2
- **UI**: shadcn/ui + Liquid Glass design system
- **Backend**: Supabase (Auth, Database, Storage, Realtime)
- **PWA**: Native PWA via `manifest.ts` (Phase 1)
- **Icons**: Lucide React
- **Language**: All UI text in Japanese

## Design System

Liquid Glass design system. See `docs/DESIGN_SYSTEM.md` for full details.

Key rules:
- Glass cards: CSS class `glass` + `rounded-2xl shadow-lg shadow-black/[0.04]`
- Primary: warm orange `oklch(0.65 0.19 50)`
- Transitions: `transition-colors duration-200` ONLY (never `transition-all`)
- Touch targets: min 44px
- Icons: Lucide React (no emoji except meal reactions)

## Project Structure

```
src/
  app/
    (auth)/       # Login, callback, invite
    (main)/       # Authenticated pages (meals, shopping, settings)
    setup/        # Household setup
  components/
    common/       # BottomNav etc.
    meals/        # Meal-related components
    shopping/     # Shopping-related components
    ui/           # shadcn/ui primitives
  lib/
    supabase/     # Client & server Supabase instances
    types/        # Database types
    hooks/        # Custom hooks
    utils/        # Utility functions
```

## Conventions

- Error boundaries use `unstable_retry` (Next.js 16 API, not `reset`)
- Server Actions in co-located `actions.ts` files
- All Supabase RLS: separate SELECT/UPDATE/DELETE policies (never FOR ALL)
- Feature branches only (never commit to main directly)

## irori 完了前チェックリスト（グローバルチェックリストに追加）

9. Supabase 操作に `createServerClient` / service role を適切に使用しているか
10. `new Date('YYYY-MM-DD')` を使っていないか（UTC 罠）
11. `useEffect` 内の fetch に `AbortController` があるか
12. `resetForm()` で全 `useState`（saving/loading 含む）をリセットしているか

## 既知の罠（Gotchas）

### irori 固有

- **レシピマッチングで同一在庫アイテムの重複使用を防ぐ**: `usedStockIds: Set<string>` で追跡し、マッチング時に除外
- **pdfmake v0.3.7: `setFonts()` はモジュールスコープで1回のみ**: リクエストごとに呼ぶと並行リクエストで競合リスク
- **SECURITY DEFINER 関数には `SET search_path = public` 必須**: `auth.users` トリガーから呼ばれると `search_path=auth` で狂う
- **`ALTER TYPE ADD VALUE` と CHECK 制約は別マイグレーションに分離**: 同一トランザクション内で新 ENUM 値を CHECK 制約で参照すると `unsafe use of new value` エラー
- **授乳行（log_type='feeding'）の `logged_at` は「開始時刻」セマンティクス**: タイマー（startedAt 送信）・手動入力（記録時刻 − 授乳時間）・編集シート（ラベル「開始時刻」）の全書込経路で開始に揃える契約。過去行は backfill（`20260726100003`）で統一済み。**Flutter は未追随**（タイマーが logged_at を送らず DB now() = 終了時刻で書く）ゆえ、**Flutter を実機で再稼働させる前に追随が必須** — 怠ると同じ列に2つの意味が無音で混在し、事後判別できない
- **母乳サイクル行（feeding_type='breast'）の counts は双方向厳格 CHECK で守られている**: `breast_left_count`/`breast_right_count` は breast 行のみ非NULL・各0..20・合計≥1（`chk_breast_counts_only_breast`/`chk_breast_counts_required`）。ゆえに **feeding_type だけを部分 update するクライアント（Flutter の `updateFeeding` 等）は breast 行を編集できない = 意図的な fail-loud**。緩めると「ミルクなのに左右回数を持つ」無音破損が DB に居座るため、CHECK を緩める方向の修正は禁止。サーバ Action（`validateBreastCounts`）と UI（0..20 clamp）は同じ契約のミラー
- **左右別授乳時間（`breast_left_sec`/`breast_right_sec`）は「duration_sec = 左+右」の等式 CHECK 付き**（`chk_breast_side_sec_total`・`IS NOT DISTINCT FROM` で NULL 穴なし）: 合計は常にサーバが左右の和から導出する（クライアントの合計送信は拒否 = 二重真値源の禁止）。ゆえに **合計側を clamp する実装は禁止** — 走行中タイマーは 3h 超に到達しうるため、上限処理は `resolveBreastSideSeconds` が**側ごとに比例縮小**して和の等式を守る（合計 clamp に戻すと等式違反で記録が恒久失敗する）。sides NULL の行（#165 期の旧サイクル行・旧形式 localStorage から復元したタイマー）は「合計のみ持つ行」として合法・退化表示。左右配分の backfill は原理的に不可能ゆえ捏造しない
- **Flutter の DB ENUM 由来 nullable フィールドは未知値で throw させない（enum drift 防御）**: DB の ENUM（`feeding_type`/`diaper_type` 等）は Flutter デプロイと独立に値が増えうる。未追随の間、`json_serializable` の `$enumDecodeNullable` や手書き decode が未知値で `ArgumentError` を投げ、`fromJson` を await する fetch がダッシュボード全体を `AsyncError` に倒す（#147/#158）。**対処**: nullable enum は `@JsonKey(unknownEnumValue: JsonKey.nullForUndefinedEnumValue)`（生成コード）＋手書き経路は「未知→null」で退化。sentinel enum 追加は全 exhaustive switch の網羅漏れで再クラッシュするため避ける。判別子（`log_type`）は required ゆえ厳格 throw 維持。既存 `ItemCategory.fromDbValue`（未知→`otherDaily`）と同流儀
- **`cookies()` + `NextResponse.redirect()` で Cookie 未伝播**: `createServerClient` でレスポンスに直接書き込む
- **`src/proxy.ts` の matcher は `/api/` を除外していない → cron route を作れば必ず認証リダイレクトに食われる（地雷は現存・2026-07-26 に実機確認）**: matcher は静的アセットのみ除外し、`isPublicRoute` は `/login` と `/auth/callback` だけ。Vercel Cron は **cookie を持たない GET** ゆえ `/api/cron/*` は未認証と判定され `/login` へ 307 され、**ハンドラに到達しない**。既存の `/api/baby-report`・`/api/receipt-ocr` はブラウザから cookie 付きで呼ばれるため無事だが、**cron route は現時点で未実装**（`find src/app -path "*cron*"` = 0 件、`CRON_SECRET` も未使用）＝ Phase D（Google カレンダー同期）で追加する瞬間に踏む。**対処は不可分の1 PR**: ①matcher で `/api/cron/` を除外 ②ハンドラ側で fail-closed の `CRON_SECRET` 検証（片方だけ入れると cron が無認証で開く）。**検証は Route Handler の直接 import では proxy を通らず「テスト緑・本番100%不発」になる**ため、dev サーバへ `fetch(url, { redirect: "manual" })` して 307 が返らないことを assert せよ。詳細: `docs/plans/verification-record.md` の V8

### Next.js / Supabase 共通

Next.js/Supabase 汎用の罠は `~/.claude/rules/nextjs-supabase.md`（user-level rules）に一元化。該当ファイル編集時に自動適用される。
