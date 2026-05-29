// app/providers.tsx
// Wraps the Next.js App Router with next-themes for theme switching.
// Install: npm install next-themes

"use client";

import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";

interface ProvidersProps {
  children: ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  return (
    <ThemeProvider
      attribute="data-theme"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange={false}
      themes={["dark", "light"]}
    >
      {children}
    </ThemeProvider>
  );
}

// app/layout.tsx
// Note: suppressHydrationWarning is REQUIRED on <html> to prevent
// hydration mismatch when next-themes injects the data-theme attribute.

/*
import { Providers } from "./providers";
import "./globals.css";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
*/
