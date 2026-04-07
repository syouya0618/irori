@AGENTS.md

## Tech Stack

- **Framework**: Next.js 16.2.2 (App Router)
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
