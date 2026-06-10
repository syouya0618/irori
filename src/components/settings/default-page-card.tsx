"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import { LayoutDashboard } from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { updateDefaultPage } from "@/app/(main)/settings/actions"
import { segmentCn } from "@/lib/utils/segment-cn"

const PAGE_OPTIONS = [
  { value: "meals", label: "献立" },
  { value: "shopping", label: "買い物" },
  { value: "stock", label: "在庫" },
  { value: "baby", label: "育児" },
] as const

export function DefaultPageCard({ defaultPage }: { defaultPage: string }) {
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
