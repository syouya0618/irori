"use client"

import { ScanText } from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  useOcrProvider,
  type OcrProviderSetting,
} from "@/lib/hooks/use-ocr-provider"
import { segmentCn } from "@/lib/utils/segment-cn"

const OPTIONS: { value: OcrProviderSetting; label: string; note: string }[] = [
  {
    value: "manual",
    label: "手入力",
    note: "レシートを見ながら手で入力します。",
  },
  {
    value: "tesseract",
    label: "端末内",
    note: "写真を端末内で解析します。外部送信なし・費用ゼロ。精度は控えめです。",
  },
  {
    value: "google-vision",
    label: "クラウド",
    note: "写真を Google Vision で高精度に解析します。画像が外部に送信され、APIキーの設定が必要です。",
  },
]

export function OcrProviderCard() {
  const [provider, setProvider] = useOcrProvider()
  const selected = OPTIONS.find((o) => o.value === provider) ?? OPTIONS[1]

  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ScanText size={18} />
          レシート読み取り
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex gap-1 rounded-xl bg-muted/50 p-1">
          {OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setProvider(opt.value)}
              className={segmentCn(provider === opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="px-1 text-xs text-muted-foreground">{selected.note}</p>
      </CardContent>
    </Card>
  )
}
