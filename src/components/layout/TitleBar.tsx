import { useConversationStore } from "@/stores/conversationStore";
import { useTheme } from "@/hooks/useTheme";
import { Button } from "@/components/ui/button";
import { Sun, Moon } from "lucide-react";
import { cn } from "@/lib/utils";

const MODE_LABELS: Record<string, string> = {
  conversation: "Conversation",
  simultaneous: "Simultaneous Interpretation",
  settings: "Settings",
};

const RECORDING_COLORS: Record<string, string> = {
  idle: "bg-muted-foreground",
  recording: "bg-red-500 animate-pulse",
  recognizing: "bg-yellow-500 animate-pulse",
  translating: "bg-yellow-500",
  playing: "bg-green-500",
};

export function TitleBar() {
  const currentMode = useConversationStore((s) => s.currentMode);
  const recordingState = useConversationStore((s) => s.recordingState);
  const { theme, setTheme } = useTheme();

  const isDark = theme === "dark";
  const modeLabel = MODE_LABELS[currentMode] ?? "VoiceLingua";
  const recordingDot = RECORDING_COLORS[recordingState] ?? RECORDING_COLORS.idle;
  const isRecording = recordingState === "recording";
  const isActive = recordingState !== "idle";

  return (
    <header
      className="flex h-12 items-center justify-between border-b bg-background px-4 select-none"
      data-tauri-drag-region
    >
      {/* Left: macOS traffic light padding + mode label */}
      <div className="flex items-center gap-3 pl-[76px] lg:pl-[80px]" data-tauri-drag-region>
        <h1 className="text-sm font-semibold text-foreground" data-tauri-drag-region>
          {modeLabel}
        </h1>

        {/* Recording status */}
        {isActive && (
          <span className="flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            <span className={cn("h-2 w-2 rounded-full", recordingDot)} />
            {isRecording ? "Recording" : recordingState}
          </span>
        )}
      </div>

      {/* Right: actions */}
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTheme(isDark ? "light" : "dark")}
          aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
        >
          {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
      </div>
    </header>
  );
}
