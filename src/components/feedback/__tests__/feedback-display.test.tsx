/**
 * 状態の印と履歴の表示 — 「反映済み」を推測で描かぬ・マージを反映と読ませぬ・
 * 色だけで示さぬ。
 */

import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { FeedbackStatusBadge } from "../feedback-status-badge"
import { FeedbackTimeline } from "../feedback-timeline"
import type { FeedbackTimelineEntry } from "@/lib/domain/feedback-view"
import { FEEDBACK_PUSH_NONE } from "@/lib/domain/feedback"

afterEach(cleanup)

describe("FeedbackStatusBadge", () => {
  it("証拠付きの released だけを「反映済み」（主色の塗り）で描く", () => {
    render(<FeedbackStatusBadge status="released" released />)
    const badge = screen.getByText("反映済み")
    expect(badge.className).toContain("bg-primary text-primary-foreground")
  })

  it("released でも証拠が無ければ中立の「状態を確認中」へ倒す", () => {
    render(<FeedbackStatusBadge status="released" released={false} />)
    expect(screen.queryByText("反映済み")).toBeNull()
    expect(screen.getByText("状態を確認中")).toBeInTheDocument()
  })

  it("未知の状態も中立に倒す", () => {
    render(<FeedbackStatusBadge status={null} released={false} />)
    expect(screen.getByText("状態を確認中")).toBeInTheDocument()
  })

  it("文字を載せる帯に bg-primary/10 text-primary（4.15:1）を使わぬ", () => {
    for (const status of ["received", "considering", "in_progress", "declined"] as const) {
      cleanup()
      render(<FeedbackStatusBadge status={status} released={false} />)
      const badge = screen.getByText(/受付|検討中|対応中|見送り/)
      expect(badge.className).not.toMatch(/bg-primary\/10/)
      expect(badge.className).toContain("text-foreground")
      // アイコンも添える（色だけで示さぬ）
      expect(badge.querySelector("svg")).not.toBeNull()
    }
  })
})

const entry = (over: Partial<FeedbackTimelineEntry>): FeedbackTimelineEntry => ({
  id: "e",
  kind: "status_changed",
  toStatus: "in_progress",
  comment: null,
  mergeRef: null,
  release: null,
  atLabel: "10/25 21:00",
  ...over,
})

describe("FeedbackTimeline", () => {
  it("マージの記録は「本番への反映はまだです」と言い切る", () => {
    render(<FeedbackTimeline entries={[entry({ mergeRef: "PR #241" })]} />)
    expect(screen.getByText(/本番への反映はまだです/)).toHaveTextContent("PR #241")
    expect(screen.queryByText("本番への反映を確かめました")).toBeNull()
  })

  it("証拠付きの released だけが「反映を確かめました」を名乗る", () => {
    render(
      <FeedbackTimeline
        entries={[
          entry({
            id: "a",
            toStatus: "released",
            release: { commitSha: "abcdef1234567890", note: "v1.7.0", verifiedLabel: "10/25 22:00" },
          }),
          entry({ id: "b", toStatus: "released", release: null }),
        ]}
      />,
    )
    expect(screen.getAllByText("本番への反映を確かめました")).toHaveLength(1)
    expect(screen.getByText("状態が更新されました")).toBeInTheDocument()
    expect(screen.getByText("abcdef123456")).toBeInTheDocument()
    expect(screen.getByText("v1.7.0")).toBeInTheDocument()
  })

  it("返信は改行を保って出す", () => {
    render(<FeedbackTimeline entries={[entry({ kind: "commented", toStatus: null, comment: "一行目\n二行目" })]} />)
    const comment = screen.getByText(/一行目/)
    expect(comment.className).toContain("whitespace-pre-wrap")
  })

  it("知らせの状況は渡された時だけ出す（投稿者の画面には出さぬ）", () => {
    const { rerender } = render(<FeedbackTimeline entries={[entry({})]} />)
    expect(screen.queryByText(/Push/)).toBeNull()
    rerender(<FeedbackTimeline entries={[entry({ pushLabel: FEEDBACK_PUSH_NONE })]} />)
    expect(screen.getByText(FEEDBACK_PUSH_NONE)).toBeInTheDocument()
  })
})
