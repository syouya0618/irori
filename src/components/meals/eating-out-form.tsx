"use client"

import { useState, useTransition, useEffect, useRef } from "react"
import { Star, Camera, Loader2, ImageIcon, X } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import {
  saveEatingOutLog,
  uploadPhoto,
  getEatingOutLog,
} from "@/app/(main)/meals/eating-out-actions"
import { compressImage } from "@/lib/utils/compress-image"

interface EatingOutFormProps {
  mealId: string
}

export function EatingOutForm({ mealId }: EatingOutFormProps) {
  const [isPending, startTransition] = useTransition()
  const [isUploading, setIsUploading] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [restaurantName, setRestaurantName] = useState("")
  const [memo, setMemo] = useState("")
  const [rating, setRating] = useState<number>(0)
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)
  const objectUrlRef = useRef<string | null>(null)

  // Cleanup object URL on unmount
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
      }
    }
  }, [])

  // 既存の外食記録を読み込む
  useEffect(() => {
    async function loadExistingLog() {
      setIsLoading(true)
      const result = await getEatingOutLog(mealId)
      if (result.data) {
        setRestaurantName(result.data.restaurant_name ?? "")
        setMemo(result.data.memo ?? "")
        setRating(result.data.rating ?? 0)
        setPhotoUrl(result.data.photo_url ?? null)
        if (result.data.photo_url) {
          setPhotoPreview(result.data.photo_url)
        }
      }
      setIsLoading(false)
    }
    loadExistingLog()
  }, [mealId])

  function handleStarClick(starIndex: number) {
    // 同じ星をタップしたらリセット
    setRating((prev) => (prev === starIndex ? 0 : starIndex))
  }

  async function handlePhotoSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    // Revoke old object URL before creating new one
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
    }
    // プレビュー表示
    const previewUrl = URL.createObjectURL(file)
    objectUrlRef.current = previewUrl
    setPhotoPreview(previewUrl)

    setIsUploading(true)
    try {
      // 画像を圧縮
      const compressed = await compressImage(file, 800, 0.8)

      // FormDataで送信
      const formData = new FormData()
      formData.append("file", compressed, `photo-${Date.now()}.jpg`)
      formData.append("mealId", mealId)

      const result = await uploadPhoto(formData)
      if (result.error) {
        toast.error(result.error)
        setPhotoPreview(null)
      } else if (result.url) {
        setPhotoUrl(result.url)
        toast.success("写真をアップロードしました")
      }
    } catch {
      toast.error("写真の処理に失敗しました")
      setPhotoPreview(null)
    } finally {
      setIsUploading(false)
    }
  }

  function handleRemovePhoto() {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
    setPhotoUrl(null)
    setPhotoPreview(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
  }

  function handleSave() {
    startTransition(async () => {
      const result = await saveEatingOutLog({
        mealId,
        restaurantName: restaurantName.trim() || null,
        memo: memo.trim() || null,
        rating: rating > 0 ? rating : null,
        photoUrl,
      })
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success("外食記録を保存しました")
      }
    })
  }

  if (isLoading) {
    return (
      <div className="glass flex items-center justify-center rounded-2xl p-6 shadow-lg shadow-black/[0.04]">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="glass flex flex-col gap-4 rounded-2xl p-4 shadow-lg shadow-black/[0.04]">
      <h3 className="text-sm font-semibold text-foreground">外食記録</h3>

      {/* 店名 */}
      <div className="space-y-1.5">
        <Label htmlFor="restaurant-name">お店の名前</Label>
        <Input
          id="restaurant-name"
          type="text"
          placeholder="例: 丸亀製麺"
          value={restaurantName}
          onChange={(e) => setRestaurantName(e.target.value)}
          disabled={isPending}
          autoComplete="off"
          className="min-h-11 rounded-lg"
        />
      </div>

      {/* 評価（星） */}
      <div className="space-y-1.5">
        <Label>評価</Label>
        <div className="flex gap-1">
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              type="button"
              onClick={() => handleStarClick(star)}
              disabled={isPending}
              className="min-h-11 min-w-11 rounded-lg p-2 transition-colors duration-200 hover:bg-accent/50 active:bg-accent"
              aria-label={`${star}つ星`}
            >
              <Star
                className={`size-6 transition-colors duration-200 ${
                  star <= rating
                    ? "fill-amber-400 text-amber-400"
                    : "fill-none text-muted-foreground/40"
                }`}
              />
            </button>
          ))}
          {rating > 0 && (
            <span className="flex items-center pl-2 text-sm text-muted-foreground">
              {rating}/5
            </span>
          )}
        </div>
      </div>

      {/* 写真 */}
      <div className="space-y-1.5">
        <Label>写真</Label>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handlePhotoSelect}
          className="hidden"
          disabled={isPending || isUploading}
        />

        {photoPreview ? (
          <div className="relative overflow-hidden rounded-xl">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photoPreview}
              alt="外食写真プレビュー"
              className="aspect-video w-full rounded-xl object-cover"
            />
            {isUploading && (
              <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/40">
                <Loader2 className="size-6 animate-spin text-white" />
              </div>
            )}
            {!isUploading && (
              <button
                type="button"
                onClick={handleRemovePhoto}
                className="absolute right-2 top-2 rounded-full bg-black/50 p-1.5 text-white transition-colors duration-200 hover:bg-black/70"
                aria-label="写真を削除"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isPending || isUploading}
            className="flex min-h-24 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/60 px-3 py-4 text-sm text-muted-foreground transition-colors duration-200 hover:border-primary/40 hover:text-foreground"
          >
            {isUploading ? (
              <Loader2 className="size-5 animate-spin" />
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Camera className="size-5" />
                  <ImageIcon className="size-5" />
                </div>
                <span>タップして写真を選択</span>
              </>
            )}
          </button>
        )}
      </div>

      {/* メモ */}
      <div className="space-y-1.5">
        <Label htmlFor="eating-out-memo">メモ</Label>
        <Textarea
          id="eating-out-memo"
          placeholder="おすすめのメニュー、気づいたことなど"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          disabled={isPending}
          className="rounded-lg"
        />
      </div>

      {/* 保存ボタン */}
      <Button
        type="button"
        onClick={handleSave}
        disabled={isPending || isUploading}
        className="min-h-11 w-full rounded-lg text-base font-semibold"
      >
        {isPending ? (
          <>
            <Loader2 className="animate-spin" />
            保存中...
          </>
        ) : (
          "外食記録を保存"
        )}
      </Button>
    </div>
  )
}
