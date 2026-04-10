"use client"

import { useState, useEffect, useTransition } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Loader2, Trash2, BookOpen } from "lucide-react"
import { toast } from "sonner"
import {
  getTemplates,
  loadTemplate,
  deleteTemplate,
} from "@/app/(main)/meals/actions"
import { SuggestionListInDialog } from "@/components/meals/suggestion-list-in-dialog"
import type { TemplateIngredient } from "@/lib/domain"

interface Template {
  id: string
  title: string
  ingredients: unknown
  created_at: string
}

interface TemplateSelectorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (data: { title: string; ingredients: TemplateIngredient[] }) => void
}

type TabValue = "templates" | "suggestions"

export function TemplateSelector({
  open,
  onOpenChange,
  onSelect,
}: TemplateSelectorProps) {
  const [templates, setTemplates] = useState<Template[]>([])
  const [hasLoaded, setHasLoaded] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [activeTab, setActiveTab] = useState<TabValue>("templates")

  // isLoading は derived state（useEffect 内での setState を避ける）
  const isLoading = open && !hasLoaded

  useEffect(() => {
    if (!open || hasLoaded) return
    getTemplates().then((result) => {
      if (result.error) {
        toast.error(result.error)
      } else {
        setTemplates(result.data)
      }
      setHasLoaded(true)
    })
  }, [open, hasLoaded])

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      // ダイアログを閉じたらタブと読み込み状態をリセット
      setActiveTab("templates")
      setHasLoaded(false)
    }
    onOpenChange(nextOpen)
  }

  function handleSelect(templateId: string) {
    startTransition(async () => {
      const result = await loadTemplate(templateId)
      if (result.error) {
        toast.error(result.error)
        return
      }
      if (result.data) {
        onSelect(result.data)
        handleOpenChange(false)
      }
    })
  }

  function handleSuggestionSelect(data: {
    title: string
    ingredients: TemplateIngredient[]
  }) {
    onSelect(data)
    handleOpenChange(false)
  }

  function handleDelete(e: React.MouseEvent, templateId: string) {
    e.stopPropagation()
    startTransition(async () => {
      const result = await deleteTemplate(templateId)
      if (result.error) {
        toast.error(result.error)
        return
      }
      setTemplates((prev) => prev.filter((t) => t.id !== templateId))
      toast.success("テンプレートを削除しました")
    })
  }

  function getIngredientCount(ingredients: unknown): number {
    if (Array.isArray(ingredients)) {
      return ingredients.length
    }
    return 0
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[75dvh] overflow-hidden">
        <DialogHeader>
          <DialogTitle>テンプレートから作成</DialogTitle>
          <DialogDescription>
            {activeTab === "templates"
              ? "保存済みのテンプレートを選択してください"
              : "在庫に合ったおすすめ献立を選択してください"}
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as TabValue)}
        >
          <TabsList className="w-full">
            <TabsTrigger value="templates" className="flex-1">
              テンプレート
            </TabsTrigger>
            <TabsTrigger value="suggestions" className="flex-1">
              在庫から提案
            </TabsTrigger>
          </TabsList>

          <TabsContent
            value="templates"
            className="overflow-y-auto -mx-4 px-4 pb-2"
            style={{ maxHeight: "calc(75dvh - 170px)" }}
          >
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : templates.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <BookOpen className="size-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  テンプレートがまだありません
                </p>
                <p className="text-xs text-muted-foreground/70">
                  献立を作成後「テンプレートとして保存」できます
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {templates.map((template) => (
                  <div
                    key={template.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => !isPending && handleSelect(template.id)}
                    onKeyDown={(e) => {
                      if ((e.key === "Enter" || e.key === " ") && !isPending) {
                        e.preventDefault()
                        handleSelect(template.id)
                      }
                    }}
                    className="flex w-full items-center gap-3 rounded-xl p-3 text-left transition-colors duration-200 hover:bg-muted active:bg-muted/80 cursor-pointer"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {template.title}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        食材 {getIngredientCount(template.ingredients)}品
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={(e) => handleDelete(e, template.id)}
                      disabled={isPending}
                      aria-label="テンプレートを削除"
                    >
                      <Trash2 className="size-3.5 text-muted-foreground" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent
            value="suggestions"
            className="overflow-y-auto -mx-4 px-4 pb-2"
            style={{ maxHeight: "calc(75dvh - 170px)" }}
          >
            <SuggestionListInDialog
              isActive={activeTab === "suggestions"}
              onSelect={handleSuggestionSelect}
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
