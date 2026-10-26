import { describe, it, expect } from "vitest"
import {
  COMMIT_SHA_RE,
  FEEDBACK_PUSH_NONE,
  FEEDBACK_STATUSES,
  FEEDBACK_STATUS_DESCRIPTIONS,
  OPERATOR_SETTABLE_STATUSES,
  checkFeedbackText,
  commitShaMatches,
  countCodePoints,
  describeFeedbackPush,
  feedbackStatusLabel,
  formatFeedbackDateTime,
  isOperatorSettableStatus,
  normalizeCommitSha,
  normalizeFeedbackText,
  observedDeployFromEnv,
  isNonProductionDeploy,
  isProductionObservedDeploy,
  parseFeedbackStatus,
  releaseOf,
} from "../feedback"

/**
 * 要望の中立モジュールの契約。ここの述語は DB（20261025200001 の feedback_text_ok・CHECK）の
 * **写し**ゆえ、境界は pgTAP `feedback_lifecycle.sql` の (13)-(17) と同じ点を撃つ。
 */

const TITLE = { max: 100, multiline: false, required: true }
const BODY = { max: 2000, multiline: true, required: false }

describe("normalizeFeedbackText — DB の btrim と同じ集合だけを落とす", () => {
  it("CRLF / CR を LF に揃え、前後の空白・改行・全角空白を落とす", () => {
    const ideographicSpace = String.fromCodePoint(0x3000)
    expect(normalizeFeedbackText(`${ideographicSpace} 題名\r\n本文\r続き \t\n`)).toBe("題名\n本文\n続き")
  })
  it("NBSP は落とさぬ（DB の btrim も落とさぬ。trim() に替えると集合がずれる）", () => {
    const nbsp = String.fromCodePoint(0xa0)
    expect(normalizeFeedbackText(`${nbsp}題名`)).toBe(`${nbsp}題名`)
  })
})

describe("checkFeedbackText — 長さはコードポイント・制御文字と双方向制御文字は拒む", () => {
  it("題は必須", () => {
    expect(checkFeedbackText("", TITLE)).toBe("required")
  })
  it("本文は空を許す", () => {
    expect(checkFeedbackText("", BODY)).toBeNull()
  })
  it("100 文字は通り、101 文字は拒む（境界の対照）", () => {
    expect(checkFeedbackText("あ".repeat(100), TITLE)).toBeNull()
    expect(checkFeedbackText("あ".repeat(101), TITLE)).toBe("too_long")
  })
  it("サロゲートペアの絵文字は 1 文字と数える（DB の char_length と揃える）", () => {
    const emoji = String.fromCodePoint(0x1f600)
    expect(emoji.length).toBe(2)
    expect(countCodePoints(emoji.repeat(100))).toBe(100)
    expect(checkFeedbackText(emoji.repeat(100), TITLE)).toBeNull()
  })
  it("題の改行・タブは拒み、本文の改行・タブは許す", () => {
    expect(checkFeedbackText("一行目\n二行目", TITLE)).toBe("invalid_chars")
    expect(checkFeedbackText("題\tタブ", TITLE)).toBe("invalid_chars")
    expect(checkFeedbackText("一行目\n二行目\tタブ", BODY)).toBeNull()
  })
  it.each([
    ["NUL", "\u0000"],
    ["BEL", "\u0007"],
    ["CR（正規化の前）", "\r"],
    ["DEL", "\u007f"],
    ["C1", "\u0085"],
    ["RLO", String.fromCodePoint(0x202e)],
    ["RLI", String.fromCodePoint(0x2067)],
  ])("%s を含む本文は拒む", (_name, ch) => {
    expect(checkFeedbackText(`本文${ch}`, BODY)).toBe("invalid_chars")
  })
  it("双方向制御文字の隣の正当な文字（U+2029・U+206A）は拒まぬ（範囲の端の対照）", () => {
    expect(checkFeedbackText(`段落${String.fromCodePoint(0x2029)}区切り`, BODY)).toBeNull()
    expect(checkFeedbackText(`題${String.fromCodePoint(0x206a)}`, TITLE)).toBeNull()
  })
})

