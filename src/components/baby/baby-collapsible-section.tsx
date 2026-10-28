"use client"

import { useCallback, useEffect, useState } from "react"
import { Collapsible } from "@base-ui/react/collapsible"
import { ChevronDown, ChevronUp } from "lucide-react"

interface BabyCollapsibleSectionProps {
  /** 見出し（開閉の釦の名前の先頭になる） */
  title: string
  /** 畳んだままでも読める要約（「1日平均 授乳8.0回・おむつ6.0回」等） */
  summary: string
  icon: React.ReactNode
  children: React.ReactNode
  /** 開閉を親が持つ時（この端末に覚える。useHomeFolds）。省略時は畳んで始まる */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

/**
 * 「必要な時にだけ開く」面（週間サマリー・成長グラフ）。
 *
 * 育児画面は記録と今日の流れを読む場所で、週の傾向・成長曲線は毎回は見ない。常に展開して
 * おくと、今日のタイムラインがグラフ 2 枚ぶん（約 1000px）下へ押し出されていた。畳んだ
 * 見出しにも要約の数字を出し、開かずに足りる時は開かせぬ。
 *
 * 開閉は Base UI の Collapsible（既存依存。aria-expanded / aria-controls を持つ）。中身は
 * `keepMounted` で DOM に残す — グラフの SVG は Realtime 反映の検証の足場でもあり、開閉で
 * 作り直さぬ。開閉のアニメーションは付けぬ（transition-colors 以外を使わぬ方針。矢印は
 * 回転でなく差し替え）。
 */
export function BabyCollapsibleSection({
  title,
  summary,
  icon,
  children,
  open,
  onOpenChange,
}: BabyCollapsibleSectionProps) {
  return (
    <Collapsible.Root
      className="glass flex flex-col rounded-2xl shadow-lg shadow-black/[0.04]"
      {...(open !== undefined && { open })}
      {...(onOpenChange && { onOpenChange: (next: boolean) => onOpenChange(next) })}
    >
      {/* 見出しの段で包む（畳んでも見出しで飛べるように。中身側の h2 は embedded で外す） */}
      <h2>
      <Collapsible.Trigger className="group flex min-h-14 w-full items-center gap-3 rounded-2xl px-4 py-3 text-left transition-colors duration-200 hover:bg-muted/50 active:bg-muted/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        <span className="shrink-0 text-primary" aria-hidden="true">
          {icon}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-semibold">{title}</span>
          {/* 読み上げで題と要約が一続きにならぬよう区切る */}
          <span className="sr-only">、</span>
          <span className="truncate text-sm font-normal text-muted-foreground">{summary}</span>
        </span>
        <ChevronDown
          size={20}
          className="shrink-0 text-muted-foreground group-data-[panel-open]:hidden"
          aria-hidden="true"
        />
        <ChevronUp
          size={20}
          className="hidden shrink-0 text-muted-foreground group-data-[panel-open]:block"
          aria-hidden="true"
        />
      </Collapsible.Trigger>
      </h2>
      <Collapsible.Panel keepMounted className="px-4 pb-4">
        {children}
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}

// ── ホームの低頻度の面の開閉（2026-10-27 テーマ C3） ─────────────────────────────

/**
 * 利用者が任意で畳める面。主要操作（クイック記録）・計測中チップ・確認中の保存・最新を確認できぬ
 * 知らせ・タイムラインはここに入れぬ（畳ませぬ・並べ替えぬ）。
 */
export type HomeFoldId = "upcoming" | "temperature" | "diary" | "weekly" | "growth"

/** 既定の開閉（従来どおり: 予定・体温・日記は開き、週間・成長は畳む） */
export const HOME_FOLD_DEFAULTS: Record<HomeFoldId, boolean> = {
  upcoming: true,
  temperature: true,
  diary: true,
  weekly: false,
  growth: false,
}

export const HOME_FOLD_KEY_PREFIX = "irori:home-folds:v1:"

export function homeFoldStorageKey(owner: { userId: string; householdId: string }): string {
  return `${HOME_FOLD_KEY_PREFIX}${owner.userId}:${owner.householdId}`
}

function readFolds(key: string): Partial<Record<HomeFoldId, boolean>> {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return {}
    const out: Partial<Record<HomeFoldId, boolean>> = {}
    for (const id of Object.keys(HOME_FOLD_DEFAULTS) as HomeFoldId[]) {
      const v = (parsed as Record<string, unknown>)[id]
      if (typeof v === "boolean") out[id] = v
    }
    return out
  } catch {
    // 読めぬ・壊れた値は既定へ（表示の好みだけゆえ失っても困らぬ）
    return {}
  }
}

/**
 * 面の開閉をこの端末に覚える（持ち主ごと。別の利用者・世帯の好みを持ち込まぬ）。localStorage は
 * effect で読む（SSR の描画と食い違わせぬ）。書けぬ環境では画面の間だけ効く。
 */
export function useHomeFolds(owner: { userId: string; householdId: string } | null) {
  const key = owner ? homeFoldStorageKey(owner) : null
  const [stored, setStored] = useState<Partial<Record<HomeFoldId, boolean>>>({})
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage は描画の後にだけ読む（SSR との食い違いを避ける）
    setStored(key ? readFolds(key) : {})
  }, [key])
  const isOpen = useCallback(
    (id: HomeFoldId) => stored[id] ?? HOME_FOLD_DEFAULTS[id],
    [stored],
  )
  const setOpen = useCallback(
    (id: HomeFoldId, open: boolean) => {
      setStored((prev) => {
        const next = { ...prev, [id]: open }
        if (key) {
          try {
            localStorage.setItem(key, JSON.stringify(next))
          } catch {
            // 覚えられぬ環境（プライベートモード・容量不足）は画面の間だけ効く
          }
        }
        return next
      })
    },
    [key],
  )
  return { isOpen, setOpen }
}

