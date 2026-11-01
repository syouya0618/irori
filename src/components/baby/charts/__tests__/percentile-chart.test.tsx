import { render,screen,cleanup } from "@testing-library/react"
import { afterEach,expect,it } from "vitest"
import { GrowthChartSection } from "../growth-chart-section"
afterEach(cleanup)
it("shows published age-bin bands with source, exact numeric table and no diagnostic claim",()=>{
 render(<GrowthChartSection birthDate="2025-01-01" sex="female" series={{weight:[{date:"2025-02-01",value:4400}],height:[{date:"2025-02-01",value:54.5}]}}/> )
 expect(screen.getByRole("img",{name:"体重の月齢別パーセンタイル帯と測定値"}).querySelectorAll("rect")).toHaveLength(22)
 expect(screen.getByRole("link",{name:/出典/})).toHaveAttribute("href","https://www.cfa.go.jp/policies/boshihoken/r5-nyuuyoujityousa/")
 expect(screen.getByText(/修正月齢や診断を表しません/)).toBeInTheDocument()
 expect(screen.getAllByText("1〜2か月未満")).toHaveLength(2)
})
it("unknown sex does not infer a reference and preserves measured values",()=>{
 render(<GrowthChartSection birthDate="2025-01-01" sex={null} series={{weight:[{date:"2025-02-01",value:4400}],height:[]}}/>)
 expect(screen.getByRole("img",{name:"体重の推移"})).toBeInTheDocument();expect(screen.getByText(/生年月日・性別が必要/)).toBeInTheDocument();expect(screen.getAllByText("4.4kg").length).toBeGreaterThan(0)
})
