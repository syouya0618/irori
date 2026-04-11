"use client"

import { useState, useEffect } from "react"

export function useNow(intervalMs: number, enabled = true): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    if (!enabled) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- enabled切替時にクロックを即同期
    setNow(new Date())
    const id = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs, enabled])
  return now
}
