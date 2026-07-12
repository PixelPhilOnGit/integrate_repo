import { useEffect, useCallback, lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { TitleBar } from "./TitleBar";
import { StatusBar } from "./StatusBar";
import { useUiStore } from "@/stores/uiStore";
import { useConversationStore } from "@/stores/conversationStore";
import type { AppMode } from "@/types";

// Lazy-load pages so only the active mode's code is fetched and rendered.
const ConversationPage = lazy(() => import("@/pages/ConversationPage"));
const SimultaneousPage = lazy(() => import("@/pages/SimultaneousPage"));
const SettingsPage = lazy(() => import("@/pages/SettingsPage"));

function PageLoader() {
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

function ActivePage({ mode }: { mode: AppMode }) {
  switch (mode) {
    case "conversation":
      return <ConversationPage />;
    case "simultaneous":
      return <SimultaneousPage />;
    case "settings":
      return <SettingsPage />;
    default:
      return <ConversationPage />;
  }
}

export function AppShell() {
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const currentMode = useConversationStore((s) => s.currentMode);

  /**
   * Auto-close the sidebar on narrow viewports. When the viewport is below
   * 768 px wide the sidebar is collapsed by default. The user can still
   * toggle it, but on window resize below the threshold we force it closed.
   */
  const handleResize = useCallback(() => {
    if (window.innerWidth < 768 && sidebarOpen) {
      setSidebarOpen(false);
    }
  }, [sidebarOpen, setSidebarOpen]);

  useEffect(() => {
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [handleResize]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      {/* Sidebar */}
      <Sidebar />

      {/* Main content area */}
      <div className="flex flex-1 flex-col min-w-0">
        <TitleBar />

        <main className="flex-1 overflow-auto">
          <Suspense fallback={<PageLoader />}>
            <ActivePage mode={currentMode} />
          </Suspense>
        </main>

        <StatusBar />
      </div>
    </div>
  );
}
