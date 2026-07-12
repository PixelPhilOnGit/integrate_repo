/**
 * Scrollable list of conversation messages.
 *
 * Renders all messages from the conversation store, auto-scrolls to the
 * latest message, and provides a "jump to bottom" button when the user has
 * scrolled up.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageSquare, ChevronDown } from 'lucide-react';
import { useConversationStore } from '@/stores/conversationStore';
import { ConversationBubble } from '@/components/conversation/ConversationBubble';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ConversationList() {
  const messages = useConversationStore((s) => s.messages);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const isAutoScrolling = useRef(true);

  // Detect when the user manually scrolls away from the bottom
  const handleScroll = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const threshold = 40; // px from bottom
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    setIsScrolledUp(!atBottom);
    if (atBottom) {
      isAutoScrolling.current = true;
    }
  }, []);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (!isAutoScrolling.current) return;
    const el = viewportRef.current;
    if (el) {
      requestAnimationFrame(() => {
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      });
    }
  }, [messages.length]);

  // Scroll to bottom handler for the floating button
  const scrollToBottom = useCallback(() => {
    const el = viewportRef.current;
    if (el) {
      isAutoScrolling.current = true;
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      setIsScrolledUp(false);
    }
  }, []);

  // ---- Empty state ----
  if (messages.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="rounded-full bg-muted p-4">
          <MessageSquare className="h-8 w-8 text-muted-foreground/60" />
        </div>
        <p className="text-sm text-muted-foreground max-w-xs">
          No messages yet. Hold the mic button to start speaking.
        </p>
      </div>
    );
  }

  // ---- Message list ----
  return (
    <div className="relative h-full">
      <ScrollArea className="h-full">
        <div
          ref={viewportRef}
          onScroll={handleScroll}
          className="flex flex-col gap-3 px-4 py-4"
          role="log"
          aria-label="Conversation messages"
          aria-live="polite"
        >
          {messages.map((msg, idx) => (
            <ConversationBubble
              key={msg.id}
              message={msg}
              isUser={idx % 2 === 0}
            />
          ))}
        </div>
      </ScrollArea>

      {/* Jump to bottom button */}
      {isScrolledUp && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10">
          <Button
            variant="secondary"
            size="sm"
            className="h-8 gap-1.5 rounded-full shadow-md text-xs"
            onClick={scrollToBottom}
            aria-label="Scroll to latest messages"
          >
            <ChevronDown className="h-3.5 w-3.5" />
            New messages
          </Button>
        </div>
      )}
    </div>
  );
}
