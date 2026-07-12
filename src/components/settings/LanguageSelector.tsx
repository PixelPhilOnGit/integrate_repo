/**
 * Language pair selector for choosing source and target languages.
 *
 * Provides two side-by-side Select dropdowns with flag + native name
 * display, a swap button between them, and automatic conflict resolution
 * when the user selects the same language for both sides.
 */

import { useCallback, useMemo } from 'react';
import { ArrowLeftRight, AlertCircle } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { SUPPORTED_LANGUAGES } from '@/constants/languages';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { toast } from '@/hooks/useToast';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LanguageSelector() {
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

  // Determine which languages are excluded from each dropdown
  const sourceExclude = useMemo(
    () => (targetLanguage ? [targetLanguage] : []),
    [targetLanguage],
  );
  const targetExclude = useMemo(
    () => (sourceLanguage ? [sourceLanguage] : []),
    [sourceLanguage],
  );

  const handleSourceChange = useCallback(
    (code: string) => {
      if (code === targetLanguage) {
        toast({
          title: 'Source and target must be different',
          variant: 'destructive',
        });
        return;
      }
      updateSetting('sourceLanguage', code);
    },
    [targetLanguage, updateSetting],
  );

  const handleTargetChange = useCallback(
    (code: string) => {
      if (code === sourceLanguage) {
        toast({
          title: 'Source and target must be different',
          variant: 'destructive',
        });
        return;
      }
      updateSetting('targetLanguage', code);
    },
    [sourceLanguage, updateSetting],
  );

  const handleSwap = useCallback(async () => {
    try {
      await updateSetting('sourceLanguage', targetLanguage);
      await updateSetting('targetLanguage', sourceLanguage);
      toast({
        title: 'Languages swapped',
        description: `${targetLang?.nativeName} ↔ ${sourceLang?.nativeName}`,
      });
    } catch {
      toast({ title: 'Failed to swap languages', variant: 'destructive' });
    }
  }, [sourceLanguage, targetLanguage, sourceLang, targetLang, updateSetting]);

  const sameLanguage = sourceLanguage === targetLanguage;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Language Pair</CardTitle>
        <CardDescription>
          Choose which languages to translate between.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sameLanguage && (
          <div className="mb-3 flex items-start gap-1.5 rounded bg-amber-50 dark:bg-amber-950/20 p-2 text-xs text-amber-600 dark:text-amber-400">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Source and target languages cannot be the same. Please choose different languages.
          </div>
        )}

        <div className="flex items-center gap-3">
          {/* Source language */}
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="source-lang" className="text-xs">Source</Label>
            <Select value={sourceLanguage} onValueChange={handleSourceChange}>
              <SelectTrigger id="source-lang" className="w-full text-sm">
                <SelectValue>
                  {sourceLang && (
                    <span className="flex items-center gap-2">
                      <span>{sourceLang.flag}</span>
                      <span>{sourceLang.nativeName}</span>
                    </span>
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {SUPPORTED_LANGUAGES.filter((l) => !sourceExclude.includes(l.code)).map(
                  (lang) => (
                    <SelectItem key={lang.code} value={lang.code} className="text-sm">
                      <span className="flex items-center gap-2">
                        <span>{lang.flag}</span>
                        <span>{lang.nativeName}</span>
                      </span>
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </div>

          {/* Swap / Arrow */}
          <div className="flex items-center pt-5">
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 shrink-0 rounded-full"
              onClick={handleSwap}
              aria-label="Swap source and target languages"
            >
              <ArrowLeftRight className="h-4 w-4" />
            </Button>
          </div>

          {/* Target language */}
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="target-lang" className="text-xs">Target</Label>
            <Select value={targetLanguage} onValueChange={handleTargetChange}>
              <SelectTrigger id="target-lang" className="w-full text-sm">
                <SelectValue>
                  {targetLang && (
                    <span className="flex items-center gap-2">
                      <span>{targetLang.flag}</span>
                      <span>{targetLang.nativeName}</span>
                    </span>
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {SUPPORTED_LANGUAGES.filter((l) => !targetExclude.includes(l.code)).map(
                  (lang) => (
                    <SelectItem key={lang.code} value={lang.code} className="text-sm">
                      <span className="flex items-center gap-2">
                        <span>{lang.flag}</span>
                        <span>{lang.nativeName}</span>
                      </span>
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
