import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { NewsPreferences } from "../news-preferences"
import { saveNewsPreferences } from "@/app/(main)/news/actions"
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))
vi.mock("@/app/(main)/news/actions", () => ({ saveNewsPreferences: vi.fn() }))
afterEach(() => { cleanup(); vi.resetAllMocks() })
it("keeps success through refreshed preference versions while resetting the controls to server values", async () => {
 vi.mocked(saveNewsPreferences).mockResolvedValue({ status: "saved" })
 const view = render(<NewsPreferences region={null} enabled={false} version={null}/>)
 fireEvent.change(screen.getByLabelText("ニュースの地域"), { target: { value: "sapporo" } })
 await act(async () => fireEvent.click(screen.getByRole("button", { name: "ニュース設定を保存" })))
 expect(screen.getByRole("status")).toHaveTextContent("保存しました")
 view.rerender(<NewsPreferences region="sapporo" enabled={true} version="2026-11-01T00:00:00Z"/>)
 expect(screen.getByRole("status")).toHaveTextContent("保存しました")
 expect(screen.getByLabelText("新着がある朝8時に通知する")).toBeChecked()
 await act(async () => fireEvent.click(screen.getByRole("button", { name: "ニュース設定を保存" })))
 expect(saveNewsPreferences).toHaveBeenLastCalledWith("sapporo", true, "2026-11-01T00:00:00Z")
})
it("does not turn a rejected request or network exception into success", async () => {
 vi.mocked(saveNewsPreferences).mockResolvedValueOnce({ error: "synthetic rejected" }).mockRejectedValueOnce(new Error("synthetic offline"))
 render(<NewsPreferences region="sapporo" enabled={false} version={null}/>)
 await act(async () => fireEvent.click(screen.getByRole("button", { name: "ニュース設定を保存" })))
 expect(screen.getByRole("status")).toHaveTextContent("synthetic rejected")
 await act(async () => fireEvent.click(screen.getByRole("button", { name: "ニュース設定を保存" })))
 expect(screen.getByRole("status")).toHaveTextContent("保存結果を確認できませんでした")
 expect(refresh).not.toHaveBeenCalled()
})

it("defaults to no region and no notification, and only submits the explicitly chosen region and version",async()=>{
 vi.mocked(saveNewsPreferences).mockResolvedValue({status:"saved"});render(<NewsPreferences region={null} enabled={false} version={null}/> )
 expect(screen.getByRole("checkbox")).not.toBeChecked();expect(screen.getByLabelText("ニュースの地域")).toHaveValue("")
 fireEvent.change(screen.getByLabelText("ニュースの地域"),{target:{value:"sapporo"}});fireEvent.click(screen.getByRole("button",{name:"ニュース設定を保存"}));await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("保存しました"));expect(saveNewsPreferences).toHaveBeenCalledWith("sapporo",false,null)
})
it("does not claim success after a lost response",async()=>{
 vi.mocked(saveNewsPreferences).mockRejectedValue(new Error("synthetic lost response"));render(<NewsPreferences region="yokohama" enabled={true} version="2026-01-01T00:00:00Z"/>);fireEvent.click(screen.getByRole("button",{name:"ニュース設定を保存"}));await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("保存結果を確認できません"))
})
