# Layout & Routing

App Router structure, sidebar navigation, auth guard, and page skeletons.

## Table of contents
- Directory structure
- Root layout + providers
- Auth guard
- Dashboard layout + sidebar
- Page skeletons

---

## Directory structure

```
app/
├── globals.css
├── layout.tsx                    ← root layout (html/body, providers)
├── (auth)/
│   └── login/
│       └── page.tsx
└── (dashboard)/
    ├── layout.tsx                ← sidebar + WebSocketProvider
    ├── page.tsx                  ← redirect to /dashboard
    ├── dashboard/
    │   └── page.tsx
    ├── positions/
    │   └── page.tsx
    ├── trades/
    │   └── page.tsx
    └── settings/
        └── page.tsx

components/
├── layout/
│   ├── Sidebar.tsx
│   ├── BotStatusBadge.tsx
│   └── NavItem.tsx
├── providers/
│   ├── QueryProvider.tsx
│   └── WebSocketProvider.tsx
└── ui/                           ← shadcn/ui components (auto-generated)
```

---

## Root layout

```tsx
// app/layout.tsx
import type { Metadata } from "next"
import { Inter } from "next/font/google"
import { Toaster } from "@/components/ui/toaster"
import QueryProvider from "@/components/providers/QueryProvider"
import "./globals.css"

const inter = Inter({ subsets: ["latin"] })

export const metadata: Metadata = {
  title: "Futures Bot Dashboard",
  description: "Crypto futures trading bot control panel",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.className} bg-slate-950 text-slate-100 antialiased`}>
        <QueryProvider>
          {children}
          <Toaster />
        </QueryProvider>
      </body>
    </html>
  )
}
```

```tsx
// components/providers/QueryProvider.tsx
"use client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useState } from "react"

export default function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime:  30_000,    // 30s — data stays fresh
        retry:      2,
        refetchOnWindowFocus: false,
      },
    },
  }))
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
```

---

## Auth guard

Simple password gate — not OAuth. Bot dashboard is internal tooling.

```tsx
// middleware.ts (Next.js middleware)
import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

export function middleware(request: NextRequest) {
  const token = request.cookies.get("bot_session")?.value
  const isLogin = request.nextUrl.pathname.startsWith("/login")

  if (!token && !isLogin) {
    return NextResponse.redirect(new URL("/login", request.url))
  }
  if (token && isLogin) {
    return NextResponse.redirect(new URL("/dashboard", request.url))
  }
  return NextResponse.next()
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
}
```

```tsx
// app/(auth)/login/page.tsx
"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export default function LoginPage() {
  const [password, setPassword] = useState("")
  const [error, setError]       = useState("")
  const router = useRouter()

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    })
    if (res.ok) {
      router.push("/dashboard")
    } else {
      setError("Invalid password")
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950">
      <Card className="w-80 bg-slate-900 border-slate-800">
        <CardHeader>
          <CardTitle className="text-center text-slate-100">Bot Dashboard</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="space-y-4">
            <Input
              type="password"
              placeholder="Access password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="bg-slate-800 border-slate-700"
            />
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <Button type="submit" className="w-full">Enter</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
```

---

## Dashboard layout + sidebar

```tsx
// app/(dashboard)/layout.tsx
import Sidebar from "@/components/layout/Sidebar"
import WebSocketProvider from "@/components/providers/WebSocketProvider"

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <WebSocketProvider>
      <div className="flex h-screen bg-slate-950">
        <Sidebar />
        <main className="flex-1 overflow-y-auto p-6">
          {children}
        </main>
      </div>
    </WebSocketProvider>
  )
}
```

```tsx
// components/layout/Sidebar.tsx
"use client"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { LayoutDashboard, TrendingUp, History, Settings, Zap } from "lucide-react"
import { cn } from "@/lib/utils"
import BotStatusBadge from "./BotStatusBadge"

const NAV_ITEMS = [
  { href: "/dashboard",  label: "Overview",   icon: LayoutDashboard },
  { href: "/positions",  label: "Positions",  icon: TrendingUp },
  { href: "/trades",     label: "Trades",     icon: History },
  { href: "/settings",   label: "Settings",   icon: Settings },
]

export default function Sidebar() {
  const pathname = usePathname()
  return (
    <aside className="w-56 flex-shrink-0 bg-slate-900 border-r border-slate-800
                      flex flex-col py-6 px-3 gap-1">
      {/* Logo */}
      <div className="flex items-center gap-2 px-3 mb-6">
        <Zap className="text-amber-400" size={20} />
        <span className="font-semibold text-slate-100 text-sm">Futures Bot</span>
      </div>

      {/* Nav */}
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
        <Link key={href} href={href}
          className={cn(
            "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
            pathname === href
              ? "bg-slate-800 text-slate-100"
              : "text-slate-400 hover:text-slate-100 hover:bg-slate-800/50"
          )}>
          <Icon size={16} />
          {label}
        </Link>
      ))}

      {/* Bot status at bottom */}
      <div className="mt-auto px-3">
        <BotStatusBadge />
      </div>
    </aside>
  )
}
```

```tsx
// components/layout/BotStatusBadge.tsx
"use client"
import { useBotStore } from "@/store/botStore"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

export default function BotStatusBadge() {
  const status  = useBotStore(s => s.botStatus)
  const workers = useBotStore(s => s.activeWorkers)

  const colors = {
    running: "bg-green-500/20 text-green-400 border-green-500/30",
    paused:  "bg-amber-500/20 text-amber-400 border-amber-500/30",
    stopped: "bg-slate-500/20 text-slate-400 border-slate-500/30",
    unknown: "bg-slate-500/20 text-slate-500 border-slate-700",
  }

  return (
    <div className="space-y-1">
      <Badge variant="outline"
        className={cn("w-full justify-center text-xs", colors[status] ?? colors.unknown)}>
        {status.toUpperCase()}
      </Badge>
      <p className="text-xs text-slate-500 text-center">
        {workers.length} worker{workers.length !== 1 ? "s" : ""}
      </p>
    </div>
  )
}
```
