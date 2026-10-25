"use client"

import { useState, useRef, useEffect } from "react"
import { toast } from "sonner"
import { Link2, ClipboardCopy, Check, Loader2 } from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { generateInvite } from "@/app/(main)/settings/actions"

export function InviteCard() {
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>(null)

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
    }
  }, [])

  const handleGenerateInvite = async () => {
    setIsGenerating(true)
    try {
      const result = await generateInvite()
      if (result.error) {
        toast.error(result.error)
      } else if (result.url) {
        setInviteUrl(result.url)
        toast.success("招待リンクを生成しました")
      }
    } catch {
      toast.error("招待リンクの生成に失敗しました")
    } finally {
      setIsGenerating(false)
    }
  }

  const handleCopy = async () => {
    if (!inviteUrl) return
    try {
      await navigator.clipboard.writeText(inviteUrl)
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
      setCopied(true)
      toast.success("コピーしました")
      copiedTimerRef.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error("コピーに失敗しました")
    }
  }

  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 size={18} />
          メンバー招待
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          招待リンクを共有して、家族をこの世帯に招待できます。リンクは7日間有効です。
        </p>

        {inviteUrl ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Input
                value={inviteUrl}
                readOnly
                aria-label="招待リンク"
                onFocus={(e) => e.currentTarget.select()}
                className="h-11 flex-1 text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="lg"
                onClick={handleCopy}
                className="shrink-0 cursor-pointer"
                aria-label="招待リンクをコピー"
              >
                {copied ? (
                  <Check size={16} />
                ) : (
                  <ClipboardCopy size={16} />
                )}
                {copied ? "コピー済み" : "コピー"}
              </Button>
            </div>
            {/* generateInvite は新しい行を足すだけで、前のリンクを失効させぬ（実装を確認済み）。
                「作り直せば前のは使えぬ」と誤解させぬよう事実を書く */}
            {/* accept_invitation は承認と所属を同時に立てる（20261002100001 の注記）ゆえ
                運用者の承認は要らぬ。既に別の世帯に入っておる人は参加できぬ。
                受諾で status='accepted' になり 2 人目は弾かれる（20260408000002）＝ 1 リンク 1 人 */}
            <p className="text-xs text-muted-foreground">
              1 つのリンクで参加できるのは 1 人です（運用者の承認は不要、別の世帯に入っている人は不可）。
              新しいリンクを作っても、前のリンクは期限まで使えます。
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleGenerateInvite}
              disabled={isGenerating}
              className="cursor-pointer self-start"
            >
              {isGenerating && <Loader2 size={14} className="animate-spin" />}
              新しいリンクを生成
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="lg"
            onClick={handleGenerateInvite}
            disabled={isGenerating}
            className="cursor-pointer"
          >
            {isGenerating ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Link2 size={16} />
            )}
            招待リンクを生成
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
