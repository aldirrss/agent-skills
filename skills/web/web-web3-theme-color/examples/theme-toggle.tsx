// components/theme-toggle.tsx
// Dark/light toggle button with hydration-safe rendering.

"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // Avoid hydration mismatch — theme is undefined on the server.
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <button
        type="button"
        aria-label="Toggle theme"
        className="theme-toggle-skeleton"
      />
    );
  }

  const isDark = theme === "dark";

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={`Switch to ${isDark ? "light" : "dark"} mode`}
      className="theme-toggle"
    >
      {isDark ? "☀️" : "🌙"}
    </button>
  );
}

/* Companion CSS (add to globals.css):

.theme-toggle,
.theme-toggle-skeleton {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-primary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.theme-toggle:hover {
  border-color: var(--border-glow);
  box-shadow: var(--glow-primary);
}

.theme-toggle:focus-visible {
  outline: 2px solid var(--accent-primary);
  outline-offset: 2px;
}
*/
