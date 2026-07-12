/**
 * Recording / processing state indicator.
 *
 * Displays a contextual icon, label, and colour based on the current
 * recording pipeline state. Provides clear visual feedback for each
 * stage of the speak → recognise → translate → play cycle.
 */

import { Mic, Loader2, Volume2, Circle } from 'lucide-react';
import type { RecordingState } from '@/types';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface StatusConfig {
  icon: React.ReactNode;
  label: string;
  className: string;
  dotClassName: string;
}

function getStatusConfig(state: RecordingState): StatusConfig {
  switch (state) {
    case 'idle':
      return {
        icon: <Mic className="h-4 w-4" />,
        label: 'Ready',
        className: 'text-muted-foreground',
        dotClassName: 'bg-muted-foreground',
      };
    case 'recording':
      return {
        icon: <Circle className="h-4 w-4 fill-current animate-pulse" />,
        label: 'Listening...',
        className: 'text-red-500',
        dotClassName: 'bg-red-500',
      };
    case 'recognizing':
      return {
        icon: <Loader2 className="h-4 w-4 animate-spin" />,
        label: 'Recognizing...',
        className: 'text-amber-500',
        dotClassName: 'bg-amber-500',
      };
    case 'translating':
      return {
        icon: <Loader2 className="h-4 w-4 animate-spin" />,
        label: 'Translating...',
        className: 'text-blue-500',
        dotClassName: 'bg-blue-500',
      };
    case 'playing':
      return {
        icon: <Volume2 className="h-4 w-4" />,
        label: 'Playing...',
        className: 'text-green-500',
        dotClassName: 'bg-green-500',
      };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface StatusIndicatorProps {
  /** The current recording pipeline state. */
  state: RecordingState;
}

export function StatusIndicator({ state }: StatusIndicatorProps) {
  const config = getStatusConfig(state);

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 text-sm font-medium transition-colors duration-300',
        config.className,
      )}
      aria-live="polite"
      aria-label={`Status: ${config.label}`}
    >
      <span className="flex items-center gap-1.5">
        <span className={cn('h-1.5 w-1.5 rounded-full transition-colors duration-300', config.dotClassName)} />
        {config.icon}
      </span>
      <span>{config.label}</span>
    </div>
  );
}
