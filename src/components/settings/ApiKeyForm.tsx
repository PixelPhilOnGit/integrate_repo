/**
 * API key configuration form for the DeepSeek translation service.
 *
 * Provides password-style input with show/hide toggle, connection testing,
 * and a link to the DeepSeek API console. Changes auto-save on blur
 * so the user doesn't need to click a Save button for each field.
 */

import { useState, useCallback, useEffect } from 'react';
import { Eye, EyeOff, ExternalLink, Check, X, Loader2, AlertCircle } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { testConnection } from '@/services/translationService';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { toast } from '@/hooks/useToast';
import { DEFAULT_SETTINGS } from '@/constants/languages';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ConnectionStatus = 'untested' | 'testing' | 'success' | 'failure';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ApiKeyForm() {
  const apiKey = useSettingsStore((s) => s.apiKey);
  const apiBaseUrl = useSettingsStore((s) => s.apiBaseUrl);
  const model = useSettingsStore((s) => s.model);
  const temperature = useSettingsStore((s) => s.temperature);
  const maxTokens = useSettingsStore((s) => s.maxTokens);
  const updateSetting = useSettingsStore((s) => s.updateSetting);

  const [showKey, setShowKey] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('untested');
  const [localKey, setLocalKey] = useState(apiKey);
  const [localBaseUrl, setLocalBaseUrl] = useState(apiBaseUrl);

  // Sync local state when store changes (e.g. settings loaded from disk)
  useEffect(() => {
    setLocalKey(apiKey);
  }, [apiKey]);

  useEffect(() => {
    setLocalBaseUrl(apiBaseUrl);
  }, [apiBaseUrl]);

  const persistKey = useCallback(() => {
    const trimmed = localKey.trim();
    if (trimmed !== apiKey) {
      updateSetting('apiKey', trimmed);
      setConnectionStatus('untested');
      if (trimmed) {
        toast({ title: 'API key saved' });
      }
    }
  }, [localKey, apiKey, updateSetting]);

  const persistBaseUrl = useCallback(() => {
    const trimmed = localBaseUrl.trim() || DEFAULT_SETTINGS.apiBaseUrl;
    if (trimmed !== apiBaseUrl) {
      updateSetting('apiBaseUrl', trimmed);
      setConnectionStatus('untested');
      toast({ title: 'API base URL updated' });
    }
  }, [localBaseUrl, apiBaseUrl, updateSetting]);

  const handleTestConnection = useCallback(async () => {
    const key = localKey.trim();
    if (!key) {
      toast({ title: 'API key is required', variant: 'destructive' });
      return;
    }
    // Save before testing
    if (key !== apiKey) {
      await updateSetting('apiKey', key);
    }
    setConnectionStatus('testing');
    try {
      const ok = await testConnection({
        apiKey: key,
        apiBaseUrl: localBaseUrl.trim() || DEFAULT_SETTINGS.apiBaseUrl,
        model,
        temperature,
        maxTokens,
      });
      setConnectionStatus(ok ? 'success' : 'failure');
      toast({
        title: ok ? 'Connection successful' : 'Connection failed',
        description: ok
          ? 'Your API key is valid and ready to use.'
          : 'Check your API key and base URL, then try again.',
        variant: ok ? 'default' : 'destructive',
      });
    } catch {
      setConnectionStatus('failure');
      toast({
        title: 'Connection error',
        description: 'Could not reach the API server. Verify your internet connection.',
        variant: 'destructive',
      });
    }
  }, [localKey, localBaseUrl, model, temperature, maxTokens, apiKey, updateSetting]);

  // ---- Status indicator ----

  const statusIcon = () => {
    switch (connectionStatus) {
      case 'untested':
        return <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />Not tested</span>;
      case 'testing':
        return <span className="flex items-center gap-1.5 text-xs text-amber-500"><Loader2 className="h-3 w-3 animate-spin" />Testing...</span>;
      case 'success':
        return <span className="flex items-center gap-1.5 text-xs text-green-500"><Check className="h-3 w-3" />Connected</span>;
      case 'failure':
        return <span className="flex items-center gap-1.5 text-xs text-red-500"><X className="h-3 w-3" />Connection failed</span>;
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">API Configuration</CardTitle>
        <CardDescription>
          Enter your DeepSeek API key to enable translations.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* API Key */}
        <div className="space-y-1.5">
          <Label htmlFor="api-key">API Key</Label>
          <div className="relative">
            <Input
              id="api-key"
              type={showKey ? 'text' : 'password'}
              value={localKey}
              onChange={(e) => {
                setLocalKey(e.target.value);
                setConnectionStatus('untested');
              }}
              onBlur={persistKey}
              onKeyDown={(e) => { if (e.key === 'Enter') persistKey(); }}
              placeholder="sk-..."
              className="pr-9 text-sm font-mono"
              aria-describedby="api-key-desc"
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
          <p id="api-key-desc" className="text-xs text-muted-foreground">
            <a
              href="https://platform.deepseek.com/api_keys"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              Get your API key
              <ExternalLink className="h-3 w-3" />
            </a>
          </p>
        </div>

        {/* API Base URL */}
        <div className="space-y-1.5">
          <Label htmlFor="api-base-url">API Base URL</Label>
          <Input
            id="api-base-url"
            type="text"
            value={localBaseUrl}
            onChange={(e) => {
              setLocalBaseUrl(e.target.value);
              setConnectionStatus('untested');
            }}
            onBlur={persistBaseUrl}
            onKeyDown={(e) => { if (e.key === 'Enter') persistBaseUrl(); }}
            placeholder={DEFAULT_SETTINGS.apiBaseUrl}
            className="text-sm font-mono"
          />
        </div>

        {/* Test Connection & Status */}
        <div className="flex items-center justify-between pt-1">
          <Button
            variant="outline"
            size="sm"
            onClick={handleTestConnection}
            disabled={connectionStatus === 'testing' || !localKey.trim()}
            className="gap-1.5"
          >
            {connectionStatus === 'testing' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Test Connection
          </Button>
          {statusIcon()}
        </div>

        {/* Empty key warning */}
        {!localKey.trim() && (
          <div className="flex items-start gap-1.5 rounded bg-amber-50 dark:bg-amber-950/20 p-2 text-xs text-amber-600 dark:text-amber-400">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Translation will not work until you provide a valid API key.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
