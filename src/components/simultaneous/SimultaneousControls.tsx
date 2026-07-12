/**
 * Control bar for simultaneous interpretation mode.
 *
 * Provides start/stop control, audio source selection, font size
 * adjustment, subtitle position toggle, export, and a live status indicator.
 */

import { useState, useCallback, useMemo } from 'react';
import {
  Play,
  Square,
  AlignStartVertical,
  AlignEndVertical,
  FileText,
} from 'lucide-react';
import { useTranslationPipeline } from '@/hooks/useTranslationPipeline';
import { useConversationStore } from '@/stores/conversationStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { AudioSourceSelector } from '@/components/simultaneous/AudioSourceSelector';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/useToast';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SimultaneousControls() {
  const isListening = useConversationStore((s) => s.isListening);
  const subtitles = useConversationStore((s) => s.subtitles);

  const subtitleFontSize = useSettingsStore((s) => s.subtitleFontSize);
  const subtitlePosition = useSettingsStore((s) => s.subtitlePosition);
  const updateSetting = useSettingsStore((s) => s.updateSetting);

  const { startSimultaneous, stopSimultaneous } = useTranslationPipeline();

  const [fontSizeInput, setFontSizeInput] = useState(subtitleFontSize);

  // ---- Start / Stop ----

  const handleToggleListening = useCallback(() => {
    if (isListening) {
      stopSimultaneous();
      toast({ title: 'Simultaneous mode paused' });
    } else {
      startSimultaneous();
      toast({ title: 'Simultaneous mode active' });
    }
  }, [isListening, startSimultaneous, stopSimultaneous]);

  // ---- Export ----

  const handleExport = useCallback(() => {
    const finalSubtitles = subtitles.filter((s) => s.isFinal && s.translatedText);
    if (finalSubtitles.length === 0) {
      toast({ title: 'No translated subtitles to export' });
      return;
    }
    try {
      const text = finalSubtitles
        .map(
          (s) =>
            `[${new Date(s.timestamp).toLocaleTimeString()}] ${s.originalText} → ${s.translatedText}`,
        )
        .join('\n');
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `subtitles-${Date.now()}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast({ title: 'Subtitles exported' });
    } catch {
      toast({ title: 'Export failed', variant: 'destructive' });
    }
  }, [subtitles]);

  // ---- Font size ----

  const handleFontSizeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = Number(e.target.value);
      setFontSizeInput(val);
      updateSetting('subtitleFontSize', val);
    },
    [updateSetting],
  );

  // ---- Position toggle ----

  const handlePositionToggle = useCallback(
    (pos: 'top' | 'bottom') => {
      updateSetting('subtitlePosition', pos);
    },
    [updateSetting],
  );

  // ---- Status ----

  const statusInfo = useMemo(() => {
    if (isListening) {
      return {
        dot: 'bg-green-500',
        label: 'Active',
        dotAnimation: 'animate-pulse',
      };
    }
    return {
      dot: 'bg-yellow-500',
      label: 'Paused',
      dotAnimation: '',
    };
  }, [isListening]);

  return (
    <div className="flex flex-wrap items-center gap-3 border-t bg-background px-4 py-2.5">
      {/* Start / Stop */}
      <Button
        variant={isListening ? 'destructive' : 'default'}
        size="sm"
        className="h-8 gap-1.5"
        onClick={handleToggleListening}
        aria-label={isListening ? 'Stop simultaneous mode' : 'Start simultaneous mode'}
      >
        {isListening ? (
          <>
            <Square className="h-4 w-4" />
            <span>Stop</span>
          </>
        ) : (
          <>
            <Play className="h-4 w-4" />
            <span>Start</span>
          </>
        )}
      </Button>

      <div className="h-5 w-px bg-border" />

      {/* Audio source */}
      <AudioSourceSelector />

      <div className="h-5 w-px bg-border" />

      {/* Font size slider */}
      <div className="flex items-center gap-2">
        <Label htmlFor="subtitle-font-size" className="text-xs text-muted-foreground whitespace-nowrap">
          Size: {fontSizeInput}px
        </Label>
        <input
          id="subtitle-font-size"
          type="range"
          min={12}
          max={32}
          step={1}
          value={fontSizeInput}
          onChange={handleFontSizeChange}
          className="h-1.5 w-20 cursor-pointer appearance-none rounded-full bg-muted accent-primary
                     [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5
                     [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full
                     [&::-webkit-slider-thumb]:bg-primary"
          aria-label="Subtitle font size"
        />
      </div>

      <div className="h-5 w-px bg-border" />

      {/* Position toggle */}
      <div className="flex items-center gap-1 rounded-md border p-0.5">
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'h-7 w-7',
            subtitlePosition === 'top' && 'bg-accent text-accent-foreground',
          )}
          onClick={() => handlePositionToggle('top')}
          aria-label="Show subtitles at top"
        >
          <AlignStartVertical className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'h-7 w-7',
            subtitlePosition === 'bottom' && 'bg-accent text-accent-foreground',
          )}
          onClick={() => handlePositionToggle('bottom')}
          aria-label="Show subtitles at bottom"
        >
          <AlignEndVertical className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex-1" />

      {/* Export */}
      <Button
        variant="outline"
        size="icon"
        className="h-8 w-8"
        onClick={handleExport}
        disabled={subtitles.filter((s) => s.isFinal && s.translatedText).length === 0}
        aria-label="Export subtitles"
      >
        <FileText className="h-4 w-4" />
      </Button>

      {/* Status indicator */}
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className={cn('h-2 w-2 rounded-full', statusInfo.dot, statusInfo.dotAnimation)} />
        <span>{statusInfo.label}</span>
      </div>
    </div>
  );
}
