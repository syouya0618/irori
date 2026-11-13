import type { ReactNode } from "react"

import { MealsNav, MealsSettingsLink } from "@/components/chores/meals/shared/meals-nav"
import { ChoresHeader } from "@/components/chores/shared/chores-header"

/**
 * ごはん（/chores/meals とその下位）の殻。見出し「ごはん」・下位 5 画面の切替・設定への入口を持つ。
 *
 * - **ここではデータを読まない**（認証も読まない）。layout が cookies などを読むと、Cache Components
 *   無効の現構成では layout の描画が終わるまで遷移が止まり、`loading.tsx` が出ない
 *   （`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md`）。
 *   認証・承認・世帯は (main)/layout が遷移で受け、各 page / Server Action が自分で
 *   `getAuthContext()` を呼ぶ。
 * - 外枠の余白（`px-4 pt-12 pb-8`）と h1 はこの殻が持つ。**下位の page は外枠の余白と h1 を
 *   持たず**、区画（h2 から）だけを返す。
 * - 同じ階層の `error.tsx` と `loading.tsx` はこの殻の内側に出る（切替は残る）。
 */
export default function MealsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 px-4 pt-12 pb-8">
      <div className="relative">
        <ChoresHeader title="ごはん" />
        <MealsSettingsLink className="absolute top-0 right-0" />
      </div>
      <MealsNav />
      {children}
    </div>
  )
}
