import { getChildContext } from "@/lib/supabase/child-context"
import { getProfileForRequest } from "@/lib/supabase/profile-for-request"
import { ShareManager } from "@/components/sharing/share-manager"
export default async function SharingPage() {
  const { children, supabase, userId } = await getChildContext()
  const { data: profile, error: profileError } = await getProfileForRequest(userId)
  if (profileError || profile?.role !== "owner") return <p className="p-4">閲覧共有は世帯オーナーが管理します。</p>
  const { data, error } = await supabase.rpc("list_child_shares", { p_owned: true })
  if (error) throw new Error("共有の状態を取得できませんでした")
  return <ShareManager childrenList={children} initialShares={data} />
}
