"use server"

import { redirect, unstable_rethrow } from "next/navigation"
import type { AuthError } from "@supabase/supabase-js"
import { createClient } from "@/lib/supabase/server"
import { logSupabaseError } from "@/lib/supabase/log-error"

const SIGN_OUT_ERROR =
  "ログアウトを完了できませんでした。電波の良い場所でもう一度お試しください"

/**
 * ログアウト。成功の時だけ `/login` へ redirect し、失敗は `{ error }` で返す
 * （settings の signOut と同じ契約。理由と auth-js の振る舞いはあちらの注記を参照）。
 * redirect は try の外に置く（内に置くと、ここで遷移の信号を握り潰す）。
 */
export async function signOut(): Promise<{ error: string }> {
  let failure: AuthError | null = null
  try {
    const supabase = await createClient()
    const { error } = await supabase.auth.signOut()
    failure = error
  } catch (err) {
    unstable_rethrow(err)
    console.error("[pending-approval] ログアウトで例外", {
      name: err instanceof Error ? err.name : typeof err,
      message: err instanceof Error ? err.message : String(err),
    })
    return { error: SIGN_OUT_ERROR }
  }
  if (failure) {
    logSupabaseError("pending-approval", "ログアウトに失敗", failure, {})
    return { error: SIGN_OUT_ERROR }
  }
  redirect("/login")
}
