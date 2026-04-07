"use server"

import { revalidatePath } from "next/cache"
import { getAuthContext } from "@/lib/supabase/auth-context"
import type { MealType, MealReaction, ItemCategory } from "@/lib/types/database"

interface MealIngredientInput {
  name: string
  quantity: string
  category: ItemCategory
}

interface CreateMealInput {
  date: string
  mealType: MealType
  title: string
  isEatingOut: boolean
  ingredients: MealIngredientInput[]
}

interface UpdateMealInput extends CreateMealInput {
  id: string
}

export async function createMeal(input: CreateMealInput) {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, userId, householdId } = result.context

  const { data: meal, error: mealError } = await supabase
    .from("meals")
    .insert({
      household_id: householdId,
      date: input.date,
      meal_type: input.mealType,
      title: input.title,
      is_eating_out: input.isEatingOut,
      created_by: userId,
    })
    .select("id")
    .single()

  if (mealError || !meal) {
    if (mealError?.code === "23505") {
      return { error: "この日時のメニューは既に登録されています。" }
    }
    return { error: "献立の作成に失敗しました。もう一度お試しください。" }
  }

  if (input.ingredients.length > 0) {
    const { error: ingredientError } = await supabase
      .from("meal_ingredients")
      .insert(
        input.ingredients.map((ing) => ({
          meal_id: meal.id,
          name: ing.name,
          quantity: ing.quantity || null,
          category: ing.category,
        }))
      )

    if (ingredientError) {
      return { error: "食材の登録に失敗しました。" }
    }
  }

  revalidatePath("/meals")
  return { error: null, mealId: meal.id }
}

export async function updateMeal(input: UpdateMealInput) {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, householdId } = result.context

  // Verify ownership
  const { data: existingMeal } = await supabase
    .from("meals")
    .select("household_id")
    .eq("id", input.id)
    .single()

  if (!existingMeal || existingMeal.household_id !== householdId) {
    return { error: "この献立を編集する権限がありません。" }
  }

  const { error: updateError } = await supabase
    .from("meals")
    .update({
      date: input.date,
      meal_type: input.mealType,
      title: input.title,
      is_eating_out: input.isEatingOut,
    })
    .eq("id", input.id)

  if (updateError) {
    if (updateError.code === "23505") {
      return { error: "この日時のメニューは既に登録されています。" }
    }
    return { error: "献立の更新に失敗しました。" }
  }

  // Delete existing ingredients, re-insert
  await supabase.from("meal_ingredients").delete().eq("meal_id", input.id)

  if (input.ingredients.length > 0) {
    const { error: ingredientError } = await supabase
      .from("meal_ingredients")
      .insert(
        input.ingredients.map((ing) => ({
          meal_id: input.id,
          name: ing.name,
          quantity: ing.quantity || null,
          category: ing.category,
        }))
      )

    if (ingredientError) {
      return { error: "食材の更新に失敗しました。" }
    }
  }

  revalidatePath("/meals")
  return { error: null }
}

export async function deleteMeal(mealId: string) {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, householdId } = result.context

  // Verify ownership
  const { data: existingMeal } = await supabase
    .from("meals")
    .select("household_id")
    .eq("id", mealId)
    .single()

  if (!existingMeal || existingMeal.household_id !== householdId) {
    return { error: "この献立を削除する権限がありません。" }
  }

  // Delete ingredients and reactions first (in case cascade isn't set)
  await supabase.from("meal_ingredients").delete().eq("meal_id", mealId)
  await supabase.from("meal_reactions").delete().eq("meal_id", mealId)

  const { error } = await supabase.from("meals").delete().eq("id", mealId)

  if (error) {
    return { error: "献立の削除に失敗しました。" }
  }

  revalidatePath("/meals")
  return { error: null }
}

