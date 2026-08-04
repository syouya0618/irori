import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  // ⭐ `min-h-11 min-w-11`（44px）を**基底**に置く。CLAUDE.md「Touch targets: min 44px」/
  //    DESIGN_SYSTEM.md:99「タッチターゲット最小 44x44px」の担い手じゃ。
  //
  // ## なぜ variant の h-* を書き換えず min-* を足すのか
  // `h-8`（32px）を `h-11` に置き換えると、既に 44px 以上を指定しておる呼び出し側
  // （`min-h-14` の授乳タイマー等）まで巻き込んで縮む恐れがある。`min-height` は
  // **足りぬときだけ効く**ゆえ、大きいものは一切変わらぬ。
  //
  // ## なぜ呼び出し側 57 箇所ではなく基底で直すのか
  // 実測で 44px 未満は 57 箇所 / 30 ファイルじゃった（size 別: sm は 16/16 全滅、
  // lg 7/9、default 24/38）。呼び出し側を直す形だと **1 つ漏らせば穴が残り、
  // 次に足すボタンも同じ穴を開ける**。基底に置けば既定で満たされる。
  //
  // ## `after:` の当たり判定拡張を採らなかった理由
  // 見た目を保つ手（`switch.tsx` が採っておる `after:absolute after:-inset-*`）も
  // あるが、隣接する小ボタンで**当たり判定が重なり合い、後勝ちで誤タップを増やす**。
  // DESIGN_SYSTEM.md:15-16 は失敗しやすい操作を「**誤タップ（片手操作時）**」と
  // 名指ししており、この用途では実寸を広げる方が目的に適う。
  "group/button inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,outline-color,box-shadow,translate,opacity] duration-200 outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
