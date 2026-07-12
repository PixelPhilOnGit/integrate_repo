/**
 * Top toolbar for conversation mode.
 *
 * Displays the current mode label and provides action buttons for
 * clearing the conversation, exporting messages, and navigating to settings.
 */

import { useCallback, useState } from 'react';
import { Trash2, Download, Settings } from 'lucide-react';
import { useConversationStore } from '@/stores/conversationStore';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { toast } from '@/hooks/useToast';
import { LanguageSwitcher } from '@/components/conversation/LanguageSwitcher';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ConversationToolbar() {
  const messages = useConversationStore((s) => s.messages);
  const clearMessages = useConversationStore((s) => s.clearMessages);
  const exportMessages = useConversationStore((s) => s.exportMessages);
  const setMode = useConversationStore((s) => s.setMode);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);

  const handleClear = useCallback(() => {
    clearMessages();
    setClearDialogOpen(false);
    toast({ title: 'Conversation cleared' });
  }, [clearMessages]);

  const handleExport = useCallback(() => {
    try {
      const content = exportMessages();
      if (!content.trim()) {
        toast({ title: 'Nothing to export', description: 'The conversation is empty.' });
        return;
      }
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `voice-translation-${Date.now()}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast({ title: 'Conversation exported' });
    } catch {
      toast({ title: 'Export failed', variant: 'destructive' });
    }
  }, [exportMessages]);

  const handleSettings = useCallback(() => {
    setMode('settings');
  }, [setMode]);

  const hasMessages = messages.length > 0;

  return (
    <div className="flex h-12 items-center justify-between border-b px-4 bg-background">
      {/* Mode label */}
      <div className="flex items-center gap-3">
        <span className="text-sm font-semibold text-foreground">
          Conversation
        </span>
        <LanguageSwitcher />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1">
        {/* Clear */}
        <Dialog open={clearDialogOpen} onOpenChange={setClearDialogOpen}>
          <DialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              disabled={!hasMessages}
              aria-label="Clear all messages"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Clear conversation?</DialogTitle>
              <DialogDescription>
                This will permanently remove all messages in the current conversation.
                This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <Button
                variant="destructive"
                onClick={handleClear}
              >
                Clear all
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Export */}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          disabled={!hasMessages}
          onClick={handleExport}
          aria-label="Export conversation"
        >
          <Download className="h-4 w-4" />
        </Button>

        {/* Settings */}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={handleSettings}
          aria-label="Open settings"
        >
          <Settings className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
