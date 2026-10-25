import { cn } from "@/lib/utils"

/**
 * 読み込み中の骨組み。
 *
 * 色は `bg-muted-foreground/15`。以前の `bg-muted` は glass カードの上でほぼ同色になり、
 * 特にダークでは骨組みが見えず「読み込み中」ではなく「空」に見えた（静的描画の目視:
 * ダークの /baby の骨組みは背景との差がほぼ無かった）。muted-foreground はライト・
 * ダークの両方で背景から十分に離れており、15% の薄さなら主張もせぬ。
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted-foreground/15", className)}
      {...props}
    />
  )
}

export { Skeleton }
