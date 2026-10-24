import type { BabyLogData } from "@/lib/types/baby"
import { toJstDateString } from "@/lib/utils/date-jst"

export interface BabyDashboardSummary {
  lastFeeding: BabyLogData | null
}

/**
 * BabyDashboard のまとめ表示（最終授乳）を選択日の logs から 1 パスで導出する純関数。
 *
 * lastFeeding は**配列順に依存せず** logged_at（epoch 比較）が最新の授乳行を選ぶ
 * （批判レビュー P2）: 楽観 append（appendLog / Realtime INSERT）は無条件の先頭
 * prepend で、タイマー由来の行は loggedAt=開始時刻（過去）を持つため、降順不変条件は
 * 供給側で保証されない。先頭一致だと「タイマー中に記録したミルク」より古いサイクル行が
 * 最終授乳になり、経過表示がリロードまで古い値に張り付く。文字列比較でなく epoch
 * 比較なのは、楽観行（toISOString の "Z"）とサーバ行（"+00:00"）の表記混在で
 * 辞書順が時刻順と食い違うため。
 *
 * `lastFeedingFallback`（批判レビュー P3）: logged_at の開始時刻化により、深夜を
 * 跨いだサイクルは前日行になり当日窓の logs に現れない。当日に授乳が無い間
 * 「最終授乳 ---」に落ちないよう、サーバで別途取得した「今日より前の最後の授乳」
 * で補完する。ローカル導出が優先（当日行は常に fallback より新しい）。
 */
export function deriveDashboardSummary(
  logs: BabyLogData[],
  lastFeedingFallback: BabyLogData | null = null,
): BabyDashboardSummary {
  let lastFeeding: BabyLogData | undefined
  let lastFeedingEpoch = Number.NEGATIVE_INFINITY
  for (const l of logs) {
    if (l.log_type === "feeding") {
      const epoch = new Date(l.logged_at).getTime()
      // 不正 ISO（NaN）は比較に負けて選ばれない（NaN > x は常に false）
      if (epoch > lastFeedingEpoch) {
        lastFeeding = l
        lastFeedingEpoch = epoch
      }
    }
  }
  return {
    lastFeeding: lastFeeding ?? lastFeedingFallback ?? null,
  }
}

/**
 * 「今日より前の最後の授乳」フォールバックを、候補の中の新しいものへ前進させる純関数。
 *
 * フォールバックはサーバがページ読込時点の今日を基準に取った値ゆえ、画面を開いたまま
 * 日を跨ぐと古くなる。進めねば、新しい今日にまだ授乳が無い間、前夜の授乳を飛ばして
 * 2 日前の授乳を「最終授乳」「次の授乳の目安」の起点にしてしまう（夜間授乳の判断を誤る）。
 *
 * - 候補は `log_type === "feeding"` かつ `newTodayStartIso` より前のものだけ
 * - `excludePumped` は**搾乳だけを外す denylist**（page.tsx の目安用クエリ・
 *   findLastNursing と同じ向き。allowlist にすると DB に増えた種別が無音で漏れる）
 * - 比較は epoch（楽観行の "Z" とサーバ行の "+00:00" が混在するため文字列比較せぬ）
 * - 現在値より新しい候補が無ければ**同じ参照**を返す（古い候補で巻き戻さず、
 *   state 更新も起こさぬ）
 */
export function advanceFeedingFallback(
  current: BabyLogData | null,
  candidates: readonly BabyLogData[],
  newTodayStartIso: string,
  opts: { excludePumped: boolean },
): BabyLogData | null {
  const limit = new Date(newTodayStartIso).getTime()
  let best = current
  let bestEpoch = current
    ? new Date(current.logged_at).getTime()
    : Number.NEGATIVE_INFINITY
  for (const l of candidates) {
    if (l.log_type !== "feeding") continue
    if (opts.excludePumped && l.feeding_type === "pumped") continue
    const epoch = new Date(l.logged_at).getTime()
    // 不正 ISO（NaN）はどの比較にも負けて選ばれぬ
    if (epoch < limit && epoch > bestEpoch) {
      best = l
      bestEpoch = epoch
    }
  }
  return best
}

