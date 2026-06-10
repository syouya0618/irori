"use client"

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { createClient } from "@/lib/supabase/client"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { getMonday, addDays, formatDateKey } from "@/lib/utils/date"
import type { MealType, MealReaction } from "@/lib/types/database"

export interface MealWithDetails {
  id: string
  date: string
  meal_type: MealType
  title: string
  is_eating_out: boolean
  template_id: string | null
  meal_reactions: {
    user_id: string
    reaction: MealReaction
  }[]
  meal_ingredients: {
    name: string
    quantity: string | null
    category: string
  }[]
}

interface UseWeekMealsArgs {
  initialMeals: MealWithDetails[]
  householdId: string
  initialWeekStart: string // YYYY-MM-DD (Monday)
}

export function useWeekMeals({
  initialMeals,
  householdId,
  initialWeekStart,
}: UseWeekMealsArgs) {
  const [weekStart, setWeekStart] = useState<Date>(
    () => new Date(initialWeekStart + "T00:00:00")
  )
  const [meals, setMeals] = useState<MealWithDetails[]>(initialMeals)
  const [isLoading, setIsLoading] = useState(false)

  // Realtime subscription が weekStart 変更のたびに再購読しないよう ref で保持する。
  const weekStartRef = useRef(weekStart)
  useEffect(() => { weekStartRef.current = weekStart }, [weekStart])

  const weekDays = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  }, [weekStart])

  const mealMap = useMemo(() => {
    const map = new Map<string, MealWithDetails>()
    for (const meal of meals) {
      map.set(`${meal.date}:${meal.meal_type}`, meal)
    }
    return map
  }, [meals])

  const isCurrentWeek = useMemo(() => {
    const currentMonday = getMonday(new Date())
    return formatDateKey(weekStart) === formatDateKey(currentMonday)
  }, [weekStart])

  const fetchMeals = useCallback(
    async (start: Date) => {
      setIsLoading(true)
      const supabase = createClient()
      const startStr = formatDateKey(start)
      const endStr = formatDateKey(addDays(start, 6))

      const { data, error: mealsError } = await supabase
        .from("meals")
        .select(
          `
          id, date, meal_type, title, is_eating_out, template_id,
          meal_reactions ( user_id, reaction ),
          meal_ingredients ( name, quantity, category )
        `
        )
        .eq("household_id", householdId)
        .gte("date", startStr)
        .lte("date", endStr)
        .order("date")

      if (mealsError) {
        logSupabaseError("meal-week-view", "meals lookup failed", mealsError, {
          householdId,
        })
      }

      if (data) {
        setMeals(data as unknown as MealWithDetails[])
      }
      setIsLoading(false)
    },
    [householdId]
  )

  function goToPreviousWeek() {
    const newStart = addDays(weekStart, -7)
    setWeekStart(newStart)
    fetchMeals(newStart)
  }

  function goToNextWeek() {
    const newStart = addDays(weekStart, 7)
    setWeekStart(newStart)
    fetchMeals(newStart)
  }

  function goToCurrentWeek() {
    const monday = getMonday(new Date())
    setWeekStart(monday)
    fetchMeals(monday)
  }

  useEffect(() => {
    const supabase = createClient()

    const channel = supabase
      .channel(`meals-${householdId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "meals",
          filter: `household_id=eq.${householdId}`,
        },
        () => {
          fetchMeals(weekStartRef.current)
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [householdId, fetchMeals])

  return {
    weekStart,
    meals,
    isLoading,
    weekDays,
    mealMap,
    isCurrentWeek,
    goToPreviousWeek,
    goToNextWeek,
    goToCurrentWeek,
  }
}
