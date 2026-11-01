"use client"

import { useChildScope } from "./child-scope"

import { useEffect, useId, useRef, useState, useTransition } from "react"
import { NumberField } from "@base-ui/react/number-field"
import { AlertCircle, Loader2, Minus, Plus } from "lucide-react"
import { toast } from "sonner"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { updateBottleDefault } from "@/app/(main)/baby/actions"
// startTransition 内の未処理 reject は error boundary へ bubble する。
// 圏外タップで全画面エラー化しないよう握ってトーストへ倒す（詳細は offline-error.ts）。
import { toastOfflineError } from "@/lib/utils/offline-error"
import {
  BOTTLE_DEFAULT_MAX_ML,
  BOTTLE_DEFAULT_MIN_ML,
  BOTTLE_DEFAULT_RANGE_ERROR,
  BOTTLE_DEFAULT_STEP_ML,
  formatBottleAmount,
  isBottleDefaultMl,
} from "@/lib/domain/bottle-default"

/**
 * - `record`: 未設定のまま「ミルク」を押して開いた。保存が通ったら、その量で今回のミルクも記録する
 *   （押した目的は記録じゃ。保存だけで閉じると「記録したつもりで記録されておらぬ」を作る）
 * - `save`: 「ミルクの量を変更」から開いた。保存だけ（次の記録から効く）
 */
export type BottleDefaultSheetIntent = "record" | "save"

interface BottleDefaultSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  intent: BottleDefaultSheetIntent
  /**
   * 開いた時点のいつもの量（未設定なら null）。**マウント時の値だけを使う**（親が開くたびに
   * key で作り直す前提）。入力の初期値と、保存時に「この量を見て変えた」と送る値になる。
   * 開いている間に別の端末の変更が届いても黙って差し替えぬ — 見ていない量を上書きせぬよう、
   * 保存は衝突として返り、そこで今の量を見せる。
   */
  initialAmountMl: number | null
  /**
   * 保存できた量。親はいつもの量へ反映し、シートを閉じ、`record` なら記録する。保存の通信中に
   * 閉じられていた（開き直された）時は、反映だけして記録はせぬのが親の責務
   */
  onSaved: (amountMl: number, intent: BottleDefaultSheetIntent) => void
  /** 保存が衝突した時の DB の今の量（null は未設定）。親は表示をこの量へ揃える */
  onConflict: (currentMl: number | null) => void
}

const STEP_BUTTON =
  "flex size-14 shrink-0 items-center justify-center rounded-xl border bg-background transition-colors duration-200 hover:bg-muted active:bg-muted disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"

/**
 * いつものミルク量を決める・変えるシート。量の入力は Base UI の Number Field（増減ボタン・
 * 数値入力・支援技術向けの役割を備える既存部品）に任せ、自作のステッパーは持たぬ。
 *
 * 入力欄の範囲外の値は**丸めずに**受け、保存の時に domain の検証（1〜999 の整数）で止める。
 * 部品の clamp に任せると、1000 と打って保存した量が黙って 999 になる（利用者の見た値と
 * 保存した値が食い違う）。増減ボタンは範囲内に収まる（部品の既定）。
 *
 * 送信は `<form action>` を使わず onSubmit で受ける（React 19 の form auto-reset を避け、
 * Enter / キーボードの「開く」でも保存できるようにする）。
 */
