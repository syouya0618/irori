import { Minus, Plus } from "lucide-react"
import { BREAST_COUNT_MAX } from "@/lib/domain/feeding"

/**
 * 母乳サイクルの片側（左 or 右）の吸わせ回数ステッパー。タイマーの手動入力と
 * 記録の編集シートが共有する（同じ「左右の回数」を数える操作を、記録直後と編集で
 * 別物に見せぬため。以前は 2 つの複製が「両方を揃えて直すこと」の注記で結ばれていた）。
 *
 * 授乳中の片手操作を前提に、自由入力ではなく ±ボタン（44px 以上: min-h-11 / min-w-11）で
 * 数える。境界（0 と BREAST_COUNT_MAX）ではボタン自体を disabled にする。値の丸めは
 * 呼び出し側の状態更新が `clampBreastCount` で行う（表示と送信値が食い違わぬ二重化）。
 *
 * `onStep` は増減（+1 / -1）を渡す。呼び出し側は関数型の状態更新で足せば、
 * 描画の前に二度押されても取りこぼさぬ。
 */
export function BreastCountStepper({
  label,
  value,
  disabled,
  onStep,
}: {
  label: string
  value: number
  disabled: boolean
  onStep: (delta: 1 | -1) => void
}) {
  const buttonCn =
    "flex min-h-11 min-w-11 items-center justify-center rounded-xl border bg-background transition-colors duration-200 hover:bg-muted active:bg-muted disabled:opacity-50"
  return (
    <div className="flex flex-1 flex-col items-center gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={`${label}の回数を1減らす`}
          onClick={() => onStep(-1)}
          disabled={disabled || value <= 0}
          className={buttonCn}
        >
          <Minus size={18} />
        </button>
        {/* output は暗黙で role="status" ゆえ、増減が支援技術へも読み上げられる */}
        <output
          aria-label={`${label}の回数`}
          className="w-8 text-center text-2xl font-bold tabular-nums"
        >
          {value}
        </output>
        <button
          type="button"
          aria-label={`${label}の回数を1増やす`}
          onClick={() => onStep(1)}
          disabled={disabled || value >= BREAST_COUNT_MAX}
          className={buttonCn}
        >
          <Plus size={18} />
        </button>
      </div>
    </div>
  )
}
