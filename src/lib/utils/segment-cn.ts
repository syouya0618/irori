export function segmentCn(active: boolean): string {
  return `flex-1 rounded-lg px-2 py-2 text-sm font-medium transition-colors duration-200 ${
    active
      ? "bg-primary text-primary-foreground"
      : "bg-muted text-muted-foreground hover:text-foreground"
  }`
}