export async function upsertReaction(mealId: string, reaction: MealReaction) {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, userId, householdId } = result.context

  // Verify meal belongs to the household
  const { data: meal } = await supabase
    .from("meals")
    .select("household_id")
    .eq("id", mealId)
    .single()

  if (!meal || meal.household_id !== householdId) {
    return { error: "この献立にリアクションする権限がありません。" }
  }

  // Check existing reaction
  const { data: existing } = await supabase
    .from("meal_reactions")
    .select("id, reaction")
    .eq("meal_id", mealId)
    .eq("user_id", userId)
    .single()

  if (existing) {
    if (existing.reaction === reaction) {
      // Same reaction = toggle off (delete)
      const { error } = await supabase
        .from("meal_reactions")
        .delete()
        .eq("id", existing.id)

      if (error) {
        return { error: "リアクションの削除に失敗しました。" }
      }

      revalidatePath("/meals")
      return { error: null, removed: true }
    }

    // Different reaction = update
    const { error } = await supabase
      .from("meal_reactions")
      .update({ reaction })
      .eq("id", existing.id)

    if (error) {
      return { error: "リアクションの更新に失敗しました。" }
    }
  } else {
    // Insert new
    const { error } = await supabase.from("meal_reactions").insert({
      meal_id: mealId,
      user_id: userId,
      reaction,
    })

    if (error) {
      return { error: "リアクションの登録に失敗しました。" }
    }
  }

  revalidatePath("/meals")
  return { error: null, removed: false }
}

export async function saveAsTemplate(mealId: string) {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, userId, householdId } = result.context

  // Get meal with ingredients
  const { data: meal } = await supabase
    .from("meals")
    .select("title, household_id")
    .eq("id", mealId)
    .single()

  if (!meal || meal.household_id !== householdId) {
    return { error: "この献立をテンプレートとして保存する権限がありません。" }
  }

  const { data: ingredients } = await supabase
    .from("meal_ingredients")
    .select("name, quantity, category")
    .eq("meal_id", mealId)

  const { data: template, error } = await supabase
    .from("meal_templates")
    .insert({
      household_id: householdId,
      title: meal.title,
      ingredients: (ingredients || []) as unknown as import("@/lib/types/database").Json,
      created_by: userId,
    })
    .select("id")
    .single()

  if (error || !template) {
    return { error: "テンプレートの保存に失敗しました。" }
  }

  // Link template to meal
  await supabase
    .from("meals")
    .update({ template_id: template.id })
    .eq("id", mealId)

  revalidatePath("/meals")
  return { error: null, templateId: template.id }
}

export async function loadTemplate(templateId: string) {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error, data: null }
  const { supabase, householdId } = result.context

  const { data: template } = await supabase
    .from("meal_templates")
    .select("title, ingredients, household_id")
    .eq("id", templateId)
    .single()

  if (!template || template.household_id !== householdId) {
    return { error: "テンプレートが見つかりません。", data: null }
  }

  return {
    error: null,
    data: {
      title: template.title,
      ingredients: template.ingredients as unknown as MealIngredientInput[],
    },
  }
}

export async function deleteTemplate(templateId: string) {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, householdId } = result.context

  const { data: template } = await supabase
    .from("meal_templates")
    .select("household_id")
    .eq("id", templateId)
    .single()

  if (!template || template.household_id !== householdId) {
    return { error: "このテンプレートを削除する権限がありません。" }
  }

  // Unlink meals that reference this template
  await supabase
    .from("meals")
    .update({ template_id: null })
    .eq("template_id", templateId)

  const { error } = await supabase
    .from("meal_templates")
    .delete()
    .eq("id", templateId)

  if (error) {
    return { error: "テンプレートの削除に失敗しました。" }
  }

  revalidatePath("/meals")
  return { error: null }
}

export async function getTemplates() {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error, data: [] }
  const { supabase, householdId } = result.context

  const { data: templates } = await supabase
    .from("meal_templates")
    .select("id, title, ingredients, created_at")
    .eq("household_id", householdId)
    .order("created_at", { ascending: false })

  return { error: null, data: templates || [] }
}
