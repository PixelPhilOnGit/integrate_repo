/**
 * Whisper API configuration form.
 *
 * Configures the speech-to-text backend used for system audio capture.
 * Uses OpenAI's Whisper API or any compatible proxy endpoint.
 */

import { useState, useCallback, useEffect } from 'react';
import { Eye, EyeOff, Info } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { toast } from '@/hooks/useToast';
import { DEFAULT_SETTINGS } from '@/constants/languages';

export function WhisperApiForm() {
  const whisperApiKey = useSettingsStore((s) => s.whisperApiKey);
  const whisperApiBaseUrl = useSettingsStore((s) => s.whisperApiBaseUrl);
  const whisperModel = useSettingsStore((s) => s.whisperModel);
  const speechTranslateModel = useSettingsStore((s) => s.speechTranslateModel);
  const updateSetting = useSettingsStore((s) => s.updateSetting);

  const [showKey, setShowKey] = useState(false);
  const [localKey, setLocalKey] = useState(whisperApiKey);
  const [localBaseUrl, setLocalBaseUrl] = useState(whisperApiBaseUrl);
  const [localModel, setLocalModel] = useState(whisperModel);
  const [localStModel, setLocalStModel] = useState(speechTranslateModel);

  useEffect(() => {
    setLocalKey(whisperApiKey);
  }, [whisperApiKey]);

  useEffect(() => {
    setLocalBaseUrl(whisperApiBaseUrl);
  }, [whisperApiBaseUrl]);

  useEffect(() => {
    setLocalModel(whisperModel);
  }, [whisperModel]);

  useEffect(() => {
    setLocalStModel(speechTranslateModel);
  }, [speechTranslateModel]);

  const persistKey = useCallback(() => {
    const trimmed = localKey.trim();
    if (trimmed !== whisperApiKey) {
      updateSetting('whisperApiKey', trimmed);
      if (trimmed) toast({ title: 'Whisper API key saved' });
    }
  }, [localKey, whisperApiKey, updateSetting]);

  const persistBaseUrl = useCallback(() => {
    const trimmed = localBaseUrl.trim() || DEFAULT_SETTINGS.whisperApiBaseUrl;
    if (trimmed !== whisperApiBaseUrl) {
      updateSetting('whisperApiBaseUrl', trimmed);
      toast({ title: 'Whisper base URL updated' });
    }
  }, [localBaseUrl, whisperApiBaseUrl, updateSetting]);

  const persistModel = useCallback(() => {
    const trimmed = localModel.trim() || DEFAULT_SETTINGS.whisperModel;
    if (trimmed !== whisperModel) {
      updateSetting('whisperModel', trimmed);
      toast({ title: 'Whisper model updated' });
    }
  }, [localModel, whisperModel, updateSetting]);

  const persistStModel = useCallback(() => {
    const trimmed = localStModel.trim();
    if (trimmed !== speechTranslateModel) {
      updateSetting('speechTranslateModel', trimmed);
      if (trimmed) {
        toast({ title: 'Speech translation model set — direct mode active' });
      } else {
        toast({ title: 'Speech translation disabled — using Whisper+DeepSeek' });
      }
    }
  }, [localStModel, speechTranslateModel, updateSetting]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Whisper API (System Audio)</CardTitle>
        <CardDescription>
          Required for system audio capture mode. Uses OpenAI Whisper API for
          speech-to-text. Get a key at{' '}
          <a
            href="https://platform.openai.com/api-keys"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            platform.openai.com
          </a>
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Whisper API Key */}
        <div className="space-y-1.5">
          <Label htmlFor="whisper-api-key">Whisper API Key</Label>
          <div className="relative">
            <Input
              id="whisper-api-key"
              type={showKey ? 'text' : 'password'}
              value={localKey}
              onChange={(e) => setLocalKey(e.target.value)}
              onBlur={persistKey}
              onKeyDown={(e) => { if (e.key === 'Enter') persistKey(); }}
              placeholder="sk-..."
              className="pr-9 text-sm font-mono"
            />
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={showKey ? 'Hide API key' : 'Show API key'}
            >
              {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {/* Whisper Base URL */}
        <div className="space-y-1.5">
          <Label htmlFor="whisper-api-base-url">Whisper API Base URL</Label>
          <Input
            id="whisper-api-base-url"
            type="text"
            value={localBaseUrl}
            onChange={(e) => setLocalBaseUrl(e.target.value)}
            onBlur={persistBaseUrl}
            onKeyDown={(e) => { if (e.key === 'Enter') persistBaseUrl(); }}
            placeholder={DEFAULT_SETTINGS.whisperApiBaseUrl}
            className="text-sm font-mono"
          />
        </div>

        {/* Whisper Model */}
        <div className="space-y-1.5">
          <Label htmlFor="whisper-model">Model</Label>
          <Input
            id="whisper-model"
            type="text"
            value={localModel}
            onChange={(e) => setLocalModel(e.target.value)}
            onBlur={persistModel}
            onKeyDown={(e) => { if (e.key === 'Enter') persistModel(); }}
            placeholder={DEFAULT_SETTINGS.whisperModel}
            className="text-sm font-mono"
          />
          <p className="text-[11px] text-muted-foreground">
            OpenAI: <code>whisper-1</code> | SiliconFlow:{' '}
            <code>FunAudioLLM/SenseVoiceSmall</code>
          </p>
        </div>

        {/* Speech Translation Model (direct mode) */}
        <div className="space-y-1.5 rounded border border-dashed p-3">
          <Label htmlFor="speech-translate-model" className="text-xs font-semibold">
            🎯 Direct Speech → Translation (experimental)
          </Label>
          <Input
            id="speech-translate-model"
            type="text"
            value={localStModel}
            onChange={(e) => setLocalStModel(e.target.value)}
            onBlur={persistStModel}
            onKeyDown={(e) => { if (e.key === 'Enter') persistStModel(); }}
            placeholder="Leave empty for Whisper+Translate mode"
            className="text-sm font-mono"
          />
          <p className="text-[11px] text-muted-foreground">
            Fill in a multimodal model to skip Whisper+DeepSeek:{' '}
            <code>Qwen/Qwen3-Omni-30B-A3B-Instruct</code>
          </p>
        </div>

        {/* Info */}
        <div className="flex items-start gap-2 rounded bg-muted/50 p-3 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>
            The Whisper API key is only needed for system audio capture mode.
            For microphone mode, speech recognition uses the browser's built-in
            engine for free.
          </p>
        </div>

        {!localKey.trim() && (
          <p className="text-xs text-muted-foreground">
            Leave empty if you only use microphone mode.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
