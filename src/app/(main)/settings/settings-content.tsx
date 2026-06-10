"use client"

import { useState, useTransition } from "react"
import {
  Home,
  LogOut,
  Loader2,
} from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { signOut } from "@/app/(main)/settings/actions"
import {
  purgeHouseholdCaches,
  LAST_USER_ID_STORAGE_KEY,
} from "@/lib/pwa/sw-messages"
import { ProfileCard } from "@/components/settings/profile-card"
import { InviteCard } from "@/components/settings/invite-card"
import { ApprovalCard, type PendingUser } from "@/components/settings/approval-card"
import { DefaultPageCard } from "@/components/settings/default-page-card"
import { AutoStockCategoriesCard } from "@/components/settings/auto-stock-card"
import { BabyProfileCard } from "@/components/settings/baby-profile-card"
import { ExportCard } from "@/components/settings/export-card"
import { ThemeCard } from "@/components/settings/theme-card"
import type { HouseholdRole } from "@/lib/types/database"

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
  babyProfile: {
    name: string | null
    birthDate: string | null
  }
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
  babyProfile,
}: SettingsContentProps) {
  const [, startTransition] = useTransition()
  const [isSigningOut, setIsSigningOut] = useState(false)

  const handleSignOut = () => {
    setIsSigningOut(true)
    startTransition(async () => {
      // signOut() の redirect は throw ベースのため、後続コードは実行保証がない。
      // 世帯キャッシュ破棄と localStorage 掃除は必ず signOut() より前に行う。
      await purgeHouseholdCaches()
      try {
        localStorage.removeItem(LAST_USER_ID_STORAGE_KEY)
      } catch (err) {
        console.warn("[settings] localStorage の削除に失敗:", err)
      }
      await signOut()
    })
  }

  return (
    <div className="flex flex-col gap-6 px-4 pt-12 pb-8">
      <h1 className="text-xl font-bold">設定</h1>

      {/* プロフィール */}
      <ProfileCard profile={profile} email={email} />

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

      {/* 赤ちゃん情報 */}
      <BabyProfileCard initialProfile={babyProfile} />

      {/* 記録エクスポート */}
      <ExportCard />

      {/* テーマ */}
      <ThemeCard />

      {/* 招待 */}
      <InviteCard />

      {/* 承認管理（ownerのみ） */}
      {profile.role === "owner" && pendingUsers.length > 0 && (
        <ApprovalCard pendingUsers={pendingUsers} />
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
