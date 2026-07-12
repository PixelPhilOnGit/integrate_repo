import { useUiStore } from "@/stores/uiStore";
import { useConversationStore } from "@/stores/conversationStore";
import {
  MessagesSquare,
  Subtitles,
  Settings,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { AppMode } from "@/types";

const NAV_ITEMS: { mode: AppMode; label: string; icon: typeof MessagesSquare }[] = [
  { mode: "conversation", label: "Conversation", icon: MessagesSquare },
  { mode: "simultaneous", label: "Simultaneous", icon: Subtitles },
  { mode: "settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const currentMode = useConversationStore((s) => s.currentMode);
  const setMode = useConversationStore((s) => s.setMode);

  return (
    <aside
      className={cn(
        "flex flex-col border-r bg-background transition-all duration-300 ease-in-out",
        sidebarOpen ? "w-56" : "w-12"
      )}
    >
      {/* Logo / App name */}
      <div className="flex h-12 items-center border-b px-3">
        {sidebarOpen ? (
          <span className="text-lg font-bold tracking-tight text-primary">
            VoiceLingua
          </span>
        ) : (
          <span className="mx-auto text-lg font-bold text-primary">V</span>
        )}
      </div>

      {/* Navigation items */}
      <nav className="flex-1 space-y-1 p-2">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = currentMode === item.mode;
          return (
            <button
              key={item.mode}
              onClick={() => setMode(item.mode)}
              className={cn(
                "flex w-full items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              )}
              title={!sidebarOpen ? item.label : undefined}
            >
              <Icon className="h-5 w-5 shrink-0" />
              {sidebarOpen && <span>{item.label}</span>}
            </button>
          );
        })}
      </nav>

      {/* Collapse toggle */}
      <div className="border-t p-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleSidebar}
          className="w-full justify-center"
          aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
        >
          {sidebarOpen ? (
            <ChevronLeft className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </Button>
      </div>

      {/* Footer */}
      {sidebarOpen && (
        <div className="border-t px-3 py-2">
          <p className="text-xs text-muted-foreground">v0.1.0</p>
          <a
            href="https://github.com/your-org/voice-translation-app"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            GitHub
          </a>
        </div>
      )}
    </aside>
  );
}
