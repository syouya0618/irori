import Link from "next/link"
import { getChildContext } from "@/lib/supabase/child-context"
import { ChildEditor } from "@/components/baby/child-picker"

export default async function ChildrenPage() {
  const { children } = await getChildContext()
  return <div className="flex flex-col gap-4 px-4 pt-8 pb-8">
    <Link href="/baby" className="flex min-h-11 items-center text-primary">育児へ戻る</Link>
    <h1 className="text-lg font-semibold">子どもの管理</h1>
    <p className="text-sm text-muted-foreground">記録といつものミルク量は子どもごとに分かれます。過去の記録はそのまま残ります。</p>
    {children.map(c => <ChildEditor key={c.id} child={c} />)}
    <ChildEditor />
  </div>
}
