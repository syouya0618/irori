import { clientBuildId } from "@/lib/release/build-info"
import { RELEASE_NAME } from "@/lib/release/release-notes"

/**
 * いま答えておるデプロイの版（2026-10-27 大型更新 E1）と、サーバの今の時刻（2026-10-28 N3）。
 *
 * 返すのはこの bundle にビルド時に埋め込まれた短い SHA（`next.config.ts` の env）とリリース名だけ。
 * 端末側も同じ規則で埋め込まれた値を持つゆえ、両者を比べれば「端末が読んでおる build」と
 * 「いま配っておる build」の食い違いが分かる。branch 名・環境名・利用者の情報は返さぬ。
 *
 * `serverTime`（epoch ms）は母乳の手動記録の開始時刻を端末の時計に頼らず決めるためのサンプル
 * （`@/lib/domain/server-clock`）。端末は往復の時間と経過の時計から押した時刻をサーバの時計で
 * 推定する。新しい経路を足さず、承認ゲートの内側にあり no-store のこの応答に相乗りさせた。
 *
 * 認可は proxy（承認ゲート）に任せる — `isPublicRoute` には足さぬ（ログインしておらぬ端末に版を
 * 配る理由は無い）。未ログインの要求は 307 で /login へ送られ、端末は「確認できなかった」と扱う。
 * 応答は `no-store`（古い版・古い時刻の答えを中間や端末に残すと、更新の案内も時刻の補正も嘘になる）。
 */
export const dynamic = "force-dynamic"

export async function GET() {
  return Response.json(
    { buildId: clientBuildId(), releaseName: RELEASE_NAME, serverTime: Date.now() },
    { headers: { "Cache-Control": "no-store" } },
  )
}
