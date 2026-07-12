/**
 * API usage statistics display.
 *
 * Shows total tokens used, estimated cost, request count, a 7-day daily
 * usage bar chart, and a reset option. Warns when monthly costs exceed
 * a configurable threshold.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  BarChart3,
  AlertTriangle,
  RotateCcw,
  Coins,
  FileText,
  Activity,
} from 'lucide-react';
import { getUsageStats, resetStats } from '@/services/usageTracker';
import type { UsageStats } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/useToast';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COST_WARNING_THRESHOLD = 1.0; // ¥

function getLast7Days(): string[] {
  const days: string[] = [];
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    days.push(`${y}-${m}-${day}`);
  }
  return days;
}

function formatDayLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString(undefined, { weekday: 'short' });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function UsageStats() {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);

  // Load stats on mount
  const loadStats = useCallback(() => {
    setLoading(true);
    try {
      const data = getUsageStats();
      setStats(data);
    } catch (err) {
      console.error('[UsageStats] Failed to load stats:', err);
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  // Reset handler
  const handleReset = useCallback(() => {
    try {
      resetStats();
      setResetDialogOpen(false);
      loadStats();
      toast({ title: 'Usage statistics have been reset.' });
    } catch {
      toast({ title: 'Failed to reset statistics.', variant: 'destructive' });
    }
  }, [loadStats]);

  // 7-day chart data
  const last7Days = useMemo(() => getLast7Days(), []);

  const chartData = useMemo(() => {
    if (!stats) return [];
    const maxTokens = Math.max(
      ...last7Days.map((day) => stats.dailyStats[day]?.tokens ?? 0),
      1, // avoid division by zero
    );
    return last7Days.map((day) => {
      const daily = stats.dailyStats[day];
      return {
        date: day,
        label: formatDayLabel(day),
        tokens: daily?.tokens ?? 0,
        cost: daily?.cost ?? 0,
        heightPercent: ((daily?.tokens ?? 0) / maxTokens) * 100,
      };
    });
  }, [stats, last7Days]);

  const isOverBudget = (stats?.totalCost ?? 0) > COST_WARNING_THRESHOLD;

  // ---- Loading state ----
  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Usage Statistics</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        </CardContent>
      </Card>
    );
  }

  // ---- Empty state ----
  if (!stats || stats.requestCount === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Usage Statistics</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <div className="rounded-full bg-muted p-3">
              <BarChart3 className="h-6 w-6 text-muted-foreground/60" />
            </div>
            <p className="text-sm text-muted-foreground">
              No usage data yet. Start translating to see statistics.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  // ---- Main content ----

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Usage Statistics</CardTitle>
            <CardDescription>
              DeepSeek API usage and estimated costs.
            </CardDescription>
          </div>
          {/* Reset dialog */}
          <Dialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Reset statistics">
                <RotateCcw className="h-4 w-4" />
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Reset usage statistics?</DialogTitle>
                <DialogDescription>
                  This will permanently clear all usage data including tokens, cost, and
                  daily breakdowns. This action cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline">Cancel</Button>
                </DialogClose>
                <Button variant="destructive" onClick={handleReset}>
                  Reset
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* Stat cards */}
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border bg-card p-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              <FileText className="h-3.5 w-3.5" />
              Tokens
            </div>
            <p className="text-lg font-semibold tabular-nums">
              {stats.totalTokens.toLocaleString()}
            </p>
          </div>
          <div className="rounded-lg border bg-card p-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              <Coins className="h-3.5 w-3.5" />
              Cost
            </div>
            <p className="text-lg font-semibold tabular-nums">
              {'¥'}{stats.totalCost.toFixed(4)}
            </p>
          </div>
          <div className="rounded-lg border bg-card p-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              <Activity className="h-3.5 w-3.5" />
              Requests
            </div>
            <p className="text-lg font-semibold tabular-nums">
              {stats.requestCount.toLocaleString()}
            </p>
          </div>
        </div>

        {/* 7-day bar chart */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Last 7 Days (tokens)</p>
          <div className="flex items-end gap-2" style={{ height: '80px' }}>
            {chartData.map((day) => (
              <div
                key={day.date}
                className="flex flex-1 flex-col items-center gap-1 h-full justify-end"
                title={`${day.label}: ${day.tokens.toLocaleString()} tokens`}
              >
                <div
                  className={cn(
                    'w-full rounded-t transition-all duration-300',
                    day.tokens > 0 ? 'bg-primary/60 hover:bg-primary/80' : 'bg-muted-foreground/10 h-1',
                  )}
                  style={{ height: `${Math.max(day.heightPercent, 2)}%` }}
                />
                <span className="text-[10px] text-muted-foreground/60">{day.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Budget warning */}
        {isOverBudget && (
          <div className="flex items-start gap-1.5 rounded bg-amber-50 dark:bg-amber-950/20 p-2 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Estimated cost ({'¥'}{stats.totalCost.toFixed(4)}) exceeds
            {'¥'}{COST_WARNING_THRESHOLD.toFixed(2)} threshold.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
