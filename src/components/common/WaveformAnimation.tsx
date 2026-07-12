/**
 * Audio waveform visualization with animated vertical bars.
 *
 * Renders 5 bars that bounce up and down when active, or sit at a
 * static minimum height when inactive.
 */

import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface WaveformAnimationProps {
  /** Whether the waveform should animate (e.g. during recording / playback). */
  isActive: boolean;
  /** CSS color override. Defaults to the `primary` colour token. */
  color?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const BAR_COUNT = 5;
const ANIMATION_DELAYS = ['0s', '0.1s', '0.2s', '0.3s', '0.4s'];

export function WaveformAnimation({ isActive, color }: WaveformAnimationProps) {
  return (
    <div
      className="inline-flex items-end gap-[3px]"
      style={{ color: color ?? 'var(--primary, #6366f1)' }}
      role="img"
      aria-label={isActive ? 'Audio waveform animating' : 'Audio waveform inactive'}
      title={isActive ? 'Audio active' : 'Audio idle'}
    >
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <span
          key={i}
          className={cn(
            'w-1 rounded-full bg-current transition-all duration-200',
            isActive ? 'animate-bounce' : 'h-3',
          )}
          style={{
            height: isActive ? undefined : '0.75rem',
            animationDelay: isActive ? ANIMATION_DELAYS[i] : undefined,
            animationDuration: isActive ? '0.6s' : undefined,
            /* Override the default bounce keyframe to oscillate between
               h-3 and h-8 by scaling from 0.375rem to 2rem via transform. */
            animationName: isActive ? 'waveform-bounce' : undefined,
          }}
        />
      ))}

      {/* Inject the custom keyframe once */}
      {isActive && (
        <style>{`
          @keyframes waveform-bounce {
            0%, 100% { transform: scaleY(0.5); }
            50% { transform: scaleY(1.8); }
          }
        `}</style>
      )}
    </div>
  );
}