interface HomeFoldToggleProps {
  /** 面の名前（「体温」等）。釦の名前は「{title}を畳む」 */
  title: string
  onFold: () => void
  className?: string
}

/** 開いておる面の見出しの横に置く「畳む」釦（44px） */
export function HomeFoldToggle({ title, onFold, className = "" }: HomeFoldToggleProps) {
  return (
    <button
      type="button"
      onClick={onFold}
      aria-expanded={true}
      aria-label={`${title}を畳む`}
      className={`flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center gap-0.5 rounded-lg px-1 text-xs text-muted-foreground transition-colors duration-200 hover:text-foreground ${className}`}
    >
      畳む
      <ChevronUp size={14} aria-hidden="true" />
    </button>
  )
}

interface HomeFoldedRowProps {
  title: string
  /** 畳んだままでも読める一行（無ければ「畳んでいます」） */
  summary?: string | null
  icon: React.ReactNode
  onExpand: () => void
}

/** 畳んだ面の一行（開く釦）。週間・成長の畳んだ見出しと同じ形 */
export function HomeFoldedRow({ title, summary, icon, onExpand }: HomeFoldedRowProps) {
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-expanded={false}
      className="glass flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-2xl px-4 py-3 text-left shadow-lg shadow-black/[0.04] transition-colors duration-200 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <span className="shrink-0 text-primary" aria-hidden="true">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-semibold">{title}</span>
        <span className="sr-only">、</span>
        <span className="truncate text-sm text-muted-foreground">{summary || "畳んでいます"}</span>
      </span>
      <ChevronDown size={20} className="shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  )
}

interface HomeFoldFrameProps {
  title: string
  summary?: string | null
  icon: React.ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}

/**
 * 中身の部品に手を入れずに畳めるようにする枠（体温カードなど、見出しの右が空いておる面）。
 * 開いておる時は中身をそのまま出し、見出しの行の右端に「畳む」を重ねる。
 */
export function HomeFoldFrame({ title, summary, icon, open, onOpenChange, children }: HomeFoldFrameProps) {
  if (!open) {
    return (
      <HomeFoldedRow title={title} summary={summary} icon={icon} onExpand={() => onOpenChange(true)} />
    )
  }
  return (
    <div className="relative">
      {children}
      <HomeFoldToggle title={title} onFold={() => onOpenChange(false)} className="absolute -top-3.5 right-0" />
    </div>
  )
}
