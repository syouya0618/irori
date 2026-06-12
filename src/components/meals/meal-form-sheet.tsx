"use client"

import { useState, useRef, useTransition } from "react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  BookMarked,
  BookOpen,
} from "lucide-react"
import { toast } from "sonner"
import { saveAsTemplate } from "@/app/(main)/meals/actions"
import { MealDeleteConfirm } from "@/components/meals/meal-delete-confirm"
import { MealIngredientFields } from "@/components/meals/meal-ingredient-fields"
import { TemplateSelector } from "@/components/meals/template-selector"
import { MEAL_TYPE_LABELS, MEAL_TYPES } from "@/lib/utils/meal-types"
import type { IngredientInput } from "@/components/meals/meal-ingredient-fields"
import type { MealType } from "@/lib/types/database"

interface MealFormData {
  id?: string
  title: string
  mealType: MealType
  date: string
  isEatingOut: boolean
  ingredients: IngredientInput[]
}

/** 保存ボタン押下時に親へ渡すバリデーション済みフォーム値 (id があれば更新) */
export interface MealFormSubmitData {
  id?: string
  date: string
  mealType: MealType
  title: string
  isEatingOut: boolean
  ingredients: IngredientInput[]
}

interface MealFormSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialData?: MealFormData
  defaultDate: string
  defaultMealType: MealType
  /**
   * 保存/削除は親 (MealWeekView) が楽観反映 → シート即閉じ → 裏で server action
   * → 失敗時ロールバック + toast を担う。シートは検証済みの入力値を渡すだけで、
   * action の完了を待たない。
   */
  onSubmitMeal: (data: MealFormSubmitData) => void
  onDeleteMeal: (mealId: string) => void
}

export function MealFormSheet({
  open,
  onOpenChange,
  initialData,
  defaultDate,
  defaultMealType,
  onSubmitMeal,
  onDeleteMeal,
}: MealFormSheetProps) {
  const isEditing = !!initialData?.id
  // isPending はシート内で完結する saveAsTemplate のみが使う
  const [isPending, startTransition] = useTransition()
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showTemplateSelector, setShowTemplateSelector] = useState(false)
  // 連打防御: 保存/削除は即シートが閉じるが、閉アニメーション中の再タップや
  // Enter + クリックの二重発火で楽観行が二重挿入されぬよう 1 度だけ通す。
  // シートは open のたびに key で remount されるため自然にリセットされる。
  const submittedRef = useRef(false)

  // 親がkey={formKey}で毎回remountするため、propsから直接初期化
  const [title, setTitle] = useState(initialData?.title ?? "")
  const [mealType, setMealType] = useState<MealType>(
    initialData?.mealType ?? defaultMealType
  )
  const [date, setDate] = useState(initialData?.date ?? defaultDate)
  const [isEatingOut, setIsEatingOut] = useState(
    initialData?.isEatingOut ?? false
  )
  const [ingredients, setIngredients] = useState<IngredientInput[]>(
    initialData?.ingredients ?? []
  )

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    const trimmedTitle = title.trim()
    if (!trimmedTitle) {
      toast.error("メニュー名を入力してください")
      return
    }

    if (submittedRef.current) return
    submittedRef.current = true

    // Filter out empty ingredient rows
    const validIngredients = ingredients.filter(
      (ing) => ing.name.trim() !== ""
    )

    onSubmitMeal({
      id: initialData?.id,
      date,
      mealType,
      title: trimmedTitle,
      isEatingOut,
      ingredients: validIngredients,
    })
  }

  function handleDelete() {
    if (!initialData?.id) return

    if (submittedRef.current) return
    submittedRef.current = true

    onDeleteMeal(initialData.id)
  }

  function handleSaveAsTemplate() {
    if (!initialData?.id) return

    startTransition(async () => {
      const result = await saveAsTemplate(initialData.id!)
      if (result.error) {
        toast.error(result.error)
        return
      }
      toast.success("テンプレートとして保存しました")
    })
  }

  function handleTemplateSelect(data: {
    title: string
    ingredients: IngredientInput[]
  }) {
    setTitle(data.title)
    setIngredients(data.ingredients)
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          className="max-h-[85dvh] overflow-hidden rounded-t-2xl safe-bottom"
        >
          <SheetHeader className="pb-2">
            <SheetTitle>
              {isEditing ? "献立を編集" : "献立を追加"}
            </SheetTitle>
            <SheetDescription>
              {isEditing
                ? "内容を変更して保存してください"
                : "メニューと食材を入力してください"}
            </SheetDescription>
          </SheetHeader>

          <form
            onSubmit={handleSubmit}
            className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 pb-2"
            style={{ maxHeight: "calc(85dvh - 180px)" }}
          >
            {/* Template button */}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowTemplateSelector(true)}
                className="gap-1.5"
              >
                <BookOpen className="size-3.5" />
                テンプレートから作成
              </Button>
              {isEditing && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleSaveAsTemplate}
                  disabled={isPending}
                  className="gap-1.5"
                >
                  <BookMarked className="size-3.5" />
                  テンプレート保存
                </Button>
              )}
            </div>

            {/* Title */}
            <div className="space-y-1.5">
              <Label htmlFor="meal-title">メニュー名</Label>
              <Input
                id="meal-title"
                type="text"
                placeholder="例: カレーライス"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={isPending}
                required
                autoComplete="off"
                className="min-h-11 rounded-lg"
              />
            </div>

            {/* Meal type selector */}
            <div className="space-y-1.5">
              <Label>食事タイプ</Label>
              <div className="flex gap-1.5">
                {MEAL_TYPES.map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setMealType(type)}
                    className={`flex-1 rounded-lg px-2 py-2 text-sm font-medium transition-colors duration-200 ${
                      mealType === type
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {MEAL_TYPE_LABELS[type]}
                  </button>
                ))}
              </div>
            </div>

            {/* Date */}
            <div className="space-y-1.5">
              <Label htmlFor="meal-date">日付</Label>
              <Input
                id="meal-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                disabled={isPending}
                className="min-h-11 rounded-lg"
              />
            </div>

            {/* Eating out toggle */}
            <div className="flex items-center justify-between rounded-lg bg-muted/50 p-3">
              <Label htmlFor="eating-out" className="cursor-pointer">
                外食
              </Label>
              <Switch
                id="eating-out"
                checked={isEatingOut}
                onCheckedChange={(checked) => setIsEatingOut(checked)}
                disabled={isPending}
              />
            </div>

            {/* Ingredients */}
            <MealIngredientFields
              ingredients={ingredients}
              setIngredients={setIngredients}
              isPending={isPending}
            />

            {/* Delete section (editing only) */}
            {isEditing && (
              <MealDeleteConfirm
                showDeleteConfirm={showDeleteConfirm}
                setShowDeleteConfirm={setShowDeleteConfirm}
                isPending={isPending}
                handleDelete={handleDelete}
              />
            )}
          </form>

          <SheetFooter>
            {/* 保存は楽観反映で即シートが閉じるため pending スピナーは持たない */}
            <Button
              type="submit"
              onClick={handleSubmit}
              disabled={isPending || !title.trim()}
              className="min-h-11 w-full rounded-lg text-base font-semibold"
            >
              {isEditing ? "更新する" : "追加する"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <TemplateSelector
        open={showTemplateSelector}
        onOpenChange={setShowTemplateSelector}
        onSelect={handleTemplateSelect}
      />
    </>
  )
}