describe("状態", () => {
  it("未知の状態は null に退化させる（enum drift で画面を倒さぬ）", () => {
    expect(parseFeedbackStatus("released")).toBe("released")
    expect(parseFeedbackStatus("shipped")).toBeNull()
    expect(parseFeedbackStatus(null)).toBeNull()
    expect(feedbackStatusLabel(null)).toBe("状態を確認中")
  })
  it("運用者が通常の変更で選べる状態に released は含まれぬ", () => {
    expect(OPERATOR_SETTABLE_STATUSES).not.toContain("released")
    expect(isOperatorSettableStatus("released")).toBe(false)
    expect(isOperatorSettableStatus("declined")).toBe(true)
    expect(isOperatorSettableStatus("unknown")).toBe(false)
  })
  it("「対応中」の説明は反映を約束せぬ（反映は本番で確かめてから）", () => {
    expect(FEEDBACK_STATUS_DESCRIPTIONS.in_progress).not.toMatch(/反映されました|まもなく/)
    expect(FEEDBACK_STATUSES.length).toBe(5)
  })
})

describe("releaseOf — 「反映済み」は状態の完全一致かつ証拠付きの時だけ", () => {
  const base = {
    status: "released",
    released_commit_sha: "abcdef1",
    released_note: "v1.7.0",
    released_observed_deploy: "production:abcdef1",
    released_verified_at: "2026-10-25T12:00:00Z",
  }
  it("証拠が揃えば返す", () => {
    expect(releaseOf(base)).toEqual({
      commitSha: "abcdef1",
      note: "v1.7.0",
      observedDeploy: "production:abcdef1",
      verifiedAt: "2026-10-25T12:00:00Z",
    })
  })
  it("確認の時刻か SHA のどちらかが欠ければ null（推測で反映を描かぬ）", () => {
    expect(releaseOf({ ...base, released_verified_at: null })).toBeNull()
    expect(releaseOf({ ...base, released_commit_sha: null })).toBeNull()
  })
  it("状態が released でなければ、証拠の列が在っても null", () => {
    expect(releaseOf({ ...base, status: "in_progress" })).toBeNull()
    expect(releaseOf({ ...base, status: "Released" })).toBeNull()
  })
})

describe("コミット SHA と稼働中のデプロイ", () => {
  it("前後空白と大文字を正規化してから 7〜40 桁の 16 進を受ける", () => {
    expect(COMMIT_SHA_RE.test(normalizeCommitSha("  ABCDEF1 "))).toBe(true)
    expect(COMMIT_SHA_RE.test(normalizeCommitSha("abcdef"))).toBe(false)
    expect(COMMIT_SHA_RE.test(normalizeCommitSha("main"))).toBe(false)
    expect(COMMIT_SHA_RE.test("a".repeat(41))).toBe(false)
  })
  it("Vercel のシステム環境変数から稼働中のデプロイを組む", () => {
    expect(
      observedDeployFromEnv({ VERCEL_ENV: "production", VERCEL_GIT_COMMIT_SHA: "ABCDEF1234\n" }),
    ).toBe("production:abcdef1234")
  })
  it("取れぬ・形が違う時は null（DB が拒む値を送って確定ごと落とさぬ）", () => {
    expect(observedDeployFromEnv({})).toBeNull()
    expect(observedDeployFromEnv({ VERCEL_ENV: "production" })).toBeNull()
    expect(observedDeployFromEnv({ VERCEL_ENV: "staging", VERCEL_GIT_COMMIT_SHA: "abcdef1" })).toBeNull()
    expect(observedDeployFromEnv({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_SHA: "zzz" })).toBeNull()
  })
  it("⚠️ 本番でないデプロイ（preview・development）を名指しする。本番と判別できぬ環境は止めぬ", () => {
    expect(isNonProductionDeploy({ VERCEL_ENV: "preview" })).toBe(true)
    expect(isNonProductionDeploy({ VERCEL_ENV: "development" })).toBe(true)
    // 対照: 本番と、判別できぬ環境（ローカル・e2e）は止めぬ
    expect(isNonProductionDeploy({ VERCEL_ENV: "production" })).toBe(false)
    expect(isNonProductionDeploy({ VERCEL_ENV: " production\n" })).toBe(false)
    expect(isNonProductionDeploy({})).toBe(false)
    expect(isNonProductionDeploy({ VERCEL_ENV: "" })).toBe(false)
    expect(isProductionObservedDeploy("production:abcdef1")).toBe(true)
    expect(isProductionObservedDeploy("preview:abcdef1")).toBe(false)
    expect(isProductionObservedDeploy(null)).toBe(false)
  })
  it("短縮形どうしの前方一致で同じコミットかを見る", () => {
    expect(commitShaMatches("abcdef1", "abcdef1234")).toBe(true)
    expect(commitShaMatches("abcdef1234", "abcdef1")).toBe(true)
    expect(commitShaMatches("abcdef2", "abcdef1234")).toBe(false)
    expect(commitShaMatches("main", "main")).toBe(false)
  })
})

