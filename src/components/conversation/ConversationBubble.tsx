/**
 * Single message bubble in the conversation thread.
 *
 * Displays original and translated text, speaker label, timestamp, and
 * action buttons (copy, retranslate, play TTS). Handles error state with
 * a distinct visual treatment and retry action.
 */

import { useState, useCallback } from 'react';
import {
  Copy,
  Check,
  RefreshCw,
  Volume2,
  AlertCircle,
} from 'lucide-react';
import type { Message } from '@/types';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { audioService } from '@/services/audioService';
import { useConversationStore } from '@/stores/conversationStore';
import { toast } from '@/hooks/useToast';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ConversationBubbleProps {
  /** The message to display. */
  message: Message;
  /** Whether this message is from the user (true) or the other speaker (false). */
  isUser?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for environments without clipboard API
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      return true;
    } catch {
      return false;
    } finally {
      document.body.removeChild(textarea);
    }
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ConversationBubble({ message, isUser = false }: ConversationBubbleProps) {
  const [copied, setCopied] = useState(false);
  const [ttsLoading, setTtsLoading] = useState(false);
  const updateMessage = useConversationStore((s) => s.updateMessage);

  const hasError = !!message.error;

  // ---- Actions ----

  const handleCopy = useCallback(async () => {
    const ok = await copyToClipboard(message.translatedText);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast({ title: 'Failed to copy', variant: 'destructive' });
    }
  }, [message.translatedText]);

  const handleRetranslate = useCallback(() => {
    updateMessage(message.id, {
      translatedText: '',
      isRetranslated: true,
      error: undefined,
    });
    // The actual retranslation is handled by the orchestrator / parent.
    toast({ title: 'Retranslating...' });
  }, [message.id, updateMessage]);

  const handlePlayTts = useCallback(async () => {
    if (ttsLoading) return;
    setTtsLoading(true);
    try {
      await audioService.synthesizeSpeech(
        message.translatedText,
        message.targetLanguage,
      );
    } catch (err) {
      toast({
        title: 'TTS playback failed',
        description: String(err),
        variant: 'destructive',
      });
    } finally {
      setTtsLoading(false);
    }
  }, [message.translatedText, message.targetLanguage, ttsLoading]);

  // ---- Render ----

  return (
    <div
      className={cn(
        'group flex flex-col gap-1 rounded-lg p-3 transition-all duration-200',
        'animate-in fade-in slide-in-from-bottom-2',
        hasError
          ? 'bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800/40'
          : isUser
            ? 'bg-primary/5 border border-primary/10'
            : 'bg-muted/30 border border-transparent',
      )}
    >
      {/* Header row: label + timestamp */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {isUser ? 'You' : 'Speaker'}
        </span>
        <span className="text-xs text-muted-foreground/60">
          {formatTimestamp(message.timestamp)}
        </span>
      </div>

      {/* Error banner */}
      {hasError && (
        <div className="mb-2 flex items-start gap-1.5 rounded bg-red-100/50 dark:bg-red-900/20 p-2 text-xs text-red-600 dark:text-red-400">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{message.error}</span>
        </div>
      )}

      {/* Original text */}
      <p className="text-sm text-muted-foreground/70 dark:text-muted-foreground/60 leading-relaxed">
        {message.originalText}
      </p>

      {/* Translated text */}
      <p
        className={cn(
          'text-base font-medium leading-relaxed',
          hasError ? 'text-red-600 dark:text-red-400' : 'text-foreground',
          message.isRetranslated && 'italic',
        )}
      >
        {message.translatedText || (
          <span className="text-muted-foreground/40 italic">
            {hasError ? 'Translation failed' : 'Translating...'}
          </span>
        )}
      </p>

      {/* Action buttons */}
      {!hasError && message.translatedText && (
        <div className="mt-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleCopy}
            aria-label="Copy translated text"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleRetranslate}
            aria-label="Retranslate"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handlePlayTts}
            disabled={ttsLoading}
            aria-label="Play translation aloud"
          >
            <Volume2 className={cn('h-3.5 w-3.5', ttsLoading && 'animate-pulse')} />
          </Button>
        </div>
      )}

      {/* Error retry button */}
      {hasError && (
        <Button
          variant="outline"
          size="sm"
          className="mt-1 self-start h-7 text-xs"
          onClick={handleRetranslate}
        >
          <RefreshCw className="mr-1 h-3 w-3" />
          Retry
        </Button>
      )}
    </div>
  );
}
