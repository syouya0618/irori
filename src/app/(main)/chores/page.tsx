import type { ReactNode } from "react"
import { AlertCircle, BrushCleaning, CookingPot, Trash2, type LucideIcon } from "lucide-react"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { loadChoresHubSummary } from "@/lib/supabase/chores-hub-query"
import type { ChoresHubLine } from "@/lib/domain/chores-hub"
import { todayJstString } from "@/lib/utils/date-jst"
import { ChoresHubCard } from "@/components/chores/chores-hub-card"
import { RefreshOnVisible } from "@/components/chores/shared/refresh-on-visible"

interface ChoreEntry {
  href: string
  icon: LucideIcon
  title: string
  description: string
  /** 今日の要約。文と装飾だけを入れる — カード全体がリンクの中に入る */
  summary: ReactNode
}

/**
 * 1 枠の要約。読めなんだ枠は「読み込めませんでした」を**その枠だけ**に出す（色だけで示さず、
 * アイコンと文で示す）。ボタン・リンクは入れぬ（カード全体がリンクゆえ）— 取り直しは下の「今すぐ更新」。
 */
function HubSummary({ line }: { line: ChoresHubLine }) {
  if (line.status === "failed") {
    return (
      <span data-state="failed" className="flex items-start gap-1.5 text-destructive">
        <AlertCircle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span>{line.text}</span>
      </span>
    )
  }
  return (
    <span data-state="ok" className="flex flex-col gap-0.5">
      <span>{line.text}</span>
      {line.note !== undefined && <span className="text-xs font-normal text-muted-foreground">{line.note}</span>}
    </span>
  )
}

/**
 * 家事ハブ。ごみ・掃除・ごはんへの入口と、それぞれの「今日の要約」。
 *
 * - 認証・承認・世帯は (main)/layout が遷移で受ける。ここでも `getAuthContext()` を呼び
 *   （React.cache で同一リクエスト内は 1 回）、文脈が無ければ何も描かぬ
 * - 要約は `loadChoresHubSummary` が 3 枠を並列に読む。**throw せぬ** — どれか 1 つの取得失敗で
 *   ハブ全体を倒さず、その枠だけ「読み込めませんでした」にする（入口は常に使える）
 * - 献立のカタログ・計算はサーバーだけで使う（Client へ渡すのは文だけ。育児トップの bundle へは載せぬ）
 * - 他の端末（家族）の変更は、この画面へ戻ったときに取り込む
 */
export default async function ChoresPage() {
  const { context } = await getAuthContext()
  if (!context) return null
  const { supabase, householdId } = context

  const summary = await loadChoresHubSummary(supabase, householdId, todayJstString())

  const entries: ChoreEntry[] = [
    {
      href: "/chores/garbage",
      icon: Trash2,
      title: "ごみ",
      description: "次の収集日と種別、前日のお知らせ",
      summary: <HubSummary line={summary.garbage} />,
    },
    {
      href: "/chores/cleaning",
      icon: BrushCleaning,
      title: "掃除",
      description: "今日・今週やることと、前回からの日数",
      summary: <HubSummary line={summary.cleaning} />,
    },
    {
      href: "/chores/meals",
      icon: CookingPot,
      title: "ごはん",
      description: "今あるもので作る、週間の献立、買い物リスト",
      summary: <HubSummary line={summary.meals} />,
    },
  ]

  return (
    <div className="flex flex-col gap-6 px-4 pt-12 pb-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-bold">家事</h1>
        <p className="text-sm text-muted-foreground">
          ごみ・掃除・ごはんを、家族で同じ内容を見ながら進められます。
        </p>
      </div>
      <nav aria-label="家事の機能" className="flex flex-col gap-3">
        {entries.map((entry) => (
          <ChoresHubCard key={entry.href} {...entry} />
        ))}
      </nav>
      <RefreshOnVisible />
    </div>
  )
}
