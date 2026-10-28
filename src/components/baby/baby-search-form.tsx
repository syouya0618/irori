import Link from "next/link"
import { CalendarDays, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  SEARCH_KIND_LABELS,
  SEARCH_KINDS,
  SEARCH_QUERY_MAX_LENGTH,
  searchPresets,
  type BabySearchQuery,
} from "@/lib/domain/baby-search"
import { BABY_DATE_PARAM } from "@/lib/domain/baby-link"

interface BabySearchFormProps {
  query: BabySearchQuery
  /** JST の今日（日付入力の上限） */
  today: string
}

/**
 * 記録を探す条件（機能 B）。GET フォームゆえ URL に条件が残り、戻る・共有・再読み込みで
 * 同じ結果へ戻れる。JS 無しでも送れる（Server Component）。
 */
export function BabySearchForm({ query, today }: BabySearchFormProps) {
  const hasCondition =
    query.q !== "" || query.kind !== "all" || query.from !== null || query.to !== null
  const presets = searchPresets(query, today)
  return (
    <>
    {/* よく使う条件の入口（2026-10-27 D）。既存の kind / from / to の組み合わせへのリンクで、
        新しい検索の仕組みは足さぬ。期間の入口は今の種類を、種類の入口は今の期間を保つ */}
    <nav aria-label="よく使う条件" className="flex flex-wrap gap-1.5">
      {presets.map((p) => (
        <Link
          key={p.label}
          href={p.href}
          aria-current={p.active ? "true" : undefined}
          className={`inline-flex min-h-11 items-center rounded-full border px-3 text-sm transition-colors duration-200 ${
            p.active
              ? "border-primary bg-primary/10 font-medium text-primary"
              : "border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          }`}
        >
          {p.label}
        </Link>
      ))}
    </nav>
    {/* 過去の日へ迷わず移る（その日の育児画面を開く。検索とは別の入口） */}
    <form
      method="get"
      action="/baby"
      aria-label="日付を指定して開く"
      className="glass flex items-end gap-2 rounded-2xl p-4 shadow-lg shadow-black/[0.04]"
    >
      <div className="min-w-0 flex-1 space-y-1.5">
        <Label htmlFor="search-open-date">日付を指定して開く</Label>
        <Input
          id="search-open-date"
          name={BABY_DATE_PARAM}
          type="date"
          max={today}
          defaultValue={query.to ?? today}
          required
          className="min-h-11 rounded-lg"
        />
      </div>
      <Button type="submit" variant="outline" className="min-h-11 shrink-0">
        <CalendarDays size={16} />
        この日を開く
      </Button>
    </form>
    <form
      method="get"
      action="/baby/search"
      className="glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]"
      aria-label="記録を探す条件"
    >
      <div className="space-y-1.5">
        <Label htmlFor="search-q">メモ・日記の言葉</Label>
        <Input
          id="search-q"
          name="q"
          type="search"
          defaultValue={query.q}
          maxLength={SEARCH_QUERY_MAX_LENGTH}
          placeholder="例: 鼻水、よく寝た"
          autoComplete="off"
          className="min-h-11 rounded-lg"
        />
      </div>
      {/* 種類を 1 段、期間（2 つの日付）を 2 列。3 列に詰めると 360px 幅で日付入力が
          約 100px になり、選んだ日付が欠けて読めぬ */}
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="search-kind">種類</Label>
          <select
            id="search-kind"
            name="kind"
            defaultValue={query.kind}
            className="min-h-11 w-full rounded-lg border border-input bg-transparent px-2.5 text-base transition-colors duration-200 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring md:text-sm dark:bg-input/30"
          >
            {SEARCH_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {SEARCH_KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="search-from">いつから</Label>
          <Input
            id="search-from"
            name="from"
            type="date"
            defaultValue={query.from ?? ""}
            max={today}
            className="min-h-11 rounded-lg"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="search-to">いつまで</Label>
          <Input
            id="search-to"
            name="to"
            type="date"
            defaultValue={query.to ?? ""}
            max={today}
            className="min-h-11 rounded-lg"
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" className="min-h-11 flex-1">
          <Search size={16} />
          探す
        </Button>
        {hasCondition && (
          // 素の <Link>（not-found.tsx と同じ）。Base UI の Button に Link を描かせると、
          // nativeButton の既定では <a> に type="button" が付き、false にすると role="button"
          // が付いて link でなくなる。遷移はリンクのまま、見た目だけ ghost ボタンに揃える
          <Link
            href="/baby/search"
            className="inline-flex min-h-11 items-center justify-center rounded-lg px-3 text-sm font-medium transition-colors duration-200 hover:bg-accent hover:text-accent-foreground"
          >
            条件をクリア
          </Link>
        )}
      </div>
    </form>
    </>
  )
}