export function BottleDefaultSheet({
  open,
  onOpenChange,
  intent,
  initialAmountMl,
  onSaved,
  onConflict,
}: BottleDefaultSheetProps) {
  const childScope = useChildScope()
  const childId = childScope?.id
  const inputId = useId()
  const errorId = useId()
  const [value, setValue] = useState<number | null>(initialAmountMl)
  // 保存時に「この量を見て変えた」と送る値。衝突したら DB の今の量へ進める（次の保存は
  // 今の量を見たうえでの意図した変更になる）
  const [expectedMl, setExpectedMl] = useState<number | null>(initialAmountMl)
  const [error, setError] = useState<string | null>(null)
  // 衝突で分かった今の量（undefined = 衝突していない）。null は「未設定に戻されていた」
  const [conflictMl, setConflictMl] = useState<number | null | undefined>(undefined)
  const [isPending, startTransition] = useTransition()
  /**
   * いま開いておるか（保存の応答が届いた時点の値）。保存中でも閉じられるゆえ、閉じた後に返った
   * 失敗・衝突はシートの中に出しても誰も見ぬ — トーストで知らせる。このインスタンスは開き直しで
   * 作り直される（親の key）ゆえ、一度閉じたら開いた状態へは戻らぬ
   */
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
  }, [open])

  function handleSave() {
    // 部品の値を信用しきらず、送る直前に契約の範囲で確かめる
    if (!isBottleDefaultMl(value)) {
      setError(BOTTLE_DEFAULT_RANGE_ERROR)
      return
    }
    const amountMl = value
    setError(null)
    startTransition(async () => {
      try {
        const result = await updateBottleDefault({ ...(childId ? { childId } : {}), amountMl, expectedMl })
        if (result.ok) {
          onSaved(result.amountMl, intent)
          return
        }
        if (result.conflict) {
          // 入力した量はそのまま残す。上書きはしておらぬ（記録もせぬ）
          setExpectedMl(result.conflict.currentMl)
          setConflictMl(result.conflict.currentMl)
          onConflict(result.conflict.currentMl)
          if (!openRef.current) {
            toast.error(
              result.conflict.currentMl === null
                ? "いつものミルク量は別の端末で未設定に戻されていたため、保存しませんでした"
                : `いつものミルク量は別の端末で先に${formatBottleAmount(result.conflict.currentMl)}へ変更されていたため、保存しませんでした`,
            )
          }
          return
        }
        setError(result.error)
        if (!openRef.current) toast.error(result.error)
      } catch (err) {
        toastOfflineError("[bottle-default-sheet] updateBottleDefault", err)
      }
    })
  }

  const saveLabel = intent === "record" ? "保存して記録する" : "保存する"

  return (
    // 保存中でも閉じられる（モーダルゆえ、詰まった保存の間に閉じ込めると画面全体が止まる）。
    // 閉じた後に保存が通った時は、親が量だけ反映して記録はせぬ（baby-quick-actions の handleBottleSaved）
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[85dvh] overflow-hidden rounded-t-2xl safe-bottom"
      >
        {/* noValidate: Number Field は隠し input に min/max/step を載せる。step の起点は min（1）ゆえ
            ブラウザの制約検証は 160 を「1, 11, 21… でない」と弾き、保存が無反応になる。検証は
            handleSave の domain 検証（1〜999 の整数）が一手に持つ */}
        <form
          noValidate
          className="flex min-h-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (!isPending) handleSave()
          }}
        >
          <SheetHeader className="pb-0">
            <SheetTitle>いつものミルク量</SheetTitle>
            <SheetDescription>
              {intent === "record"
                ? "「ミルク」を押した時に記録する量です。保存すると、今回のミルクもこの量で記録します。"
                : "次の記録からこの量で記録します。これまでの記録の量は変わりません。"}
              家族の端末にも反映されます。
            </SheetDescription>
          </SheetHeader>

          <div className="flex flex-col gap-3 overflow-y-auto px-4">
            {/* 衝突。書いた人は断定しない（応答を失った自分の保存・同じ利用者の別端末も同じ形） */}
            {conflictMl !== undefined && (
              <div
                role="alert"
                className="flex flex-col gap-1 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm"
              >
                <p className="flex items-start gap-2 font-medium text-destructive">
                  <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                  {conflictMl === null
                    ? "いつものミルク量は別の端末で未設定に戻されていました（家族またはご自身）"
                    : `いつものミルク量は別の端末で先に${formatBottleAmount(conflictMl)}へ変更されていました（家族またはご自身）`}
                </p>
                <p className="text-xs text-muted-foreground">
                  {intent === "record"
                    ? "まだ何も記録していません。入力した量でよければもう一度押してください。"
                    : "入力した量はそのまま残しています。この量でよければもう一度保存してください。"}
                </p>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <label htmlFor={inputId} className="text-sm font-medium">
                1回の量（ml）
              </label>
              <NumberField.Root
                id={inputId}
                value={value}
                onValueChange={(next, details) => {
                  // 空欄から「増やす」を押すと部品は min（1）から数え、1, 11, 21… と半端な量へ
                  // 進む。最初の一押しは増減幅（10ml）にして、切りのよい量から数えさせる
                  const fromEmpty =
                    value === null && next !== null && details.reason === "increment-press"
                  setValue(fromEmpty ? BOTTLE_DEFAULT_STEP_ML : next)
                  setError(null)
                }}
                min={BOTTLE_DEFAULT_MIN_ML}
                max={BOTTLE_DEFAULT_MAX_ML}
                step={BOTTLE_DEFAULT_STEP_ML}
                allowOutOfRange
                locale="ja-JP"
                disabled={isPending}
              >
                <NumberField.Group className="flex items-center gap-2">
                  <NumberField.Decrement
                    aria-label={`${BOTTLE_DEFAULT_STEP_ML}ml減らす`}
                    className={STEP_BUTTON}
                  >
                    <Minus size={20} aria-hidden="true" />
                  </NumberField.Decrement>
                  <div className="relative min-w-0 flex-1">
                    <NumberField.Input
                      placeholder="未設定"
                      aria-invalid={error !== null || undefined}
                      aria-describedby={error !== null ? errorId : undefined}
                      className="h-14 w-full rounded-xl border border-input bg-transparent pr-10 pl-3 text-center text-2xl font-semibold tabular-nums transition-colors duration-200 outline-none placeholder:text-base placeholder:font-normal placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring disabled:opacity-50 aria-invalid:border-destructive dark:bg-input/30"
                    />
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-base text-muted-foreground"
                    >
                      ml
                    </span>
                  </div>
                  <NumberField.Increment
                    aria-label={`${BOTTLE_DEFAULT_STEP_ML}ml増やす`}
                    className={STEP_BUTTON}
                  >
                    <Plus size={20} aria-hidden="true" />
                  </NumberField.Increment>
                </NumberField.Group>
              </NumberField.Root>
              {error !== null && (
                <p id={errorId} role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </div>
          </div>

          <SheetFooter>
            <Button type="submit" disabled={isPending} className="min-h-12 w-full text-base">
              {isPending ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden="true" />
                  保存中...
                </>
              ) : (
                saveLabel
              )}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
