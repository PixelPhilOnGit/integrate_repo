/**
 * Real-time subtitle display for simultaneous interpretation mode.
 * All subtitle blocks visible, auto-scroll to latest, manual scroll supported.
 */

import { useEffect, useRef, useState } from 'react';
import { Ear, Mic } from 'lucide-react';
import { useConversationStore } from '@/stores/conversationStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { SubtitleLine } from '@/components/simultaneous/SubtitleLine';
import { cn } from '@/lib/utils';

export function SubtitleOverlay() {
  const subtitles = useConversationStore((s) => s.subtitles);
  const currentMode = useConversationStore((s) => s.currentMode);
  const subtitleFontSize = useSettingsStore((s) => s.subtitleFontSize);
  const subtitlePosition = useSettingsStore((s) => s.subtitlePosition);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isScrolledUp, setIsScrolledUp] = useState(false);

  // Auto-scroll when subtitles change (count OR content)
  const lastText =
    subtitles.length > 0
      ? subtitles[subtitles.length - 1].translatedText +
        subtitles[subtitles.length - 1].originalText
      : '';
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || isScrolledUp) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [subtitles.length, lastText, isScrolledUp]);

  // Track manual scroll position
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setIsScrolledUp(!atBottom);
  };

  const isSimultaneousMode = currentMode === 'simultaneous';

  if (subtitles.length === 0) {
    return (
      <div
        className={cn(
          'flex h-full flex-col items-center justify-center gap-3 px-6 text-center',
          subtitlePosition === 'top' ? 'justify-start pt-16' : 'justify-center',
        )}
      >
        {isSimultaneousMode ? (
          <>
            <div className="rounded-full bg-muted p-4">
              <Ear className="h-8 w-8 text-muted-foreground/60" />
            </div>
            <p className="text-sm text-muted-foreground max-w-xs">
              Waiting for speech...
            </p>
          </>
        ) : (
          <>
            <div className="rounded-full bg-muted p-4">
              <Mic className="h-8 w-8 text-muted-foreground/60" />
            </div>
            <p className="text-sm text-muted-foreground max-w-xs">
              Ready to listen
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="relative h-full">
      {/* Fade edges */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-background to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-background to-transparent" />

      {/* Native scroll container */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto overscroll-contain"
        role="log"
        aria-label="Real-time subtitles"
        aria-live="polite"
      >
        <div
          className={cn(
            'flex flex-col py-4',
            subtitlePosition === 'top' ? 'justify-start' : 'justify-end min-h-full',
          )}
        >
          {subtitles.map((sub, idx) => (
            <SubtitleLine
              key={sub.id}
              subtitle={sub}
              isLatest={idx === subtitles.length - 1}
              fontSize={subtitleFontSize}
            />
          ))}
        </div>
      </div>

      {/* Scroll-to-bottom button when scrolled up */}
      {isScrolledUp && (
        <button
          onClick={() => {
            const el = scrollRef.current;
            if (el) {
              el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
              setIsScrolledUp(false);
            }
          }}
          className="absolute bottom-3 right-3 z-20 rounded-full bg-primary px-3 py-1.5 text-xs text-primary-foreground shadow-lg hover:bg-primary/90"
        >
          ↓ Latest
        </button>
      )}
    </div>
  );
}
