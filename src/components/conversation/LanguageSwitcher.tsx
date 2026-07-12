/**
 * Quick language direction toggle for the conversation toolbar.
 *
 * Displays the current source and target languages with their flags and
 * native names, separated by a swap button.
 */

import { ArrowLeftRight } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { SUPPORTED_LANGUAGES } from '@/constants/languages';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useCallback, useMemo } from 'react';
import { toast } from '@/hooks/useToast';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LanguageSwitcher() {
  const sourceLanguage = useSettingsStore((s) => s.sourceLanguage);
  const targetLanguage = useSettingsStore((s) => s.targetLanguage);
  const updateSetting = useSettingsStore((s) => s.updateSetting);

  const sourceLang = useMemo(
    () => SUPPORTED_LANGUAGES.find((l) => l.code === sourceLanguage),
    [sourceLanguage],
  );
  const targetLang = useMemo(
    () => SUPPORTED_LANGUAGES.find((l) => l.code === targetLanguage),
    [targetLanguage],
  );

  const handleSwap = useCallback(async () => {
    if (!sourceLang || !targetLang) return;
    try {
      await updateSetting('sourceLanguage', targetLanguage);
      await updateSetting('targetLanguage', sourceLanguage);
      toast({
        title: 'Languages swapped',
        description: `${targetLang.nativeName} → ${sourceLang.nativeName}`,
      });
    } catch {
      toast({
        title: 'Failed to swap languages',
        variant: 'destructive',
      });
    }
  }, [sourceLanguage, targetLanguage, sourceLang, targetLang, updateSetting]);

  if (!sourceLang || !targetLang) {
    return (
      <div className="text-xs text-muted-foreground px-3 py-1">
        Language configuration unavailable
      </div>
    );
  }

  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-full border bg-background/50',
        'px-3 py-1.5 text-sm',
      )}
    >
      {/* Source language */}
      <span className="flex items-center gap-1.5 font-medium" title={sourceLang.name}>
        <span className="text-base leading-none">{sourceLang.flag}</span>
        <span className="hidden sm:inline text-xs">{sourceLang.nativeName}</span>
      </span>

      {/* Swap button */}
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0 rounded-full"
        onClick={handleSwap}
        aria-label="Swap source and target languages"
      >
        <ArrowLeftRight className="h-3.5 w-3.5" />
      </Button>

      {/* Target language */}
      <span className="flex items-center gap-1.5 font-medium" title={targetLang.name}>
        <span className="text-base leading-none">{targetLang.flag}</span>
        <span className="hidden sm:inline text-xs">{targetLang.nativeName}</span>
      </span>
    </div>
  );
}
