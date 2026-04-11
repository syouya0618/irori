"use client"

import { useState, useEffect, useCallback } from "react"

type Theme = "light" | "dark" | "system"
type ResolvedTheme = "light" | "dark"

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light"
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light"
}

function applyTheme(resolved: ResolvedTheme) {
  if (resolved === "dark") {
    document.documentElement.classList.add("dark")
  } else {
    document.documentElement.classList.remove("dark")
  }
}

const VALID_THEMES: Theme[] = ["light", "dark", "system"]

export function useTheme() {
  // SSR: "system" → client: localStorage値を即反映（FOUC防止scriptと一致させる）
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === "undefined") return "system"
    const stored = localStorage.getItem("theme")
    return VALID_THEMES.includes(stored as Theme) ? (stored as Theme) : "system"
  })

  const resolvedTheme: ResolvedTheme =
    theme === "system" ? getSystemTheme() : theme

  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme)
    localStorage.setItem("theme", newTheme)
    const resolved = newTheme === "system" ? getSystemTheme() : newTheme
    applyTheme(resolved)
  }, [])

  // Listen for system theme changes when mode is "system"
  useEffect(() => {
    if (theme !== "system") return

    const mql = window.matchMedia("(prefers-color-scheme: dark)")
    function handler() {
      applyTheme(getSystemTheme())
    }
    mql.addEventListener("change", handler)
    return () => mql.removeEventListener("change", handler)
  }, [theme])

  // Apply on mount and theme change
  useEffect(() => {
    applyTheme(resolvedTheme)
  }, [resolvedTheme])

  return { theme, resolvedTheme, setTheme } as const
}
