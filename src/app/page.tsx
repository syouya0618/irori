import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { getVerifiedUserId } from "@/lib/supabase/verified-user"
import { resolveDefaultPage } from "@/lib/constants/pages"

/**
 * 起動時の振り分けの**二層目**。
 *
 * ⚠️ **通常は到達せぬ。** 承認済みの利用者が `/` に来た場合、`src/proxy.ts` が
 * `profiles` を引くついでに `default_page` も読み、ここへ来る前に
 * `/${page}` へ 307 する。ゆえに平常時この関数は走らぬ。
 *
 * **それでも消してはならぬ理由**: proxy は Next の規約ファイルであり、置き場所を
 * 一段間違えるだけで build も lint も型検査も緑のまま黙って無効化されうる
 * （過去に半年間ゲートが不稼働だった類型）。proxy が inert になった場合、
 * `/` はここへ素通しされる。ここが無ければ起動時のページ設定は**再び死ぬ**
 * ——それがまさに `#219` で塞いだ穴じゃ。
 *
 * **代償を承知しておくこと**: 平常時に走らぬコードは腐る。ゆえに
 * ①振り分け規則は `resolveDefaultPage` に畳んで proxy と共有し（別々に既定値を
 * 持たせぬ）、②この経路自体は `src/app/__tests__/home-redirect.test.ts` が
 * 単体で撃ち続ける。実経路の観測に頼らぬ形にしてある。
 */
export default async function Home() {
  const supabase = await createClient()
  // proxy と同じ判定源を使う（別方式にすると食い違いで無限リダイレクトになる）
  const userId = await getVerifiedUserId(supabase, "home")

  if (!userId) redirect("/login")

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("default_page")
    .eq("id", userId)
    .single()

  if (profileError) {
    logSupabaseError("home", "profile lookup failed", profileError, {
      userId,
    })
  }

  redirect(`/${resolveDefaultPage(profile?.default_page)}`)
}
