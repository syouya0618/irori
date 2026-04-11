export const VALID_PAGES = ["meals", "shopping", "stock", "baby"] as const
export type ValidPage = (typeof VALID_PAGES)[number]
