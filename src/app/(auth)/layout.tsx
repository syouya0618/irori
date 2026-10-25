export default function AuthLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // bg-hearth はテーマに追従する（globals.css）。以前の orange-50 / amber-50 の直書きは
  // ダーク時も明るいまま残り、カードの外の見出し・説明・エラー通知が読めなんだ
  return <div className="bg-hearth min-h-dvh">{children}</div>
}
