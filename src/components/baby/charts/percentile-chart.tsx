import { GROWTH_REFERENCE,ageMonthsAt,type GrowthMeasure,type GrowthSex } from "@/lib/domain/growth-reference"
import type { GrowthPoint } from "@/lib/domain/baby-log-aggregation"
/** Published age bins are rectangles/steps; no missing percentile or smooth curve is invented. */
export function PercentileChart({points,birthDate,sex,measure,label}:{points:GrowthPoint[];birthDate:string;sex:GrowthSex;measure:GrowthMeasure;label:string}){
 const measured=points.map(p=>({...p,age:ageMonthsAt(birthDate,p.date),value:measure==="weightKg"?p.value/1000:p.value})).filter((p):p is typeof p&{age:number}=>p.age!==null&&p.age>=0&&p.age<78)
 if(!measured.length)return <p className="py-3 text-xs text-muted-foreground">この記録の月齢に対応する基準帯はありません（収録範囲: 1か月〜6歳6か月未満）。</p>
 const end=Math.min(78,Math.max(12,(Math.floor(Math.max(...measured.map(p=>p.age))/12)+1)*12)),bins=GROWTH_REFERENCE[measure].filter(r=>r.fromMonths<end)
 const values=[...measured.map(p=>p.value),...bins.flatMap(r=>[r[sex][0],r[sex][6]])]
 const min=Math.min(...values)*0.95,max=Math.max(...values)*1.05,x=(m:number)=>32+m/end*244,y=(v:number)=>112-(v-min)/(max-min)*100
 return <><svg role="img" aria-label={`${label}の月齢別パーセンタイル帯と測定値`} viewBox="0 0 290 140" className="h-44 w-full">
  <title>日本・令和5年調査 {sex==="male"?"男子":"女子"}。薄い帯3〜97、濃い帯25〜75、線50パーセンタイル。月齢区分ごとの公表値。</title>
  {bins.map(r=><g key={r.fromMonths}><rect x={x(r.fromMonths)} y={y(r[sex][6])} width={x(Math.min(end,r.toMonths))-x(r.fromMonths)} height={y(r[sex][0])-y(r[sex][6])} className="fill-primary/15"/><rect x={x(r.fromMonths)} y={y(r[sex][4])} width={x(Math.min(end,r.toMonths))-x(r.fromMonths)} height={y(r[sex][2])-y(r[sex][4])} className="fill-primary/20"/><line x1={x(r.fromMonths)} x2={x(Math.min(end,r.toMonths))} y1={y(r[sex][3])} y2={y(r[sex][3])} className="stroke-primary/70" strokeWidth={1}/></g>)}
  <line x1={32} x2={276} y1={114} y2={114} className="stroke-border"/>
  {[0,end/2,end].map(m=><text key={m} x={x(m)} y={133} textAnchor="middle" className="fill-muted-foreground text-[9px]">{m}か月</text>)}
  {[min,max].map(v=><text key={v} x={29} y={y(v)+3} textAnchor="end" className="fill-muted-foreground text-[9px]">{v.toFixed(1)}</text>)}
  {measured.length>1&&<polyline points={measured.map(p=>`${x(p.age)},${y(p.value)}`).join(" ")} fill="none" className="stroke-foreground" strokeWidth={1.5}/>}
  {measured.map((p,i)=><circle key={`${p.date}:${i}`} cx={x(p.age)} cy={y(p.value)} r={3} className="fill-foreground"><title>{p.date}: {p.age.toFixed(1)}か月 {p.value}{measure==="weightKg"?"kg":"cm"}</title></circle>)}
 </svg><p className="text-xs text-muted-foreground">{measure==="weightKg"?"kg":"cm"}・{sex==="male"?"男子":"女子"}。薄い帯3〜97、濃い帯25〜75、線50。1か月未満は帯なし。</p>
 <details className="text-xs"><summary className="min-h-11 py-3">月齢区分の数値を確認</summary><div className="overflow-x-auto"><table className="w-full text-right"><caption className="text-left">公表値（3 / 25 / 50 / 75 / 97パーセンタイル）</caption><tbody>{bins.map(r=><tr key={r.fromMonths}><th className="whitespace-nowrap p-1 text-left">{r.fromMonths}〜{r.toMonths}か月未満</th>{[0,2,3,4,6].map(i=><td className="p-1" key={i}>{r[sex][i]}</td>)}</tr>)}</tbody></table></div></details>
 {measured.length<points.length&&<p className="text-xs">対象月齢外の測定は帯のグラフに含めていません。記録と数値一覧は保持しています。</p>}</>
}
