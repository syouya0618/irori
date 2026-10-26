import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/types/database"

/**
 * いつものミルク量（`households.bottle_default_ml`）を読む唯一の組み立て場所。サーバの初回描画
 * （baby/page.tsx）と画面の取り直し（useBottleDefault）が同じ問い合わせを使い、結果の読み方は
 * `decodeBottleDefault`（src/lib/domain/bottle-default.ts）が一手に持つ。
 *
 * ⚠️ 赤子の名前・授乳間隔を読む households の select へ列を**混ぜぬ**。migration
 * （20261025100001）が当たる前の DB へ deploy されると、列が無い select はまるごと失敗し、
 * 名前・誕生日・授乳間隔まで既定値へ落ちる。別の問い合わせにしておけば、落ちるのは量の表示
 * （取得失敗の状態）だけで済む。
 *
 * `signal` は client の取り直し用（次の取り直し・unmount で古い要求を捨てる）。サーバでは渡さぬ。
 * 境界指令を持たぬ中立モジュール（Server Component と Client Component の両方から値 import する）。
 */
export function selectBottleDefault(
  supabase: SupabaseClient<Database>,
  householdId: string,
  signal?: AbortSignal,
) {
  const query = supabase
    .from("households")
    .select("bottle_default_ml")
    .eq("id", householdId)
  return (signal ? query.abortSignal(signal) : query).maybeSingle()
}
