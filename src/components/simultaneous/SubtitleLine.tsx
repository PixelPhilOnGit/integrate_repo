/**
 * Subtitle block showing all accumulated text in a split layout:
 * top = English (original), bottom = Chinese (translation).
 */

import type { Subtitle } from '@/types';
import { cn } from '@/lib/utils';

interface SubtitleLineProps {
  subtitle: Subtitle;
  isLatest: boolean;
  fontSize: number;
}

export function SubtitleLine({ subtitle, isLatest, fontSize }: SubtitleLineProps) {
  const hasOriginal = subtitle.originalText.trim().length > 0;
  const hasTranslation = subtitle.translatedText.trim().length > 0;

  return (
    <div
      className={cn(
        'px-4 py-3 transition-all duration-300',
        isLatest && 'bg-primary/5 border-l-2 border-primary',
        !isLatest && 'border-l-2 border-transparent opacity-60',
      )}
    >
      {/* English */}
      {hasOriginal && (
        <p className="text-xs text-muted-foreground/70 leading-relaxed whitespace-pre-line">
          {subtitle.originalText}
        </p>
      )}

      {/* Divider */}
      {hasOriginal && hasTranslation && (
        <div className="my-2 border-t border-border/30" />
      )}

      {/* Chinese */}
      {hasTranslation && (
        <p
          className="font-semibold text-foreground leading-relaxed whitespace-pre-line"
          style={{ fontSize: `${fontSize}px` }}
        >
          {subtitle.translatedText}
        </p>
      )}

      {!hasTranslation && !hasOriginal && (
        <p className="text-sm text-muted-foreground/40 italic">...</p>
      )}
    </div>
  );
}