/**
 * `incoming` が `existing` より古い版か（＝置き換えてはならぬか）を返す純関数。
 *
 * 編集の反映は「自分の updateLog の応答」と「Realtime UPDATE の echo」の二経路で届き、
 * 到着順は保証されぬ。別端末が同じ行を後から編集すると、その echo（新しい版）が先に届き、
 * 自分の応答（古い版）が後から着きうる。無条件に置き換えると、DB は新しい版なのに画面は
 * 古い版で固まる（以後この行の echo は来ない）。
 *
 * - 比較は `updated_at` の epoch（応答と echo で表記が違いうるため文字列比較せぬ）
 * - どちらかが `updated_at` を欠く（楽観 append の行・不正値）なら false — データ欠落で
 *   正当な更新を止めぬ向きに倒す
 * - 同時刻は false（置き換えてよい）。updated_at は now() = トランザクション開始時刻ゆえ、
 *   行ロックで直列化された競合ではコミット順と数 ms 食い違いうる。その窓は受容する
 */
export function isOlderLogVersion(
  incoming: Pick<BabyLogData, "updated_at">,
  existing: Pick<BabyLogData, "updated_at">,
): boolean {
  if (!incoming.updated_at || !existing.updated_at) return false
  const inc = new Date(incoming.updated_at).getTime()
  const cur = new Date(existing.updated_at).getTime()
  if (Number.isNaN(inc) || Number.isNaN(cur)) return false
  return inc < cur
}

/**
 * 日付ナビの client refetch 結果（`fetched`、logged_at 降順・選択日窓）を
 * 現在の logs state（`prev`）へ id ベースの dedupe マージで合流させる純関数（B-08）。
 *
 * 従来は `setLogs(data)` の無条件全置換だったため、fetch が in-flight の間に
 * Realtime で先着した「選択日の新規行」が解決時に上書きで消えていた（H3-02）。
 * `fetched` を真値の土台とし、`prev` のうち **選択日に属し**かつ `fetched` に
 * 含まれない行（＝ in-flight 中に届いた Realtime 行）のみを保持して前置きする。
 *
 * `toJstDateString(logged_at) === selectedDate` の絞り込みは load-bearing:
 * fetch 解決時点の `prev` には遷移前の旧選択日の行がまだ残っている場合があり、
 * これを落とす（無条件全置換が持っていた「旧日付を捨てる」挙動の維持）と同時に、
 * 選択日に属する Realtime 先着行だけを救済する。干渉が無い通常ケースでは
 * `fetched` と同一配列を返す（＝置換であって削除でない）。
 *
 * 並び順は既存 Realtime INSERT の `[newLog, ...prev]` 前置き規約に合わせ、
 * 保持行を `fetched`（サーバ降順）の前に置く。再ソートはしない。
 *
 * ⚠️ 下記の `toJstDateString(logged_at) === selectedDate` フィルタは、
 * baby-dashboard.tsx の Realtime INSERT admission guard
 * （`toJstDateString(newLog.logged_at) !== selectedDateRef.current` → skip）と
 * **同じ入場条件を鏡写しにしている**（先着行はこの guard を通って初めて prev に
 * 入るため）。将来 logs の日付窓に cross-midnight の `or()` 節を足す際は、admission
 * guard と本フィルタを**同時に**更新すること。片方だけ広げると、fetch in-flight
 * 中に届いた前日開始の行が解決時に無音で落ちる。
 */
export function mergeDateNavLogs(
  prev: BabyLogData[],
  fetched: BabyLogData[],
  selectedDate: string,
): BabyLogData[] {
  const fetchedIds = new Set(fetched.map((l) => l.id))
  const preserved = prev.filter(
    (l) =>
      !fetchedIds.has(l.id) &&
      // Realtime admission guard（baby-dashboard.tsx）と同期を保つこと（上の注意）
      toJstDateString(l.logged_at) === selectedDate,
  )
  if (preserved.length === 0) return fetched
  return [...preserved, ...fetched]
}
