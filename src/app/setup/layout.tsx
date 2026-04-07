export default function SetupLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <div className="bg-gradient-to-br from-orange-50 via-amber-50/50 to-rose-50/30 min-h-dvh">
      {children}
    </div>
  )
}
