import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { DinnerRequest } from "@/lib/meals/server/plan-requests"
import type { DinnerDayView, DinnerEntryView } from "@/lib/meals/server/plan-views"

const { suggestMealRole } = vi.hoisted(() => ({ suggestMealRole: vi.fn() }))
vi.mock("@/app/(main)/chores/meals/suggestions/actions", () => ({ suggestMealRole }))

import { RoleSuggestionPanel } from "../role-suggestion-panel"

const DATE = "2026-11-20"
const STAPLE_MAIN: DinnerEntryView = {
  id: "a1000000-0000-4000-8000-000000000001",
  version: "2026-11-20T09:00:00+00:00",
  date: DATE,
  role: "main",
  roleLabel: "主菜",
  position: 0,
  title: "カレーライス",
  recipeId: "curry_rice",
  isCustom: false,
  minutes: 30,
  includesStaple: true,
  servings: 3,
  pinned: true,
  status: "confirmed",
  statusLabel: "確定",
  origin: "manual",
  originLabel: "手動",
  stock: null,
  conflict: null,
  groceryUncomputed: false,
}
function day(entries: DinnerEntryView[] = []): DinnerDayView {
  return { date: DATE, label: "今日 11/20（金）", isToday: true, isPast: false, entries, missingRoles: [] }
}

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe("曜日詳細の任意提案", () => {
  it("空の日は4種類、主食を含む主菜がある日は主食を提案しない", () => {
    const component = render(<RoleSuggestionPanel day={day()} revision={1} servings={3} disabled={false} onAdd={vi.fn()} />)
    for (const name of ["主菜", "副菜", "主食", "汁物"]) {
      expect(screen.getByRole("button", { name: name + "を提案" })).toBeEnabled()
    }
    component.rerender(<RoleSuggestionPanel day={day([STAPLE_MAIN])} revision={1} servings={3} disabled={false} onAdd={vi.fn()} />)
    expect(screen.queryByRole("button", { name: "主食を提案" })).toBeNull()
    expect(screen.queryByRole("button", { name: "主菜を提案" })).toBeNull()
    expect(screen.getByRole("button", { name: "副菜を提案" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "汁物を提案" })).toBeEnabled()
  })

  it("候補を見るだけでは採用せず、押した1品だけを版つきで追加する", async () => {
    suggestMealRole.mockResolvedValue({
      ok: true, date: DATE, role: "side", revision: 7,
      choices: [{
        recipeId: "spinach_ohitashi", title: "ほうれん草のおひたし",
        role: "side", minutes: 10, stock: "check", missingNames: [], checkNames: ["ほうれん草"],
      }],
    })
    const onAdd = vi.fn((_request: DinnerRequest) => true)
    render(<RoleSuggestionPanel day={day([STAPLE_MAIN])} revision={7} servings={3} disabled={false} onAdd={onAdd} />)
    fireEvent.click(screen.getByRole("button", { name: "副菜を提案" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "ほうれん草のおひたしを献立へ追加" })).toBeEnabled())
    expect(suggestMealRole).toHaveBeenCalledWith({ date: DATE, role: "side", expectedRevision: 7 })
    expect(onAdd).not.toHaveBeenCalled()
    expect(screen.getByText("分量の確認が必要")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "ほうれん草のおひたしを献立へ追加" }))
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onAdd.mock.calls[0][0]).toMatchObject({
      op: "add_recipe", date: DATE, recipeId: "spinach_ohitashi",
      role: "side", expectedRevision: 7, servings: 3,
      position: 1, status: "confirmed", onlyIfRoleMissing: true,
    })
    const adopted = onAdd.mock.calls[0][0]
    expect(adopted.op).toBe("add_recipe")
    if (adopted.op !== "add_recipe") throw new Error("unexpected operation")
    expect(adopted.id).toMatch(/^[0-9a-f-]{36}$/)
  })
})
