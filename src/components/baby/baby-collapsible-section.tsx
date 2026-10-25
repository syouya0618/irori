"use client"

import { Collapsible } from "@base-ui/react/collapsible"
import { ChevronDown, ChevronUp } from "lucide-react"

interface BabyCollapsibleSectionProps {
  /** 見出し（開閉の釦の名前の先頭になる） */
  title: string
  /** 畳んだままでも読める要約（「1日平均 授乳8.0回・おむつ6.0回」等） */
  summary: string
  icon: React.ReactNode
  children: React.ReactNode
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
}: BabyCollapsibleSectionProps) {
  return (
    <Collapsible.Root className="glass flex flex-col rounded-2xl shadow-lg shadow-black/[0.04]">
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
