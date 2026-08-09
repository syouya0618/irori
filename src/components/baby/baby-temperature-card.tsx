"use client"

import { Plus, Thermometer, TriangleAlert } from "lucide-react"
import {
  buildDailyTemperature,
  isFeverTemperature,
  type TemperatureSlot,
  type TemperatureSlotEntry,
} from "@/lib/domain/baby-temperature-slots"
// 表示は `formatTimeJst`（タイムライン等アプリ全体と同じ表記）、スロット判定は
// `formatJstTimeInput`（h23 固定）と**意図的に使い分けておる**。判定側だけ h23 に
// するのは、ICU 既定で深夜 0 時が "24:00" になると 00:xx JST が夜枠へ静かに落ちる
// ため（`date-jst.ts:198-200` 参照）。表示側を h23 にしないのは、そちらを変えると
// この 1 画面だけがアプリの他と違う表記になるゆえ。
import { formatTimeJst } from "@/lib/utils/date-jst"
import type { BabyLogData } from "@/lib/types/baby"

interface BabyTemperatureCardProps {
  /**
   * **選択日のログ**（`baby-dashboard.tsx` の `logs`）を渡すこと。週窓の `weeklyLogs`
   * ではない — `BabyDateNav` で週窓の外の過去日を開いた時に静かに空になるため。
   */
  logs: BabyLogData[]
  /** 選択日（JST の "YYYY-MM-DD"） */
  date: string
  /** 選択日が今日か。記録ボタンの出し分けに使う（下記の理由で今日限定） */
  isToday: boolean
  /** 埋まっているスロットのタップで編集シートを開く */
  onEdit: (log: BabyLogData) => void
  /** 空きスロットのタップで logType="temperature" の新規フォームシートを開く */
  onCreate: () => void
}

const SLOT_LABEL: Record<TemperatureSlot, string> = {
  morning: "朝",
  night: "夜",
}

/**
 * 体温の表示は小数第 1 位に固定する（`36.7℃` / `37.0℃`）。
 *
 * `temperature` は `NUMERIC(3,1)` 由来の `number` ゆえ、素の補間では 37.0 が `37`
 * と出て桁幅が揺れ、発熱境界（37.5）の直近で読み違えやすい。
 * `baby-timeline-item.tsx:80` は素の補間ゆえ**そちらとは表記が分かれる**が、
 * 朝夜カードは 2 値を横に並べて見比べる面ゆえ桁を揃える方を採る。
 */
function formatTemperature(value: number): string {
  return value.toFixed(1)
}

