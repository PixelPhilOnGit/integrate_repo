/**
 * Audio source dropdown selector.
 *
 * Allows the user to choose between microphone and system audio input.
 * System audio is marked with a "Beta" badge.
 */

import { Mic, Speaker, AlertTriangle } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { useCallback, useEffect, useState } from 'react';
import type { AudioSource } from '@/types';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface AudioOption {
  value: AudioSource;
  label: string;
  icon: React.ReactNode;
  isBeta: boolean;
}

const AUDIO_OPTIONS: AudioOption[] = [
  {
    value: 'microphone',
    label: 'Microphone',
    icon: <Mic className="h-4 w-4" />,
    isBeta: false,
  },
  {
    value: 'system_audio',
    label: 'System Audio',
    icon: <Speaker className="h-4 w-4" />,
    isBeta: true,
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AudioSourceSelector() {
  const audioSource = useSettingsStore((s) => s.audioSource);
  const whisperApiKey = useSettingsStore((s) => s.whisperApiKey);
  const updateSetting = useSettingsStore((s) => s.updateSetting);

  // Detect platform for macOS-specific warnings
  const [isMacOS, setIsMacOS] = useState(false);
  useEffect(() => {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    setIsMacOS(/Mac OS X/i.test(ua));
  }, []);

  const handleChange = useCallback(
    (value: string) => {
      updateSetting('audioSource', value as AudioSource);
    },
    [updateSetting],
  );

  const currentOption = AUDIO_OPTIONS.find((o) => o.value === audioSource);

  return (
    <div className="flex flex-col gap-1">
      <Select value={audioSource} onValueChange={handleChange}>
        <SelectTrigger
          className="h-8 w-[180px] text-xs"
          aria-label="Select audio source"
        >
          <SelectValue>
            {currentOption && (
              <span className="flex items-center gap-2">
                {currentOption.icon}
                {currentOption.label}
                {currentOption.isBeta && (
                  <Badge variant="secondary" className="text-[10px] px-1 py-0">
                    Beta
                  </Badge>
                )}
              </span>
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {AUDIO_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value} className="text-xs">
              <span className="flex items-center gap-2">
                {option.icon}
                {option.label}
                {option.isBeta && (
                  <Badge variant="secondary" className="text-[10px] px-1 py-0">
                    Beta
                  </Badge>
                )}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {audioSource === 'system_audio' && !whisperApiKey && (
        <span className="text-[10px] text-amber-500">
          Whisper API key required (Settings → API)
        </span>
      )}
      {audioSource === 'system_audio' && whisperApiKey && !isMacOS && (
        <span className="text-[10px] text-muted-foreground">
          You'll be prompted to select a window/tab to share
        </span>
      )}
      {audioSource === 'system_audio' && whisperApiKey && isMacOS && (
        <div className="flex items-start gap-1 max-w-[220px]">
          <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0 mt-0.5" />
          <span className="text-[10px] text-amber-600 dark:text-amber-400 leading-tight">
            macOS limitation: desktop app cannot capture audio from other apps (like Chrome). Use the web version in Chrome browser, or install BlackHole for system-wide audio loopback.
          </span>
        </div>
      )}
    </div>
  );
}
