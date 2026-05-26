@AGENTS.md

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
- **`cookies()` + `NextResponse.redirect()` で Cookie 未伝播**: `createServerClient` でレスポンスに直接書き込む

### Next.js / Supabase 共通

- **`"use server"` ファイルからの非関数 export でビルド破壊**: 定数・型は共有モジュールに配置
- **React 19 `<form action={fn}>` は auto-reset**: `onReset={(e) => e.preventDefault()}` で無効化
- **`overflow-hidden` は `position: sticky` を破壊**: `overflow-clip` を使用
- **`.update()` は 0 行更新でも `error: null`**: `.select("id").single()` で行数検証
- **Server Action 副次 DB 操作のエラー握り潰し禁止**: 各クエリの `.error` を個別検証
- **react-hook-form `watch()` + React Compiler 非互換**: `useWatch()` or `getValues()` に移行
- **`router.back()` は履歴なしで無動作**: 明示的な遷移先を指定
