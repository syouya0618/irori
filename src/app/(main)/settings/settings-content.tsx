"use client"

import { useState, useTransition, useRef, useEffect } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  User,
  Home,
  Link2,
  LogOut,
  ClipboardCopy,
  Check,
  Loader2,
} from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { updateProfile, generateInvite, signOut } from "./actions"
import type { HouseholdRole } from "@/lib/types/database"

interface SettingsContentProps {
  profile: {
    id: string
    displayName: string
    avatarUrl: string | null
    role: HouseholdRole
  }
  household: {
    id: string
    name: string
  } | null
  email: string
}

const roleLabels: Record<HouseholdRole, string> = {
  owner: "オーナー",
  member: "メンバー",
  viewer: "閲覧者",
}

export function SettingsContent({
  profile,
  household,
  email,
}: SettingsContentProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isSigningOut, setIsSigningOut] = useState(false)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>(null)

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
    }
  }, [])

  const handleUpdateProfile = (formData: FormData) => {
    startTransition(async () => {
      const result = await updateProfile(formData)
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success("プロフィールを更新しました")
        router.refresh()
      }
    })
  }

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

  const handleSignOut = () => {
    setIsSigningOut(true)
    startTransition(async () => {
      await signOut()
    })
  }

  return (
    <div className="flex flex-col gap-6 px-4 pt-12 pb-8">
      <h1 className="text-xl font-bold">設定</h1>

      {/* プロフィール */}
      <Card className="glass">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <User size={18} />
            プロフィール
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form action={handleUpdateProfile} className="flex flex-col gap-4">
            {/* アバタープレースホルダー */}
            <div className="flex items-center gap-4">
              <div className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
                <User size={28} />
              </div>
              <div className="flex flex-col gap-0.5">
                <p className="text-sm font-medium">{profile.displayName || "未設定"}</p>
                <p className="text-xs text-muted-foreground">{email}</p>
              </div>
            </div>

            <Separator />

            <div className="flex flex-col gap-2">
              <Label htmlFor="display_name">表示名</Label>
              <Input
                id="display_name"
                name="display_name"
                defaultValue={profile.displayName}
                placeholder="表示名を入力"
                required
                className="h-10"
              />
            </div>

            <Button
              type="submit"
              size="lg"
              disabled={isPending}
              className="cursor-pointer self-end"
            >
              {isPending ? (
                <Loader2 size={16} className="animate-spin" />
              ) : null}
              保存
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* 世帯情報 */}
      <Card className="glass">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Home size={18} />
            世帯
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-0.5">
              <p className="text-sm font-medium">
                {household?.name || "世帯名未設定"}
              </p>
              <p className="text-xs text-muted-foreground">
                あなたの役割: {roleLabels[profile.role]}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 招待 */}
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
                  className="h-10 flex-1 text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon-lg"
                  onClick={handleCopy}
                  className="shrink-0 cursor-pointer"
                  aria-label="招待リンクをコピー"
                >
                  {copied ? (
                    <Check size={16} />
                  ) : (
                    <ClipboardCopy size={16} />
                  )}
                </Button>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleGenerateInvite}
                disabled={isGenerating}
                className="cursor-pointer self-start"
              >
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

      {/* ログアウト */}
      <Separator />

      <Button
        type="button"
        variant="ghost"
        size="lg"
        onClick={handleSignOut}
        disabled={isSigningOut}
        className="cursor-pointer text-destructive hover:text-destructive"
      >
        {isSigningOut ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <LogOut size={16} />
        )}
        ログアウト
      </Button>
    </div>
  )
}
