"use client"

import { useState, useRef, useTransition, useEffect, useCallback } from "react"
import { Plus, ChevronDown, ChevronUp } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { addItem, getSuggestions } from "@/app/(main)/shopping/actions"
import { allCategories, allStores } from "@/lib/utils/categories"
import type { ItemCategory, StoreType } from "@/lib/types/database"

interface Suggestion {
  name: string
  category: ItemCategory | null
  storeType: StoreType | null
}

export function AddItemForm() {
  const [isPending, startTransition] = useTransition()
  const [showOptions, setShowOptions] = useState(false)
  const [name, setName] = useState("")
  const [category, setCategory] = useState<ItemCategory>("other_food")
  const [storeType, setStoreType] = useState<StoreType>("supermarket")
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const suggestionsRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null)

  const fetchSuggestions = useCallback(async (query: string) => {
    if (query.trim().length === 0) {
      setSuggestions([])
      setShowSuggestions(false)
      return
    }
    const result = await getSuggestions(query)
    setSuggestions(result.suggestions)
    setShowSuggestions(result.suggestions.length > 0)
    setSelectedSuggestionIndex(-1)
  }, [])

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }
    debounceRef.current = setTimeout(() => {
      fetchSuggestions(name)
    }, 300)

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [name, fetchSuggestions])

  // クリック外でサジェストを閉じる
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  const selectSuggestion = (suggestion: Suggestion) => {
    setName(suggestion.name)
    if (suggestion.category) setCategory(suggestion.category)
    if (suggestion.storeType) setStoreType(suggestion.storeType)
    setShowSuggestions(false)
    inputRef.current?.focus()
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return

    const formData = new FormData()
    formData.set("name", name.trim())
    formData.set("category", category)
    formData.set("store_type", storeType)

    startTransition(async () => {
      const result = await addItem(formData)
      if (result.error) {
        toast.error(result.error)
      } else {
        setName("")
        setSuggestions([])
        setShowSuggestions(false)
        inputRef.current?.focus()
      }
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showSuggestions || suggestions.length === 0) return

    if (e.key === "ArrowDown") {
      e.preventDefault()
      setSelectedSuggestionIndex((prev) =>
        prev < suggestions.length - 1 ? prev + 1 : 0
      )
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setSelectedSuggestionIndex((prev) =>
        prev > 0 ? prev - 1 : suggestions.length - 1
      )
    } else if (e.key === "Enter" && selectedSuggestionIndex >= 0) {
      e.preventDefault()
      selectSuggestion(suggestions[selectedSuggestionIndex])
    }
  }

  return (
    <div className="glass rounded-2xl shadow-lg shadow-black/[0.04] p-3">
      <form ref={formRef} onSubmit={handleSubmit}>
        {/* メイン入力行 */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName((e.target as HTMLInputElement).value)}
              onKeyDown={handleKeyDown}
              onFocus={() => {
                if (suggestions.length > 0) setShowSuggestions(true)
              }}
              placeholder="アイテムを追加..."
              disabled={isPending}
              className="h-10 text-base"
              autoComplete="off"
            />

            {/* サジェストドロップダウン */}
            {showSuggestions && suggestions.length > 0 && (
              <div
                ref={suggestionsRef}
                className="absolute top-full left-0 right-0 z-50 mt-1 overflow-hidden rounded-lg bg-popover shadow-lg ring-1 ring-foreground/10"
              >
                {suggestions.map((suggestion, idx) => (
                  <button
                    key={`${suggestion.name}-${idx}`}
                    type="button"
                    onClick={() => selectSuggestion(suggestion)}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors duration-200",
                      idx === selectedSuggestionIndex
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent/50"
                    )}
                  >
                    <span className="truncate">{suggestion.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <Button
            type="submit"
            size="icon-lg"
            disabled={isPending || !name.trim()}
            className="shrink-0 cursor-pointer"
            aria-label="追加"
          >
            <Plus size={18} />
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            onClick={() => setShowOptions(!showOptions)}
            className="shrink-0 cursor-pointer"
            aria-label={showOptions ? "オプションを閉じる" : "オプションを開く"}
          >
            {showOptions ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          </Button>
        </div>

        {/* 展開オプション */}
        {showOptions && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/50 pt-3">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">カテゴリ:</span>
              <Select value={category} onValueChange={(v) => setCategory(v as ItemCategory)}>
                <SelectTrigger size="sm" className="h-7 min-w-24 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {allCategories.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">購入先:</span>
              <Select value={storeType} onValueChange={(v) => setStoreType(v as StoreType)}>
                <SelectTrigger size="sm" className="h-7 min-w-24 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {allStores.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </form>
    </div>
  )
}