function TemperatureSlotCell({
  slot,
  entry,
  extra,
  isToday,
  onEdit,
  onCreate,
}: {
  slot: TemperatureSlot
  entry: TemperatureSlotEntry | null
  extra: number
  isToday: boolean
  onEdit: () => void
  onCreate: () => void
}) {
  const slotLabel = SLOT_LABEL[slot]
  // aria-label は「体温」単独にせぬこと: `baby-quick-actions.tsx` に既存の「体温」
  // ボタンが在り、`getByRole("button", { name: /体温/ })` 系が multiple-match で割れる。
  const dayPrefix = isToday ? "今日の" : ""

  if (entry) {
    const fever = isFeverTemperature(entry.temperature)
    const time = formatTimeJst(entry.loggedAt)
    // 語を配列で組んで空白 1 つで繋ぐ（テンプレート直書きだと省略時に空白が
    // 二重化/欠落し、アクセシブル名が静かに揺れる）。
    const labelParts = [
      `${dayPrefix}${slotLabel}の体温`,
      `${formatTemperature(entry.temperature)}度`,
      time,
    ]
    if (extra > 0) labelParts.push(`他${extra}件`)
    if (fever) labelParts.push("発熱")
    labelParts.push("を編集")

    return (
      <button
        type="button"
        onClick={onEdit}
        aria-label={labelParts.join(" ")}
        className="flex min-h-11 flex-col items-start gap-0.5 rounded-xl px-2 py-1.5 text-left transition-colors duration-200 hover:bg-rose-50 active:bg-rose-100 dark:hover:bg-rose-900/30 dark:active:bg-rose-900/50"
      >
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          {slotLabel}
          {extra > 0 && (
            <span className="rounded-full bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground">
              +{extra}
            </span>
          )}
        </span>
        <span className="font-mono text-lg font-semibold leading-tight">
          {formatTemperature(entry.temperature)}℃
        </span>
        {/* 発熱域は色だけに依存させぬ（Lucide アイコン + テキストで併記する） */}
        {fever && (
          <span className="flex items-center gap-1 text-[10px] font-medium text-rose-700 dark:text-rose-300">
            <TriangleAlert size={12} className="shrink-0" />
            発熱
          </span>
        )}
        <span className="font-mono text-[10px] text-muted-foreground">
          {time}
        </span>
      </button>
    )
  }

  // 空きスロット。記録ボタンは **今日のみ**に出す。
  // `baby-log-form-sheet.tsx:222` の `logDate` は新規作成を**今日固定**で導出し
  // （`logDate` prop は存在しない）、`baby-dashboard.tsx` の `appendLog` は日付を
  // 検査せず選択日の配列へ prepend する。ゆえに過去日で記録させると
  // (a) 保存されるのは今日の行 (b) 過去日のタイムラインに今日の行が混入する。
  // `baby-optimistic-log.ts:14-18` が F-03 として名指しで警告しておる境界じゃ。
  if (!isToday) {
    return (
      <div className="flex min-h-11 flex-col items-start gap-0.5 px-2 py-1.5">
        <span className="text-[10px] text-muted-foreground">{slotLabel}</span>
        <span className="text-sm text-muted-foreground">記録なし</span>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={onCreate}
      aria-label={`${dayPrefix}${slotLabel}の体温を記録`}
      className="flex min-h-11 flex-col items-start gap-0.5 rounded-xl border border-dashed border-border px-2 py-1.5 text-left transition-colors duration-200 hover:bg-rose-50 active:bg-rose-100 dark:hover:bg-rose-900/30 dark:active:bg-rose-900/50"
    >
      <span className="text-[10px] text-muted-foreground">{slotLabel}</span>
      <span className="flex items-center gap-1 text-sm font-medium text-rose-800 dark:text-rose-200">
        <Plus size={14} className="shrink-0" />
        記録
      </span>
      <span className="text-[10px] text-muted-foreground">未測定</span>
    </button>
  )
}

/**
 * 朝/夜の体温を 2 スロットで見せるカード（訴え③「体温を記載できる場所」）。
 *
 * 記録機能そのものは既に在る（`recordTemperature` / クイックアクション / フォーム
 * シート / タイムライン）。欠けていたのは**読み返す面**ゆえ、ここでは新しい
 * 書き込み経路を作らず、既存の作成・編集シートを開くだけに留める。
 */
export function BabyTemperatureCard({
  logs,
  date,
  isToday,
  onEdit,
  onCreate,
}: BabyTemperatureCardProps) {
  const daily = buildDailyTemperature(logs, date)

  const handleEditSlot = (entry: TemperatureSlotEntry | null) => () => {
    if (!entry) return
    const log = logs.find((l) => l.id === entry.id)
    // 主表示は logs から組んだ行ゆえ通常は必ず見つかる。見つからぬ場合に
    // undefined を editingLog へ流すと新規作成モードで開いてしまうため握る。
    if (!log) return
    onEdit(log)
  }

  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-center gap-1.5 px-1 text-xs font-semibold text-muted-foreground">
        <Thermometer size={14} />
        {isToday ? "今日の体温" : "体温"}
      </h2>

      <div className="glass rounded-2xl p-4 shadow-lg shadow-black/[0.04]">
        <div className="grid grid-cols-2 gap-3">
          <TemperatureSlotCell
            slot="morning"
            entry={daily.morning}
            extra={daily.morningExtra}
            isToday={isToday}
            onEdit={handleEditSlot(daily.morning)}
            onCreate={onCreate}
          />
          <TemperatureSlotCell
            slot="night"
            entry={daily.night}
            extra={daily.nightExtra}
            isToday={isToday}
            onEdit={handleEditSlot(daily.night)}
            onCreate={onCreate}
          />
        </div>
      </div>
    </section>
  )
}
