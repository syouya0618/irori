// @vitest-environment jsdom
import { cleanup,fireEvent,render,screen,waitFor } from "@testing-library/react"
import { afterEach,beforeEach,expect,it } from "vitest"
import { HomeTools,useHomeFocus } from "../home-tools"
const owner={userId:"synthetic-user",householdId:"synthetic-household",childId:"synthetic-child"}
function View({childId=owner.childId}:{childId?:string}){const f=useHomeFocus({...owner,childId});return <HomeTools childId={childId} months={25} choice={f.choice} onChoose={f.choose}/>}
beforeEach(()=>localStorage.clear());afterEach(cleanup)
it("keeps all functions accessible and remembers the chosen priority only for this child",async()=>{
 const first=render(<View/>);expect(screen.getAllByRole("link")[0]).toHaveTextContent("カスタム記録");expect(screen.getAllByRole("link")).toHaveLength(3)
 fireEvent.click(screen.getByText(/ホームの表示/));fireEvent.change(screen.getByLabelText("ホームで優先する機能"),{target:{value:"sleep"}})
 expect(screen.getAllByRole("link")[0]).toHaveTextContent("睡眠");expect(screen.getAllByRole("link")[0]).toHaveAttribute("href","/baby/sleep?child=synthetic-child")
 first.unmount();const second=render(<View/>);await waitFor(()=>expect(screen.getAllByRole("link")[0]).toHaveTextContent("睡眠"));second.unmount()
 render(<View childId="synthetic-sibling"/>);expect(screen.getAllByRole("link")[0]).toHaveTextContent("カスタム記録")
})
