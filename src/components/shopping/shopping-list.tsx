"use client"

import {
  useState,
  useEffect,
  useMemo,
  useRef,
  useTransition,
  useCallback,
} from "react"
import {
  ChevronDown,
  ChevronRight,
  Trash2,
  Loader2,
  Carrot,
  Apple,
  Beef,
  Fish,
  Milk,
  Egg,
  Wheat,
  Flame,
  Snowflake,
  Cookie,
  UtensilsCrossed,
  Baby,
  SprayCan,
  Heart,
  Package,
} from "lucide-react"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { logRealtimeStatus, logRealtimeEvent } from "@/lib/supabase/realtime-log"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { useVisibilityRefetch } from "@/lib/hooks/use-visibility-refetch"
import { SHOPPING_ITEM_COLUMNS } from "@/lib/domain/shopping-item-columns"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog"
import { ShoppingItem, type ShoppingItemData } from "./shopping-item"
import { AddItemForm } from "./add-item-form"
import { GenerateFromMeals } from "./generate-from-meals"
import { clearChecked } from "@/app/(main)/shopping/actions"
// startTransition 内の未処理 reject は error boundary へ bubble する（offline-error.ts）
import { toastOfflineError } from "@/lib/utils/offline-error"
import {
  getCategoryLabel,
  categoryDisplayOrder,
  allStores,
} from "@/lib/utils/categories"
import type { ItemCategory, StoreType } from "@/lib/types/database"

// ─── カテゴリーアイコンマッピング ────────────────────────
const categoryIcons: Record<ItemCategory, React.ComponentType<{ size?: number; className?: string }>> = {
  vegetable: Carrot,
  fruit: Apple,
  meat: Beef,
  fish: Fish,
  dairy: Milk,
  egg: Egg,
  grain: Wheat,
  seasoning: Flame,
  frozen: Snowflake,
  snack_food: Cookie,
  other_food: UtensilsCrossed,
  baby: Baby,
  cleaning: SprayCan,
  hygiene: Heart,
  other_daily: Package,
}

// ─── 型定義 ──────────────────────────────────────────────
interface MemberInfo {
  id: string
  display_name: string
}

interface ShoppingListProps {
  initialItems: ShoppingItemData[]
  householdId: string
  members: MemberInfo[]
}

// ─── ストアタブ定義 ──────────────────────────────────────
const storeTabs: { value: StoreType | "all"; label: string }[] = [
  { value: "all" as const, label: "全て" },
  ...allStores,
]

