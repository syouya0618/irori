export type HomeFocus="auto"|"sleep"|"medical"|"custom"
export type HomeDetail="temperature"|"diary"|"weekly"|"growth"
export function resolvedHomeFocus(months:number|null,choice:HomeFocus):Exclude<HomeFocus,"auto">{
 if(choice!=="auto")return choice
 return months===null||months<6?"sleep":months<24?"medical":"custom"
}
export function homeDetailOrder(months:number|null,choice:HomeFocus):HomeDetail[]{
 const focus=resolvedHomeFocus(months,choice)
 return focus==="sleep"?["temperature","diary","growth","weekly"]:focus==="medical"?["growth","diary","temperature","weekly"]:["diary","weekly","growth","temperature"]
}
export const HOME_FOCUS_PREFIX="irori:home-focus:v1:"
