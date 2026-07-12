/**
 * Speech recognition (ASR) engine settings.
 *
 * Allows the user to choose between the system built-in ASR engine and
 * cloud-based Whisper API, and to adjust the confidence threshold.
 */

import { useCallback, useState } from 'react';
import { AlertTriangle, Info, Mic, Check, Loader2 } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { SpeechRecognitionService } from '@/services/speechRecognitionService';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { toast } from '@/hooks/useToast';
import type { AsrEngine } from '@/types';

// ---------------------------------------------------------------------------
// Engine descriptions
// ---------------------------------------------------------------------------

const ENGINE_INFO: Record<AsrEngine, { label: string; description: string }> = {
  system: {
    label: 'System (Default)',
    description:
      'Uses your device’s built-in speech recognition. No internet required. May not be available on all platforms.',
  },
  whisper: {
    label: 'Whisper API',
    description:
      'Cloud-based speech recognition via Whisper API. Requires internet connection. Higher accuracy for most languages.',
  },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AsrSettings() {
  const asrEngine = useSettingsStore((s) => s.asrEngine);
  const asrConfidenceThreshold = useSettingsStore((s) => s.asrConfidenceThreshold);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const [micTesting, setMicTesting] = useState(false);
  const [micAvailable, setMicAvailable] = useState<boolean | null>(null);

  const handleEngineChange = useCallback(
    (value: string) => {
      updateSetting('asrEngine', value as AsrEngine);
    },
    [updateSetting],
  );

  const handleThresholdChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = parseFloat(e.target.value);
      updateSetting('asrConfidenceThreshold', Math.round(val * 100) / 100);
    },
    [updateSetting],
  );

  const engineInfo = ENGINE_INFO[asrEngine];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Speech Recognition</CardTitle>
        <CardDescription>
          Configure how your speech is processed and recognized.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* ASR Engine */}
        <div className="space-y-1.5">
          <Label htmlFor="asr-engine">ASR Engine</Label>
          <Select value={asrEngine} onValueChange={handleEngineChange}>
            <SelectTrigger id="asr-engine" className="w-full max-w-xs text-sm">
              <SelectValue>
                {ENGINE_INFO[asrEngine].label}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">{ENGINE_INFO.system.label}</SelectItem>
              <SelectItem value="whisper">{ENGINE_INFO.whisper.label}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Engine description */}
        {engineInfo && (
          <div className="flex items-start gap-2 rounded bg-muted/50 p-3 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <p>{engineInfo.description}</p>
          </div>
        )}

        {/* Confidence threshold */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="confidence-threshold" className="text-sm">
              Confidence Threshold
            </Label>
            <span className="text-xs text-muted-foreground tabular-nums">
              {asrConfidenceThreshold.toFixed(2)}
            </span>
          </div>
          <input
            id="confidence-threshold"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={asrConfidenceThreshold}
            onChange={handleThresholdChange}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary
                       [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4
                       [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full
                       [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow"
            aria-label="Confidence threshold"
          />
          <p className="text-xs text-muted-foreground">
            Lower values accept more transcriptions but may include errors. Higher values
            require more certainty before accepting.
          </p>
        </div>

        {/* Platform note */}
        <div className="flex items-start gap-1.5 rounded bg-amber-50 dark:bg-amber-950/20 p-2 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          System ASR may not be available on all platforms.
        </div>

        {/* Mic test */}
        <div className="border-t pt-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Test Microphone</p>
              <p className="text-xs text-muted-foreground">
                Verify that your microphone works with speech recognition.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                setMicTesting(true);
                setMicAvailable(null);
                try {
                  const available = SpeechRecognitionService.isAvailable();
                  setMicAvailable(available);
                  if (available) {
                    toast({ title: 'Microphone ready', description: 'Speech recognition is available.' });
                  } else {
                    toast({
                      title: 'Not available',
                      description: 'Speech recognition is not supported in this environment.',
                      variant: 'destructive',
                    });
                  }
                } catch {
                  setMicAvailable(false);
                  toast({
                    title: 'Test failed',
                    description: 'Could not verify speech recognition availability.',
                    variant: 'destructive',
                  });
                } finally {
                  setMicTesting(false);
                }
              }}
              disabled={micTesting}
              className="gap-1.5"
            >
              {micTesting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : micAvailable === true ? (
                <Check className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <Mic className="h-3.5 w-3.5" />
              )}
              {micTesting ? 'Testing...' : 'Test'}
            </Button>
          </div>
          {micAvailable === false && (
            <p className="mt-2 text-xs text-red-500">
              Speech recognition is not available. Use Whisper API as fallback.
            </p>
          )}
          {micAvailable === true && (
            <p className="mt-2 text-xs text-green-500">
              Speech recognition is available and ready to use.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
