"use client"

import { useCallback, useSyncExternalStore } from "react"

/**
 * レシート OCR の方式。端末（ブラウザ）ごとに異なりうるため localStorage に保存する。
 * - manual: OCR せず手入力のみ
 * - tesseract: 端末内 WASM OCR（外部送信なし・費用ゼロ・精度は控えめ）
 * - google-vision: クラウド OCR（高精度・画像を外部送信・要 APIキー）
 */
export type OcrProviderSetting = "manual" | "tesseract" | "google-vision"

const STORAGE_KEY = "irori:ocr-provider"
const DEFAULT_PROVIDER: OcrProviderSetting = "tesseract"

function isValid(v: string | null): v is OcrProviderSetting {
  return v === "manual" || v === "tesseract" || v === "google-vision"
}

// 同一タブでの変更を useSyncExternalStore に伝えるための listener（storage イベントは別タブのみ発火）
const listeners = new Set<() => void>()

function subscribe(callback: () => void): () => void {
  listeners.add(callback)
  window.addEventListener("storage", callback)
  return () => {
    listeners.delete(callback)
    window.removeEventListener("storage", callback)
  }
}

function getSnapshot(): OcrProviderSetting {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return isValid(stored) ? stored : DEFAULT_PROVIDER
  } catch {
    // Cookie 全ブロック等で localStorage アクセスが SecurityError を投げる環境。
    // useSyncExternalStore が毎 render 呼ぶホットパスゆえ log せず既定へフォールバック
    // （握り潰しではなく想定内の環境条件。use-onboarding-tour.ts と同方針）。
    return DEFAULT_PROVIDER
  }
}

function getServerSnapshot(): OcrProviderSetting {
  return DEFAULT_PROVIDER
}

export function useOcrProvider(): [
  OcrProviderSetting,
  (value: OcrProviderSetting) => void,
] {
  const provider = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  )

  const setProvider = useCallback((value: OcrProviderSetting) => {
    try {
      localStorage.setItem(STORAGE_KEY, value)
    } catch {
      // プライベートブラウズ等でストレージ不可
    }
    listeners.forEach((l) => l())
  }, [])

  return [provider, setProvider]
}