describe("describeFeedbackPush — 「届いた」と断定せぬ", () => {
  const zero = { queued: 0, accepted: 0, unconfirmed: 0, gone: 0, expired: 0, revoked: 0, superseded: 0 }
  it("行が無ければ「積まれていない（端末なし・送る相手なし・積み込み失敗のどれも含む）」", () => {
    expect(describeFeedbackPush(null)).toBe(FEEDBACK_PUSH_NONE)
    expect(describeFeedbackPush(zero)).toBe(FEEDBACK_PUSH_NONE)
  })
  it("⚠️ 行が無いことを「宛先なし」と言い切らぬ（積み込みの失敗も行 0 になり、見分けられぬ）", () => {
    // 定数どうしの比較だけでは文言を戻しても緑のまま — 中身を見る
    expect(FEEDBACK_PUSH_NONE).toContain("積み込めなかった")
    expect(FEEDBACK_PUSH_NONE).toContain("端末が無い")
    expect(FEEDBACK_PUSH_NONE).toContain("送る相手が居らぬ")
    expect(FEEDBACK_PUSH_NONE).not.toMatch(/宛先なし/)
    expect(FEEDBACK_PUSH_NONE).not.toMatch(/届/)
  })
  it("受理でも端末での表示は確認できぬと添える", () => {
    const text = describeFeedbackPush({ ...zero, accepted: 2 })
    expect(text).toContain("受理 2 台")
    expect(text).toContain("端末での表示は確認できません")
  })
  it("どの組み合わせでも「届きました」「届いた」とは書かぬ", () => {
    for (const summary of [
      { ...zero, accepted: 1 },
      { ...zero, queued: 1, unconfirmed: 1 },
      { ...zero, gone: 1, expired: 1, revoked: 1 },
    ]) {
      expect(describeFeedbackPush(summary)).not.toMatch(/届きました|届いた/)
    }
  })
  it("状態が変わって送らなんだ行を「積まれていない」と偽らず数える", () => {
    const text = describeFeedbackPush({ ...zero, superseded: 2 })
    expect(text).toContain("状態が変わったため未送信 2 台")
    expect(text).not.toBe(FEEDBACK_PUSH_NONE)
  })
  it("結果の分からぬ送信は「結果不明」として出す", () => {
    expect(describeFeedbackPush({ ...zero, unconfirmed: 1 })).toContain("結果不明 1 台")
  })
})

describe("formatFeedbackDateTime — JST・h23", () => {
  it("UTC の深夜 0 時台は JST の 9 時台", () => {
    expect(formatFeedbackDateTime("2026-10-25T00:05:00Z")).toBe("10/25 09:05")
  })
  it("JST の 0 時は 24 時ではなく 00 時", () => {
    expect(formatFeedbackDateTime("2026-10-24T15:00:00Z")).toBe("10/25 00:00")
  })
  it("壊れた値・null は null", () => {
    expect(formatFeedbackDateTime("not-a-date")).toBeNull()
    expect(formatFeedbackDateTime(null)).toBeNull()
  })
})
