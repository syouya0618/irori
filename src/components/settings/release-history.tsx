"use client"

import { useId, useState } from "react"
import { History } from "lucide-react"
import { Button } from "@/components/ui/button"
import { RELEASE_HISTORY } from "@/lib/release/release-notes"

export function ReleaseHistory() {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <section className="glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]" aria-label="更新履歴">
      <Button type="button" variant="ghost" className="min-h-11 w-full cursor-pointer" aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}>
        <History size={18} aria-hidden="true" />更新履歴を見る
      </Button>
      <div id={id} hidden={!open}>
        {RELEASE_HISTORY.map((release) => (
          <article key={release.id} className="mb-4 last:mb-0">
            <h2 className="mb-2 text-sm font-semibold">{release.title}</h2>
            <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
              {release.items.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </article>
        ))}
      </div>
    </section>
  )
}
