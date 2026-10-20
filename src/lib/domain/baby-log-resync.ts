import type { BabyLogData } from "@/lib/types/baby"

/**
 * 復帰・再接続時の再取得（P1-04）の結果を、現在の窓（選択日 logs / 週窓 / 成長）へ
 * 合流させる純関数。
 *
 * 規則は 1 つだけ:
 * - 取得開始**後**に手元で触った id（`touched`: 楽観 append・取り消し・Realtime の
 *   INSERT/UPDATE/DELETE）は **手元（prev）が真値**。prev に在れば残し、無ければ落とす。
 * - それ以外の id は **取得結果（fetched）が真値**。他端末で消えた行は消え、増えた行・
 *   編集された行はサーバの版で入る。
 *
 * これで「取得中に記録した直後の行が一瞬消える」「取得中に取り消した行が古い snapshot で
 * 蘇る」「取得中に届いた編集が古い版で巻き戻る」の三つを同時に防ぐ。
 * `mergeDateNavLogs` を流用しないのは、あちらが prev の行を無条件に残す（＝他端末の
 * 削除が反映されない）ためじゃ。日付ナビの合流規則はそのまま据え置く。
 *
 * `inWindow` は手元から残す行にだけ掛ける窓の述語（旧選択日の行を持ち込まない保険）。
 * fetched はサーバ側で同じ窓に絞って取ってあるため掛け直さない。
 *
 * 並び順は既存の規約（手元由来の行を前置き）に合わせる。描画側（BabyTimeline・
 * 成長曲線）が自前で並べ直すため、ここでは並べ替えない。
 */
export function reconcileResyncedLogs(
  prev: BabyLogData[],
  fetched: BabyLogData[],
  touched: ReadonlySet<string>,
  inWindow: (log: BabyLogData) => boolean,
): BabyLogData[] {
  if (touched.size === 0) return fetched
  const prevById = new Map(prev.map((l) => [l.id, l]))
  const fetchedIds = new Set(fetched.map((l) => l.id))

  const keptLocal = prev.filter(
    (l) => touched.has(l.id) && !fetchedIds.has(l.id) && inWindow(l),
  )
  const fromServer: BabyLogData[] = []
  for (const f of fetched) {
    if (!touched.has(f.id)) {
      fromServer.push(f)
      continue
    }
    const local = prevById.get(f.id)
    // 手元に無い = 取得中に手元で消した（または窓の外へ動いた）。古い snapshot で戻さない。
    if (local && inWindow(local)) fromServer.push(local)
  }
  return keptLocal.length === 0 ? fromServer : [...keptLocal, ...fromServer]
}

/**
 * 「今日より前の最後の授乳」fallback の再取得結果を合流させる。
 *
 * 取得中に手元で更新していなければ取得結果が真値（配偶者の削除で古い行へ戻れる・
 * 行が無くなれば null）。取得中に深夜跨ぎの記録で手元を進めていた時だけ、
 * 既存の keep-newer 規則（epoch 比較 — "Z" と "+09:00" の表記混在に耐える）で新しい方を残す。
 */
export function reconcileResyncedFallback(
  current: BabyLogData | null,
  fetched: BabyLogData | null,
  touchedDuringFetch: boolean,
): BabyLogData | null {
  if (!touchedDuringFetch) return fetched
  if (!current) return fetched
  if (!fetched) return current
  return new Date(fetched.logged_at).getTime() >
    new Date(current.logged_at).getTime()
    ? fetched
    : current
}
