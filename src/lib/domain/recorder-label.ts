/**
 * 記録者（baby_logs.logged_by）の表示（機能 A: 家族への引き継ぎが分かる表示）。
 *
 * 世帯員の profiles（RLS: 同じ世帯の行は読める）から名前を引く。名前が未設定の
 * 世帯員・退出や削除で世帯に居なくなった利用者も自然に表示し、落とさぬ。
 * 記録回数による優劣づけ・既読の表示は加えない（指示 §8 A）。
 */

export interface HouseholdMember {
  id: string
  /** profiles.display_name（空文字は未設定） */
  displayName: string
}

/** 世帯に居なくなった利用者（退出・削除済み）の行に添える名 */
export const UNKNOWN_RECORDER_LABEL = "家族"
/** 世帯員だが名前を設定していない */
export const UNNAMED_RECORDER_LABEL = "名前未設定"

export function recorderLabelFor(
  members: readonly HouseholdMember[],
  userId: string,
): string {
  const member = members.find((m) => m.id === userId)
  if (!member) return UNKNOWN_RECORDER_LABEL
  const name = member.displayName.trim()
  return name === "" ? UNNAMED_RECORDER_LABEL : name
}

/**
 * 記録者を出す場面か。一人で使う世帯では自分の名前が全行に並ぶだけの雑音ゆえ出さぬ。
 * 二人以上の世帯では、誰が付けた記録かが引き継ぎ（授乳・おむつの分担）の判断材料になる。
 */
export function shouldShowRecorder(members: readonly HouseholdMember[]): boolean {
  return members.length >= 2
}
