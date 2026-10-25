"use client"

import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"
import { openNativePickerOnTap } from "@/lib/utils/native-picker"

function Input({
  className,
  type,
  onClick,
  ...props
}: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 focus-visible:aria-invalid:ring-ring",
        className
      )}
      // Chrome for Android 154 以降、fine ポインタも報告する端末では date/time 欄を
      // 叩いてもピッカーが開かぬ。その隙間だけ showPicker で埋める（詳細は native-picker.ts）
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        openNativePickerOnTap(event.currentTarget)
      }}
      {...props}
    />
  )
}

export { Input }
