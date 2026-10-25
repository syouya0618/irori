import Link from "next/link"
import { Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  SEARCH_KIND_LABELS,
  SEARCH_KINDS,
  SEARCH_QUERY_MAX_LENGTH,
  type BabySearchQuery,
} from "@/lib/domain/baby-search"

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
  return (
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
            className="min-h-11 w-full rounded-lg border border-input bg-transparent px-2.5 text-base transition-colors duration-200 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
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
  )
}
