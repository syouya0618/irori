"use client"

import { useState, useTransition } from "react"
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Loader2,
  Plus,
  Trash2,
  BookMarked,
  BookOpen,
} from "lucide-react"
import { toast } from "sonner"
import {
  createMeal,
  updateMeal,
  deleteMeal,
  saveAsTemplate,
} from "@/app/(main)/meals/actions"
import { TemplateSelector } from "@/components/meals/template-selector"
import { getCategoryColor, allCategories } from "@/lib/utils/categories"
import { MEAL_TYPE_LABELS, MEAL_TYPES } from "@/lib/utils/meal-types"
import type { MealType, ItemCategory } from "@/lib/types/database"

const FOOD_CATEGORIES = allCategories.filter((c) =>
  ["vegetable", "meat", "fish", "dairy", "grain", "egg", "seasoning", "frozen", "other_food"].includes(c.value)
)

interface IngredientInput {
  name: string
  quantity: string
  category: ItemCategory
}

interface MealFormData {
  id?: string
  title: string
  mealType: MealType
  date: string
  isEatingOut: boolean
  ingredients: IngredientInput[]
}

interface MealFormSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialData?: MealFormData
  defaultDate: string
  defaultMealType: MealType
}

export function MealFormSheet({
  open,
  onOpenChange,
  initialData,
  defaultDate,
  defaultMealType,
}: MealFormSheetProps) {
  const isEditing = !!initialData?.id
  const [isPending, startTransition] = useTransition()
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showTemplateSelector, setShowTemplateSelector] = useState(false)

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

  function resetForm() {
    setTitle("")
    setMealType(defaultMealType)
    setDate(defaultDate)
    setIsEatingOut(false)
    setIngredients([])
    setShowDeleteConfirm(false)
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      resetForm()
    } else if (initialData) {
      setTitle(initialData.title)
      setMealType(initialData.mealType)
      setDate(initialData.date)
      setIsEatingOut(initialData.isEatingOut)
      setIngredients(initialData.ingredients)
      setShowDeleteConfirm(false)
    } else {
      setDate(defaultDate)
      setMealType(defaultMealType)
    }
    onOpenChange(nextOpen)
  }

  function addIngredient() {
    setIngredients((prev) => [
      ...prev,
      { name: "", quantity: "", category: "other_food" },
    ])
  }

  function removeIngredient(index: number) {
    setIngredients((prev) => prev.filter((_, i) => i !== index))
  }

  function updateIngredient(
    index: number,
    field: keyof IngredientInput,
    value: string
  ) {
    setIngredients((prev) =>
      prev.map((ing, i) =>
        i === index ? { ...ing, [field]: value } : ing
      )
    )
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    const trimmedTitle = title.trim()
    if (!trimmedTitle) {
      toast.error("メニュー名を入力してください")
      return
    }

    // Filter out empty ingredient rows
    const validIngredients = ingredients.filter(
      (ing) => ing.name.trim() !== ""
    )

    startTransition(async () => {
      if (isEditing && initialData?.id) {
        const result = await updateMeal({
          id: initialData.id,
          date,
          mealType,
          title: trimmedTitle,
          isEatingOut,
          ingredients: validIngredients,
        })
        if (result.error) {
          toast.error(result.error)
          return
        }
        toast.success("献立を更新しました")
      } else {
        const result = await createMeal({
          date,
          mealType,
          title: trimmedTitle,
          isEatingOut,
          ingredients: validIngredients,
        })
        if (result.error) {
          toast.error(result.error)
          return
        }
        toast.success("献立を追加しました")
      }
      handleOpenChange(false)
    })
  }

  function handleDelete() {
    if (!initialData?.id) return

    startTransition(async () => {
      const result = await deleteMeal(initialData.id!)
      if (result.error) {
        toast.error(result.error)
        return
      }
      toast.success("献立を削除しました")
      handleOpenChange(false)
    })
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
      <Sheet open={open} onOpenChange={handleOpenChange}>
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
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>食材</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={addIngredient}
                  className="gap-1 text-primary"
                >
                  <Plus className="size-3.5" />
                  追加
                </Button>
              </div>

              {ingredients.length === 0 ? (
                <button
                  type="button"
                  onClick={addIngredient}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border/60 px-3 py-4 text-sm text-muted-foreground transition-colors duration-200 hover:border-primary/40 hover:text-foreground"
                >
                  <Plus className="size-4" />
                  食材を追加
                </button>
              ) : (
                <div className="space-y-2">
                  {ingredients.map((ing, index) => (
                    <div
                      key={index}
                      className="flex items-start gap-1.5 rounded-lg bg-muted/30 p-2"
                    >
                      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <Input
                          placeholder="食材名"
                          value={ing.name}
                          onChange={(e) =>
                            updateIngredient(index, "name", e.target.value)
                          }
                          disabled={isPending}
                          autoComplete="off"
                          className="h-8 rounded-md text-sm"
                        />
                        <div className="flex gap-1.5">
                          <Input
                            placeholder="量"
                            value={ing.quantity}
                            onChange={(e) =>
                              updateIngredient(
                                index,
                                "quantity",
                                e.target.value
                              )
                            }
                            disabled={isPending}
                            autoComplete="off"
                            className="h-7 w-20 rounded-md text-xs"
                          />
                          <Select
                            value={ing.category}
                            onValueChange={(val) =>
                              updateIngredient(
                                index,
                                "category",
                                val as ItemCategory
                              )
                            }
                          >
                            <SelectTrigger
                              size="sm"
                              className="h-7 flex-1 text-xs"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {FOOD_CATEGORIES.map((cat) => (
                                <SelectItem
                                  key={cat.value}
                                  value={cat.value}
                                >
                                  <span
                                    className={`rounded-full px-1.5 py-0.5 text-xs font-medium ${
                                      getCategoryColor(cat.value as ItemCategory)
                                    }`}
                                  >
                                    {cat.label}
                                  </span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => removeIngredient(index)}
                        disabled={isPending}
                        aria-label="食材を削除"
                        className="mt-1 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Delete section (editing only) */}
            {isEditing && (
              <div className="border-t pt-3">
                {showDeleteConfirm ? (
                  <div className="flex items-center gap-2">
                    <p className="flex-1 text-sm text-destructive">
                      本当に削除しますか？
                    </p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowDeleteConfirm(false)}
                      disabled={isPending}
                    >
                      キャンセル
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={handleDelete}
                      disabled={isPending}
                    >
                      {isPending ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        "削除する"
                      )}
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowDeleteConfirm(true)}
                    className="w-full text-destructive hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                    この献立を削除
                  </Button>
                )}
              </div>
            )}
          </form>

          <SheetFooter>
            <Button
              type="submit"
              onClick={handleSubmit}
              disabled={isPending || !title.trim()}
              className="min-h-11 w-full rounded-lg text-base font-semibold"
            >
              {isPending ? (
                <>
                  <Loader2 className="animate-spin" />
                  {isEditing ? "更新中..." : "追加中..."}
                </>
              ) : isEditing ? (
                "更新する"
              ) : (
                "追加する"
              )}
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
