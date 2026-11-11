import { AlertCircle, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"

/**
 * 編集フォームを開いた（最初に触った）後に、対象が変更されたときの知らせ。
 *
 * ごはんの編集フォーム（設定のカード・買い物の量／メモ／手動の項目）は、入力を始めた時点の版を固定して送る。
 * 入力の途中で対象の版が進んだら（定期の再取得・画面への復帰・ほかの操作の応答で届く）、古い入力に
 * 新しい版を付けて送らない — 付けると DB の版の照合が素通りし、家族の変更を古い入力で黙って巻き戻す。
 * 保存を止めてこの知らせを出し、最新の内容を読み込み直してから入力し直してもらう
 * （上書き保存の道は置かない。掃除の項目の編集 `cleaning-routine-form.tsx` と同じ流儀）。
 *
 * 境界指令を持たない（Client Component の中から描く）。
 */
export function ChangedElsewhereNotice({
  what,
  ownChangePossible = false,
  onReload,
}: {
  /** 何が変わったか（「この項目」「設定」）。 */
  what: string
  /**
   * true = この端末の別の操作（献立からの更新など）でも版が進みうる対象。
   * 他の端末の変更と見分けられないので、そのとおりに言う。
   */
  ownChangePossible?: boolean
  /** 最新の内容を読み込み直す（入力は最新の値で作り直す）。 */
  onReload: () => void
}) {
  return (
    <div
      role="alert"
      data-testid="changed-elsewhere"
      className="flex flex-col gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3"
    >
      <p className="flex items-start gap-2 text-sm text-foreground">
        <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
        <span className="min-w-0 break-words">
          {what}は、入力を始めた後に他の端末で変更されました
          {ownChangePossible && "（この端末の別の操作で変わった場合も含みます）"}
          。入力を始めた時の内容のままでは保存できません（家族の変更を上書きしないためです）。最新の内容を読み込んでから、もう一度入力してください。
        </span>
      </p>
      <Button type="button" variant="outline" className="self-start" onClick={onReload}>
        <RefreshCw aria-hidden="true" />
        最新の内容を読み込む
      </Button>
      <p className="text-sm text-muted-foreground">読み込むと、いま入力している内容は最新の内容に置き換わります。</p>
    </div>
  )
}
