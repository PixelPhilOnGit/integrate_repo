/**
 * Large circular push-to-talk button that controls the recording pipeline.
 *
 * Visually communicates the current recording state through icons,
 * text labels, and a pulsing ring animation during active recording.
 *
 * Uses the useTranslationPipeline hook to drive the full
 * audio → ASR → translation → TTS pipeline.
 */

import { useCallback } from 'react';
import { Mic, Square, Loader2, Volume2 } from 'lucide-react';
import { useTranslationPipeline } from '@/hooks/useTranslationPipeline';
import { cn } from '@/lib/utils';
import type { PipelineState } from '@/hooks/useTranslationPipeline';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface ButtonConfig {
  icon: React.ReactNode;
  label: string;
  ariaLabel: string;
  isProcessing: boolean;
}

function getButtonConfig(state: PipelineState): ButtonConfig {
  switch (state) {
    case 'idle':
      return {
        icon: <Mic className="h-8 w-8" />,
        label: 'Hold to speak',
        ariaLabel: 'Hold to start recording',
        isProcessing: false,
      };
    case 'recording':
      return {
        icon: <Square className="h-8 w-8" />,
        label: 'Listening...',
        ariaLabel: 'Recording, release to stop',
        isProcessing: false,
      };
    case 'recognizing':
      return {
        icon: <Loader2 className="h-8 w-8 animate-spin" />,
        label: 'Recognizing...',
        ariaLabel: 'Recognizing speech',
        isProcessing: true,
      };
    case 'translating':
      return {
        icon: <Loader2 className="h-8 w-8 animate-spin" />,
        label: 'Translating...',
        ariaLabel: 'Translating text',
        isProcessing: true,
      };
    case 'playing':
      return {
        icon: <Volume2 className="h-8 w-8" />,
        label: 'Playing...',
        ariaLabel: 'Playing back translation',
        isProcessing: true,
      };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RecordButton() {
  const {
    pipelineState,
    startConversation,
    stopConversation,
  } = useTranslationPipeline();

  const config = getButtonConfig(pipelineState);

  const handleStart = useCallback(() => {
    if (pipelineState === 'idle') {
      startConversation();
    }
  }, [pipelineState, startConversation]);

  const handleStop = useCallback(() => {
    if (pipelineState === 'recording') {
      stopConversation();
    }
  }, [pipelineState, stopConversation]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        handleStart();
      }
    },
    [handleStart],
  );

  const handleKeyUp = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        handleStop();
      }
    },
    [handleStop],
  );

  return (
    <div className="flex flex-col items-center gap-3">
      {/* Pulse ring behind the button when recording */}
      <div className="relative">
        {pipelineState === 'recording' && (
          <div className="absolute inset-0 animate-ping rounded-full bg-red-400/40 dark:bg-red-500/30" />
        )}
        <button
          type="button"
          role="button"
          tabIndex={0}
          aria-label={config.ariaLabel}
          disabled={config.isProcessing}
          onMouseDown={handleStart}
          onMouseUp={handleStop}
          onMouseLeave={handleStop}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onTouchStart={handleStart}
          onTouchEnd={handleStop}
          className={cn(
            'relative z-10 flex h-24 w-24 items-center justify-center rounded-full',
            'shadow-lg shadow-black/10 dark:shadow-black/30',
            'bg-gradient-to-br from-primary/20 to-primary/5',
            'text-foreground/80 hover:text-foreground',
            'transition-all duration-200 ease-out',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            'disabled:cursor-not-allowed disabled:opacity-60',
            pipelineState === 'recording' &&
              'bg-gradient-to-br from-red-500/20 to-red-500/5 text-red-500 scale-105',
            pipelineState === 'idle' && 'hover:scale-105 active:scale-95',
          )}
        >
          {config.icon}
        </button>
      </div>

      {/* Label */}
      <span
        className={cn(
          'text-sm font-medium select-none transition-colors duration-200',
          pipelineState === 'recording' && 'text-red-500',
          pipelineState === 'idle' && 'text-muted-foreground',
          config.isProcessing && 'text-primary',
        )}
      >
        {config.label}
      </span>
    </div>
  );
}
