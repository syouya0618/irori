import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

/**
 * 育児ホームで毎回開かない大きな編集フォームを同期importへ戻さない。
 * 計測を開始した後は閉じてもタイマーをunmountしない（下書き保存不可の場合の保持）。
 */
describe("育児ホームの初期JS / 計測保全", () => {
  const source = readFileSync(path.resolve(__dirname, "../baby-dashboard.tsx"), "utf8")

  it("記録・日記・授乳タイマーは初回同期importを避ける", () => {
    for (const file of ["baby-log-form-sheet", "baby-diary-edit-sheet", "feeding-timer"]) {
      expect(source).toContain(`import("./${file}")`)
      expect(source).not.toMatch(new RegExp(`^import\\s+(?!type\\b)[^\\n]+from ["']\\./${file}["']`, "m"))
    }
    expect(source).toContain('import { isDiaryDraftContent } from "@/lib/domain/diary-draft-content"')
  })

  it("初回は無用なシートを作らず、開いた後は送信中やタイマーの状態を保持する", () => {
    expect(source).toMatch(/\(diaryEditOpen \|\| diaryKey > 0\) && <BabyDiaryEditSheet/)
    expect(source).toMatch(/\(sheetOpen \|\| formKey > 0\) && <BabyLogFormSheet/)
    expect(source).toMatch(/\(timerOpen \|\| timerEverOpened\) && <FeedingTimer/)
    expect(source).toContain("setTimerEverOpened(true)")
    expect(source).toContain("shouldResyncBabyOnMount(")
  })
})
