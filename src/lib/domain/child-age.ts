import { daysBetweenYmd,isValidYmd } from "@/lib/utils/date-jst"
/** Calendar-month age with the birthday clamped at month end. No gestational-age correction is inferred. */
export function ageMonthsAt(birth:string|null,date:string):number|null{
 if(!isValidYmd(birth)||!isValidYmd(date)||date<birth)return null
 const [by,bm,bd]=birth.split("-").map(Number),[y,m]=date.split("-").map(Number)
 const anchor=(n:number)=>{const d=new Date(Date.UTC(by,bm-1+n,1));const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(bd,last));return d.toISOString().slice(0,10)}
 let months=(y-by)*12+m-bm;if(anchor(months)>date)months--
 const from=anchor(months),to=anchor(months+1)
 return months+(daysBetweenYmd(from,date)??0)/(daysBetweenYmd(from,to)??1)
}
