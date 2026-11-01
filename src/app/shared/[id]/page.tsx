import { SharedView } from "@/components/sharing/shared-view"
export const dynamic = "force-dynamic"
export default async function SharedPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  // Private content is fetched only by the online viewer; none enters the router's RSC cache.
  return <SharedView key={id} id={id} />
}
