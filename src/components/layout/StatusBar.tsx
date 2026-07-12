import { useEffect, useState } from "react";
import { useConversationStore } from "@/stores/conversationStore";
import { getUsageStats } from "@/services/usageTracker";
import { cn } from "@/lib/utils";
import type { UsageStats } from "@/types";

export function StatusBar() {
  const statusMessage = useConversationStore((s) => s.statusMessage);
  const [online, setOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const [stats, setStats] = useState<UsageStats>({
    totalTokens: 0,
    totalCost: 0,
    requestCount: 0,
    lastResetDate: "",
    dailyStats: {},
  });

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Load usage stats on mount and on each status message change
  // (status message changes indicate a new translation completed)
  useEffect(() => {
    try {
      setStats(getUsageStats());
    } catch {
      // localStorage may be unavailable — use defaults
    }
  }, [statusMessage]);

  return (
    <footer className="flex h-6 items-center justify-between border-t bg-background px-3 text-xs text-muted-foreground">
      {/* Left: connection status */}
      <span className="flex items-center gap-1.5">
        <span
          className={cn(
            "h-2 w-2 rounded-full",
            online ? "bg-green-500" : "bg-red-500"
          )}
        />
        {online ? "Connected" : "Offline"}
      </span>

      {/* Center: status message */}
      {statusMessage && (
        <span className="truncate max-w-[40%] text-center">{statusMessage}</span>
      )}

      {/* Right: API usage */}
      <span className="tabular-nums">
        {stats.totalTokens.toLocaleString()} tokens today
        {stats.totalCost > 0 && ` | $${stats.totalCost.toFixed(4)}`}
      </span>
    </footer>
  );
}
