import { cache } from "react"
import { createClient } from "@/lib/supabase/server"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { getVerifiedUserId } from "@/lib/supabase/verified-user"

export type AuthContext = {
  supabase: Awaited<ReturnType<typeof createClient>>
  userId: string
  householdId: string
}

// React.cache() で同一リクエスト内の重複呼び出しをメモ化する。
// (main)/layout.tsx・page.tsx・内部で呼ばれる Server Function のどこから
// 呼ばれても、auth.getUser() と profiles クエリは1回のみ実行される。
// reason は layout のリダイレクト先分岐用 (error 文字列比較を避ける)。
export const getAuthContext = cache(
  async (): Promise<
    | {
        error: string
        reason:
          | "unauthenticated"
          | "not-approved"
          | "no-household"
          | "lookup-failed"
        context: null
      }
    | { error: null; reason: null; context: AuthContext }
  > => {
    const supabase = await createClient()

    // 認証判定は getVerifiedUserId に集約する（proxy と同じ関数を使うことで
    // 層をまたぐ判定の食い違い＝無限リダイレクトを構造的に防ぐ）。
    const userId = await getVerifiedUserId(supabase, "auth-context")

    if (!userId)
      return { error: "認証されていません", reason: "unauthenticated", context: null }

    // is_approved も同じ 1 往復で読む（往復は増えない）。
    // これは承認ゲートの**二層目**じゃ。一層目は proxy にあるが、規約ファイルは
    // 置き場所を一段間違えるだけでビルドも lint も型検査も緑のまま黙って無効化
    // されうる（過去に半年間ゲートが不稼働だった類型）。proxy が inert になった
    // 場合でも、承認されておらぬ利用者へデータ経路を開かぬようにする。
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("household_id, is_approved")
      .eq("id", userId)
      .single()

    // 一過性の DB エラー（接続断・タイムアウト・RLS 誤設定）を「世帯なし」と
    // 混同してはならぬ。混同すると**世帯が在るのに /setup へ飛ばされる**（世帯を
    // 二重作成しかねない導線）。settings/page.tsx は既に error boundary へ倒す
    // 流儀を採っており、ここが不統一だった。
    //
    // lookup-failed も context は返さぬ（fail-closed は維持）。違うのは
    // **呼び出し元がどう扱うか**だけ: no-household は /setup へ誘導してよいが、
    // lookup-failed は「分からない」ゆえ誘導せず error boundary へ倒す。
    if (profileError) {
      logSupabaseError("auth-context", "profile lookup failed", profileError, {
        userId,
      })
      return {
        error: "プロフィールの取得に失敗しました",
        reason: "lookup-failed",
        context: null,
      }
    }

    // error なしで行が無い経路（.single() は通常 PGRST116 を返すため想定外だが、
    // 将来 .maybeSingle() へ変えた場合などに素通りする）。「世帯なし」と断定
    // できぬため lookup-failed 側へ倒す — 判定不能を誘導に使わぬのが本項の要。
    if (!profile) {
      console.error("[auth-context] profile が error なしで空でした", { userId })
      return {
        error: "プロフィールの取得に失敗しました",
        reason: "lookup-failed",
        context: null,
      }
    }

    // 承認判定は household 判定より**先**に置く。proxy の順序（未承認は
    // /pending-approval へ・その後 setup 等へ進ませる）と揃えるためで、
    // 承認を取り消された利用者（household_id は残る）もここで確実に落ちる。
    // 「明示的に false のときだけ」落とすのは、lookup 失敗を承認済み/未承認の
    // どちらとも断定せぬため — その経路は上で lookup-failed として既に落ちている。
    if (profile.is_approved === false)
      return { error: "承認待ちです", reason: "not-approved", context: null }

    if (!profile.household_id)
      return { error: "世帯が設定されていません", reason: "no-household", context: null }

    return { error: null, reason: null, context: { supabase, userId, householdId: profile.household_id } }
  },
)
