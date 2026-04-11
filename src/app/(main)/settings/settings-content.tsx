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
  ShieldCheck,
  UserPlus,
  LayoutDashboard,
  Sun,
  Moon,
  Monitor,
  Package,
} from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import {
  updateProfile,
  updateDefaultPage,
  updateAutoStockCategories,
  generateInvite,
  approveUser,
  signOut,
} from "./actions"
import { useTheme } from "@/lib/hooks/use-theme"
import { segmentCn } from "@/lib/utils/segment-cn"
import { getCategoryLabel } from "@/lib/utils/categories"
import type { HouseholdRole, ItemCategory } from "@/lib/types/database"

interface PendingUser {
  id: string
  display_name: string
  email: string
  created_at: string
}

const PAGE_OPTIONS = [
  { value: "meals", label: "献立" },
  { value: "shopping", label: "買い物" },
  { value: "stock", label: "在庫" },
  { value: "baby", label: "育児" },
] as const

interface SettingsContentProps {
  profile: {
    id: string
    displayName: string
    avatarUrl: string | null
    role: HouseholdRole
    defaultPage: string
  }
  household: {
    id: string
    name: string
  } | null
  email: string
  pendingUsers: PendingUser[]
  autoStockCategories: string[]
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
  pendingUsers,
  autoStockCategories,
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

      {/* デフォルトページ */}
      <DefaultPageCard defaultPage={profile.defaultPage} />

      {/* 在庫自動追加 */}
      <AutoStockCategoriesCard initialCategories={autoStockCategories} />

      {/* テーマ */}
      <ThemeCard />

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

      {/* 承認管理（ownerのみ） */}
      {profile.role === "owner" && pendingUsers.length > 0 && (
        <Card className="glass">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck size={18} />
              承認待ち
              <span className="ml-auto rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600">
                {pendingUsers.length}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {pendingUsers.map((pendingUser) => (
              <PendingUserRow key={pendingUser.id} user={pendingUser} />
            ))}
          </CardContent>
        </Card>
      )}

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

const THEME_OPTIONS = [
  { value: "light" as const, label: "ライト", icon: Sun },
  { value: "dark" as const, label: "ダーク", icon: Moon },
  { value: "system" as const, label: "システム", icon: Monitor },
]

function ThemeCard() {
  const { theme, setTheme } = useTheme()

  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sun size={18} />
          テーマ
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex gap-1 rounded-xl bg-muted/50 p-1">
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setTheme(opt.value)}
              className={segmentCn(theme === opt.value)}
            >
              <opt.icon size={14} className="mr-1 inline-block" />
              {opt.label}
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function DefaultPageCard({ defaultPage }: { defaultPage: string }) {
  const [selected, setSelected] = useState(defaultPage)
  const [isPending, startTransition] = useTransition()

  function handleSelect(page: string) {
    setSelected(page)
    startTransition(async () => {
      const result = await updateDefaultPage(page)
      if (result.error) {
        toast.error(result.error)
        setSelected(defaultPage)
      }
    })
  }

  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LayoutDashboard size={18} />
          起動時のページ
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex gap-1 rounded-xl bg-muted/50 p-1">
          {PAGE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => handleSelect(opt.value)}
              disabled={isPending}
              className={segmentCn(selected === opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

const AUTO_STOCK_OPTIONS: { value: ItemCategory; label: string }[] = [
  { value: "baby", label: getCategoryLabel("baby") },
  { value: "cleaning", label: getCategoryLabel("cleaning") },
  { value: "hygiene", label: getCategoryLabel("hygiene") },
  { value: "other_daily", label: getCategoryLabel("other_daily") },
]

function AutoStockCategoriesCard({
  initialCategories,
}: {
  initialCategories: string[]
}) {
  const [selected, setSelected] = useState<Set<string>>(
    new Set(initialCategories),
  )
  const [isPending, startTransition] = useTransition()

  function handleToggle(category: ItemCategory) {
    const next = new Set(selected)
    if (next.has(category)) {
      next.delete(category)
    } else {
      next.add(category)
    }
    setSelected(next)

    startTransition(async () => {
      const result = await updateAutoStockCategories(
        [...next] as ItemCategory[],
      )
      if (result.error) {
        toast.error(result.error)
        setSelected(new Set(initialCategories))
      }
    })
  }

  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Package size={18} />
          在庫自動追加
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          買い物リストでチェックした時に、以下のカテゴリは在庫に自動追加されます。
        </p>
        <div className="grid grid-cols-2 gap-2">
          {AUTO_STOCK_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => handleToggle(opt.value)}
              disabled={isPending}
              className={cn(
                "flex min-h-11 items-center justify-center rounded-xl px-3 py-2 text-sm font-medium transition-colors duration-200",
                selected.has(opt.value)
                  ? "bg-primary/10 text-primary ring-1 ring-primary/20"
                  : "bg-muted/50 text-muted-foreground",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function PendingUserRow({ user }: { user: PendingUser }) {
  const router = useRouter()
  const [isApproving, setIsApproving] = useState(false)

  async function handleApprove() {
    setIsApproving(true)
    const result = await approveUser(user.id)
    if (result.error) {
      toast.error(result.error)
      setIsApproving(false)
    } else {
      toast.success(`${user.email} を承認しました`)
      router.refresh()
    }
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-3 overflow-hidden">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
          <UserPlus size={16} className="text-muted-foreground" />
        </div>
        <div className="overflow-hidden">
          <p className="truncate text-sm font-medium">
            {user.display_name || user.email}
          </p>
          {user.display_name && (
            <p className="truncate text-xs text-muted-foreground">
              {user.email}
            </p>
          )}
        </div>
      </div>
      <Button
        size="sm"
        onClick={handleApprove}
        disabled={isApproving}
        className="shrink-0 cursor-pointer"
      >
        {isApproving ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          "承認"
        )}
      </Button>
    </div>
  )
}
