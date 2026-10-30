"use client"

import { createContext, useContext } from "react"

export type ChildScope = { id: string; isLegacy: boolean }
const Context = createContext<ChildScope | null>(null)
export function ChildScopeProvider({ scope, children }: { scope: ChildScope; children: React.ReactNode }) {
  return <Context value={scope}>{children}</Context>
}
export function useChildScope() { return useContext(Context) }
