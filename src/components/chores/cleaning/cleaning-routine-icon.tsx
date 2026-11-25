import { Bath, BrushCleaning, Fan, PanelsTopLeft, Toilet, Utensils, WashingMachine, type LucideIcon } from "lucide-react"

const ICONS: readonly [RegExp, LucideIcon][] = [
  [/換気扇|レンジフード|エアコン|フィルター|フィルタ/, Fan],
  [/トイレ|便器/, Toilet],
  [/洗濯|洗たく/, WashingMachine],
  [/窓|網戸|サッシ/, PanelsTopLeft],
  [/風呂|浴室|浴槽|洗面/, Bath],
  [/キッチン|台所|コンロ|シンク|冷蔵庫/, Utensils],
  [/床|掃き|掃除機|玄関/, BrushCleaning],
]

/** 見分けるための装飾。名前を優先し、自由入力に合う絵柄が無ければ共通のブラシを使う。 */
export function CleaningRoutineIcon({
  name,
  location,
  className,
  size = 24,
}: {
  name: string
  location?: string | null
  className?: string
  size?: number
}) {
  const Icon = ICONS.find(([pattern]) => pattern.test(name))?.[1]
    ?? ICONS.find(([pattern]) => pattern.test(location ?? ""))?.[1]
    ?? BrushCleaning
  return <Icon size={size} className={className} aria-hidden="true" />
}
