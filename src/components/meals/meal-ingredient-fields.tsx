"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Plus, Trash2 } from "lucide-react"
import { getCategoryColor, allCategories } from "@/lib/utils/categories"
import type { ItemCategory } from "@/lib/types/database"

const FOOD_CATEGORIES = allCategories.filter((c) =>
  ["vegetable", "meat", "fish", "dairy", "grain", "egg", "seasoning", "frozen", "other_food"].includes(c.value)
)

export interface IngredientInput {
  name: string
  quantity: string
  category: ItemCategory
}

interface MealIngredientFieldsProps {
  ingredients: IngredientInput[]
  setIngredients: React.Dispatch<React.SetStateAction<IngredientInput[]>>
  isPending: boolean
}

export function MealIngredientFields({
  ingredients,
  setIngredients,
  isPending,
}: MealIngredientFieldsProps) {
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

  return (
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
                    items={FOOD_CATEGORIES}
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
  )
}
