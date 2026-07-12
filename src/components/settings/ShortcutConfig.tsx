/**
 * Keyboard shortcut configuration display.
 *
 * Shows the current push-to-talk shortcut and a reference table of all
 * available shortcuts. Custom keybinding capture is marked as "coming soon".
 */

import { Keyboard, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Shortcut definitions
// ---------------------------------------------------------------------------

interface ShortcutEntry {
  keys: string[];
  description: string;
}

const SHORTCUTS: ShortcutEntry[] = [
  { keys: ['Space'], description: 'Push to talk (hold)' },
  { keys: ['Esc'], description: 'Cancel recording' },
  { keys: ['Ctrl', 'Shift', 'T'], description: 'Toggle translation mode' },
  { keys: ['Ctrl', ','], description: 'Open settings' },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ShortcutConfig() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Keyboard Shortcuts</CardTitle>
        <CardDescription>
          Configure shortcuts for common actions.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Current push-to-talk key */}
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">Push-to-Talk</p>
          <div className="flex items-center gap-3">
            <kbd
              className={cn(
                'inline-flex h-8 min-w-[3rem] items-center justify-center rounded-md border px-3',
                'bg-muted text-sm font-semibold text-foreground shadow-sm',
                'font-mono tracking-wider',
              )}
            >
              Space
            </kbd>
            <Button
              variant="outline"
              size="sm"
              disabled
              className="gap-1.5 opacity-60"
              aria-label="Record new shortcut — coming soon"
            >
              <Keyboard className="h-3.5 w-3.5" />
              Record
            </Button>
            <Badge variant="outline" className="text-[10px] gap-1">
              <Sparkles className="h-3 w-3" />
              Coming soon
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Press and hold Space to start recording, release to stop.
          </p>
        </div>

        {/* Shortcut reference table */}
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">All Shortcuts</p>
          <div className="overflow-hidden rounded-lg border">
            {SHORTCUTS.map((shortcut) => (
              <div
                key={shortcut.keys.join('+')}
                className="flex items-center justify-between px-3 py-2 text-sm even:bg-muted/30"
              >
                <span className="text-xs text-muted-foreground">
                  {shortcut.description}
                </span>
                <div className="flex items-center gap-1">
                  {shortcut.keys.map((key, i) => (
                    <span key={key} className="flex items-center gap-1">
                      <kbd className="inline-flex h-6 items-center rounded border bg-background px-1.5 text-xs font-medium text-foreground shadow-sm font-mono">
                        {key}
                      </kbd>
                      {i < shortcut.keys.length - 1 && (
                        <span className="text-xs text-muted-foreground">+</span>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer note */}
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Sparkles className="h-3 w-3" />
          Custom shortcuts coming soon
        </p>
      </CardContent>
    </Card>
  );
}