export function ShoppingList({
  initialItems,
  householdId,
  members,
}: ShoppingListProps) {
  const [items, setItems] = useState<ShoppingItemData[]>(initialItems)
  const [storeFilter, setStoreFilter] = useState<StoreType | "all">("all")
  const [checkedExpanded, setCheckedExpanded] = useState(false)
  const [clearDialogOpen, setClearDialogOpen] = useState(false)
  const [isClearPending, startClearTransition] = useTransition()

  // メンバー名マップ
  const memberMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const m of members) {
      map.set(m.id, m.display_name)
    }
    return map
  }, [members])

  // ─── Supabase Realtime ─────────────────────────────────
  useEffect(() => {
    const supabase = createClient()

    const channel = supabase
      .channel("shopping")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "shopping_items",
          filter: `household_id=eq.${householdId}`,
        },
        (payload) => {
          logRealtimeEvent("shopping", payload)
          if (payload.eventType === "INSERT") {
            const newItem = payload.new as ShoppingItemData
            setItems((prev) => {
              // 既に存在する場合はスキップ（楽観更新との重複防止）
              if (prev.some((i) => i.id === newItem.id)) return prev
              return [...prev, newItem]
            })
          } else if (payload.eventType === "UPDATE") {
            const updated = payload.new as ShoppingItemData
            setItems((prev) =>
              prev.map((i) => (i.id === updated.id ? updated : i))
            )
          } else if (payload.eventType === "DELETE") {
            const deleted = payload.old as { id: string }
            setItems((prev) => prev.filter((i) => i.id !== deleted.id))
          }
        }
      )
      .subscribe((status, err) => {
        logRealtimeStatus("shopping", status, err)
      })

    return () => {
      supabase.removeChannel(channel)
    }
  }, [householdId])

  // ─── 復帰時 refetch ────────────────────────────────────
  // Realtime は本番で間欠不達（#92）、かつフィルタ付き購読では DELETE が構造的に
  // 配信されない。ゆえに「配偶者が消した行が消えない / 追加した行が出ない」は
  // タブ復帰時の refetch でしか回収できぬ。
  const fetchGenerationRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const refetchItems = useCallback(() => {
    const generation = ++fetchGenerationRef.current
    // 復帰連打で往復が重なった場合、古い方は捨てる（世代ガード + 明示 abort）
    abortRef.current?.abort()
    const abortController = new AbortController()
    abortRef.current = abortController

    const supabase = createClient()
    void supabase
      .from("shopping_items")
      .select(SHOPPING_ITEM_COLUMNS)
      .eq("household_id", householdId)
      .order("sort_order", { ascending: true })
      .abortSignal(abortController.signal)
      .then(({ data, error }) => {
        // abort は成功/失敗いずれの分岐にも入れない（spurious なログ・表示を防ぐ）
        if (abortController.signal.aborted) return
        if (generation !== fetchGenerationRef.current) return
        if (error) {
          logSupabaseError("shopping", "visibility refetch failed", error, {
            householdId,
          })
          return
        }
        if (data) setItems(data)
      })
  }, [householdId])

  useVisibilityRefetch(refetchItems)

  // アンマウント時に in-flight を畳む（フックはリスナのみを担うため、
  // AbortController のライフサイクルは所有者であるこの component 側に置く）
  useEffect(() => () => abortRef.current?.abort(), [])

  // ─── 楽観更新ハンドラ ──────────────────────────────────
  /**
   * 追加の楽観挿入。Realtime INSERT ハンドラ（上）と同じ id dedupe・末尾追加に
   * 揃える（どちらが先着しても二重表示にならない）。表示順は groupedUnchecked が
   * sort_order で並べ替えるため、末尾追加でも位置は崩れない。
   */
  const handleOptimisticAdd = useCallback((item: ShoppingItemData) => {
    setItems((prev) => {
      if (prev.some((i) => i.id === item.id)) return prev
      return [...prev, item]
    })
  }, [])

  /**
   * 「献立から追加」の楽観挿入。単発追加（handleOptimisticAdd）と同じ id dedupe・
   * 末尾追加に揃える。複数行を 1 回の setItems で入れるのは、行ごとに setItems を
   * 呼ぶと関数型更新の連鎖で無駄な再レンダーが積むため。
   */
  const handleOptimisticAddMany = useCallback((newItems: ShoppingItemData[]) => {
    setItems((prev) => {
      const existing = new Set(prev.map((i) => i.id))
      const fresh = newItems.filter((i) => !existing.has(i.id))
      if (fresh.length === 0) return prev
      return [...prev, ...fresh]
    })
  }, [])

  const handleOptimisticToggle = useCallback((id: string, isChecked: boolean) => {
    setItems((prev) =>
      prev.map((item) =>
        item.id === id
          ? {
              ...item,
              is_checked: isChecked,
              checked_at: isChecked ? new Date().toISOString() : null,
            }
          : item
      )
    )
  }, [])

  const handleOptimisticDelete = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id))
  }, [])

  /**
   * 削除失敗時の巻き戻し（トグルの巻き戻しと同じ流儀 = 直前の値へ戻す）。
   * 末尾へ戻しても表示位置は崩れない: 未チェックは sort_order、チェック済みは
   * checked_at の降順でソートし直されるため。
   */
  const handleRollbackDelete = useCallback((item: ShoppingItemData) => {
    setItems((prev) => {
      if (prev.some((i) => i.id === item.id)) return prev
      return [...prev, item]
    })
  }, [])

  // ─── フィルタ & グループ化 ─────────────────────────────
  const filteredItems = useMemo(() => {
    if (storeFilter === "all") return items
    return items.filter((item) => item.store_type === storeFilter)
  }, [items, storeFilter])

  const uncheckedItems = useMemo(
    () => filteredItems.filter((i) => !i.is_checked),
    [filteredItems]
  )

  const checkedItems = useMemo(
    () => filteredItems
      .filter((i) => i.is_checked)
      .sort((a, b) => (b.checked_at ?? "").localeCompare(a.checked_at ?? "")),
    [filteredItems]
  )

  const totalCount = filteredItems.length
  const remainingCount = uncheckedItems.length

  // カテゴリーごとにグループ化（未チェックのみ）
  const groupedUnchecked = useMemo(() => {
    const groups = new Map<ItemCategory, ShoppingItemData[]>()
    for (const item of uncheckedItems) {
      const list = groups.get(item.category) ?? []
      list.push(item)
      groups.set(item.category, list)
    }
    // 表示順に並べる
    const ordered: [ItemCategory, ShoppingItemData[]][] = []
    for (const cat of categoryDisplayOrder) {
      const list = groups.get(cat)
      if (list && list.length > 0) {
        // sort_order でソート
        list.sort((a, b) => a.sort_order - b.sort_order)
        ordered.push([cat, list])
      }
    }
    return ordered
  }, [uncheckedItems])

  // ─── チェック済み削除 ──────────────────────────────────
  const handleClearChecked = () => {
    startClearTransition(async () => {
      try {
        const result = await clearChecked()
        if (result.error) {
          toast.error(result.error)
        } else if (result.success) {
          // サーバが実際に消した id だけを state から落とす。revalidatePath は
          // マウント済みの useState には届かず、Realtime の DELETE はフィルタ付き
          // 購読では構造的に配信されぬ（公式 docs）。ここで落とさねば「削除した」
          // と告げたのに行が残る。
          // サーバが実際に消した id だけを state から落とす。revalidatePath は
          // マウント済みの useState には届かず、Realtime の DELETE はフィルタ付き
          // 購読では構造的に配信されぬ（公式 docs）。ここで落とさねば「削除した」
          // と告げたのに行が残る。
          if (result.removedIds) {
            const removed = new Set(result.removedIds)
            setItems((prev) => prev.filter((i) => !removed.has(i.id)))
          }
          toast.success(`${result.count}件のアイテムを削除しました`)
          setClearDialogOpen(false)
        }
      } catch (err) {
        // 楽観削除はしていないため巻き戻し不要。ダイアログも開いたままにして
        // 電波が戻ったら再試行できるようにする。
        toastOfflineError("[shopping-list] clearChecked", err)
      }
    })
  }

  return (
    <div className="flex flex-col gap-4 px-4 pt-12 pb-8">
      {/* ヘッダー */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">買い物リスト</h1>
        <span className="text-sm text-muted-foreground">
          残り {remainingCount} / {totalCount} 件
        </span>
      </div>

      {/* 追加フォーム */}
      <AddItemForm onAdded={handleOptimisticAdd} />

      {/* ストアタブ */}
      <Tabs
        value={storeFilter}
        onValueChange={(v) => setStoreFilter(v as StoreType | "all")}
      >
        <TabsList className="w-full overflow-x-auto">
          {storeTabs.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value} className="text-xs">
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* TabsContentは全タブで同じ中身（フィルターで切り替え） */}
        {storeTabs.map((tab) => (
          <TabsContent key={tab.value} value={tab.value}>
            <div className="flex flex-col gap-1 mt-2">
              {/* 未チェック（カテゴリーグループ） */}
              {groupedUnchecked.length === 0 && checkedItems.length === 0 && (
                <div className="flex min-h-[30dvh] items-center justify-center">
                  <p className="text-sm text-muted-foreground">
                    アイテムがありません
                  </p>
                </div>
              )}

              {groupedUnchecked.length === 0 &&
                checkedItems.length > 0 &&
                uncheckedItems.length === 0 && (
                  <div className="flex min-h-20 items-center justify-center">
                    <p className="text-sm text-muted-foreground">
                      全てチェック済みです
                    </p>
                  </div>
                )}

              {groupedUnchecked.map(([category, categoryItems]) => {
                const Icon = categoryIcons[category]
                return (
                  <div key={category}>
                    {/* カテゴリーヘッダー */}
                    <div className="flex items-center gap-2 px-1 pt-3 pb-1">
                      <Icon
                        size={14}
                        className="text-muted-foreground"
                      />
                      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        {getCategoryLabel(category)}
                      </span>
                    </div>

                    {/* アイテム一覧 */}
                    <div className="glass rounded-2xl shadow-lg shadow-black/[0.04] divide-y divide-border/30">
                      {categoryItems.map((item) => (
                        <ShoppingItem
                          key={item.id}
                          item={item}
                          checkedByName={
                            item.checked_by
                              ? memberMap.get(item.checked_by) ?? null
                              : null
                          }
                          onOptimisticToggle={handleOptimisticToggle}
                          onOptimisticDelete={handleOptimisticDelete}
                          onRollbackDelete={handleRollbackDelete}
                        />
                      ))}
                    </div>
                  </div>
                )
              })}

              {/* チェック済みセクション（折り畳み） */}
              {checkedItems.length > 0 && (
                <div className="mt-4">
                  <button
                    type="button"
                    onClick={() => setCheckedExpanded(!checkedExpanded)}
                    className="flex w-full min-h-11 items-center gap-2 rounded-xl px-3 py-2 text-sm text-muted-foreground transition-colors duration-200 hover:bg-accent/50"
                  >
                    {checkedExpanded ? (
                      <ChevronDown size={16} />
                    ) : (
                      <ChevronRight size={16} />
                    )}
                    <span className="font-medium">
                      チェック済み ({checkedItems.length}件)
                    </span>
                  </button>

                  {checkedExpanded && (
                    <div className="glass rounded-2xl shadow-lg shadow-black/[0.04] mt-1 divide-y divide-border/30">
                      {checkedItems.map((item) => (
                          <ShoppingItem
                            key={item.id}
                            item={item}
                            checkedByName={
                              item.checked_by
                                ? memberMap.get(item.checked_by) ?? null
                                : null
                            }
                            onOptimisticToggle={handleOptimisticToggle}
                            onOptimisticDelete={handleOptimisticDelete}
                            onRollbackDelete={handleRollbackDelete}
                          />
                        ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </TabsContent>
        ))}
      </Tabs>

      {/* アクションボタン */}
      <div className="flex items-center gap-2 mt-2">
        <GenerateFromMeals onAdded={handleOptimisticAddMany} />

        <Dialog open={clearDialogOpen} onOpenChange={setClearDialogOpen}>
          <DialogTrigger
            render={
              <Button
                variant="outline"
                size="lg"
                className="cursor-pointer flex-1"
                disabled={checkedItems.length === 0}
              />
            }
          >
            <Trash2 size={16} />
            チェック済みを削除
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>チェック済みアイテムを削除</DialogTitle>
              <DialogDescription>
                チェック済みの{checkedItems.length}
                件のアイテムを削除します。購入履歴に記録されます。この操作は取り消せません。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose
                render={
                  <Button
                    variant="outline"
                    className="cursor-pointer"
                  />
                }
              >
                キャンセル
              </DialogClose>
              <Button
                variant="destructive"
                onClick={handleClearChecked}
                disabled={isClearPending}
                className="cursor-pointer"
              >
                {isClearPending ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Trash2 size={16} />
                )}
                削除する
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}
