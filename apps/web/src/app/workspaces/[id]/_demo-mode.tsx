"use client";

import { createContext, useContext } from "react";

/**
 * Demo-mode flag, sourced from the runtime `bootstrap` payload (the api's
 * server-side DEMO_MODE). Used to hide create/author UI for public demo
 * visitors. Cosmetic only — the api enforces the real boundary server-side, so
 * this never needs to be trusted for security.
 *
 * We thread it through React context (not NEXT_PUBLIC_DEMO_MODE) because the
 * web image is prebuilt from-registry: NEXT_PUBLIC_* is inlined at build time
 * and wouldn't reflect an operator's runtime flag, whereas bootstrap is read
 * live on every request.
 */
const DemoModeContext = createContext(false);

export function DemoModeProvider({
  demoMode,
  children,
}: {
  demoMode: boolean;
  children: React.ReactNode;
}) {
  return (
    <DemoModeContext.Provider value={demoMode}>
      {children}
    </DemoModeContext.Provider>
  );
}

export function useDemoMode(): boolean {
  return useContext(DemoModeContext);
}
