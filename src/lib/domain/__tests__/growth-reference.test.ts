import { describe,expect,it } from "vitest"
import { ageMonthsAt,GROWTH_REFERENCE,growthReferenceAt } from "../growth-reference"
describe("official Japanese 2023 growth reference",()=>{
 it("keeps the published table values and does not interpolate missing months",()=>{
  expect(growthReferenceAt(1,"male","weightKg")).toEqual([3.76,4.09,4.43,4.8,5.16,5.49,5.8])
  expect(growthReferenceAt(17.9,"female","heightCm")).toEqual([70.3,72,73.6,75.3,77,78.5,80])
  expect(growthReferenceAt(72,"female","heightCm")).toEqual([105.4,108.1,110.9,114.1,117.3,120.2,123.2])
  for(const age of [-1,0,0.99,78,Infinity,NaN])expect(growthReferenceAt(age,"male","weightKg")).toBeNull()
 })
 it("uses contiguous published bins and ascending percentile values for both sexes and measures",()=>{
  for(const rows of [GROWTH_REFERENCE.weightKg,GROWTH_REFERENCE.heightCm]){
   expect(rows).toHaveLength(22)
   rows.forEach((r,i)=>{if(i)expect(r.fromMonths).toBe(rows[i-1].toMonths);for(const sex of ["male","female"] as const){expect(r[sex]).toHaveLength(7);expect(r[sex].every((v,j)=>v>0&&(j===0||v>r[sex][j-1]))).toBe(true)}})
  }
 })
 it("uses calendar month boundaries including month-end birthdays; future and invalid dates have no age",()=>{
  expect(ageMonthsAt("2026-01-31","2026-02-28")).toBe(1)
  expect(ageMonthsAt("2024-02-29","2025-02-28")).toBe(12)
  expect(ageMonthsAt("2026-01-01","2026-01-16")).toBeCloseTo(15/31)
  expect(ageMonthsAt("2026-02-30","2026-03-01")).toBeNull();expect(ageMonthsAt("2026-03-01","2026-02-01")).toBeNull()
 })
})
