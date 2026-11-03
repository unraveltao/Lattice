import { useEffect } from "react";

interface AppShortcutHandlers {
  toggleDebug: () => void;
  toggleAssistant: () => void;
  toggleOverview: () => void;
  toggleSearch: () => void;
}

export function useAppShortcuts({
  toggleDebug,
  toggleAssistant,
  toggleOverview,
  toggleSearch,
}: AppShortcutHandlers): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || !event.ctrlKey) return;
      const key = event.key.toLowerCase();

      if (event.shiftKey && key === "d") {
        event.preventDefault();
        toggleDebug();
      } else if (!event.shiftKey && key === "k") {
        event.preventDefault();
        toggleAssistant();
      } else if (event.shiftKey && key === "o") {
        event.preventDefault();
        toggleOverview();
      } else if (event.shiftKey && key === "f") {
        event.preventDefault();
        toggleSearch();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleAssistant, toggleDebug, toggleOverview, toggleSearch]);
}
