"use client";

import { useEffect } from "react";

// intent: DEC-515 — abort handler は module-level registry 経由で prop-drilling を回避
let globalAbortHandler: (() => void) | null = null;

export function registerAbortHandler(handler: (() => void) | null): void {
  globalAbortHandler = handler;
}

interface UseGlobalKeyboardShortcutsOptions {
  onNewSession?: (cwd: string) => void;
  activeCwd?: string | null;
}

// intent: DEC-516 — global Esc は textarea/input 内では発火させず ChatInput の menu 制御に譲る
export function useGlobalKeyboardShortcuts(
  options: UseGlobalKeyboardShortcutsOptions,
): void {
  const { onNewSession, activeCwd } = options;

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        if (!globalAbortHandler) return;

        const tag = (e.target as HTMLElement)?.tagName;
        // intent: DEC-516 — textarea/input 内では ChatInput の menu 制御に譲る
        if (tag === "TEXTAREA" || tag === "INPUT") return;

        e.preventDefault();
        globalAbortHandler();
        return;
      }

      if (e.key === "n" && e.ctrlKey && e.altKey) {
        if (!activeCwd || !onNewSession) return;
        e.preventDefault();
        onNewSession(activeCwd);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeCwd, onNewSession]);
}
