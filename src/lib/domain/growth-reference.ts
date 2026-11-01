import data from "@/lib/data/japan-growth-2023.json"
export { ageMonthsAt } from "./child-age"
export type GrowthSex="male"|"female"
export type GrowthMeasure="weightKg"|"heightCm"
export const GROWTH_REFERENCE=data
export function growthReferenceAt(months:number,sex:GrowthSex,measure:GrowthMeasure):readonly number[]|null{
 if(!Number.isFinite(months))return null
 return data[measure].find(r=>months>=r.fromMonths&&months<r.toMonths)?.[sex]??null
}
