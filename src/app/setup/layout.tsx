export default function SetupLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // (auth)/layout.tsx と同じ殻。bg-hearth はテーマに追従する（globals.css）
  return <div className="bg-hearth min-h-dvh">{children}</div>
}
