/**
 * React hook that provides auto-scroll behaviour for message / subtitle
 * containers.
 *
 * The hook attaches a `ref` to a scrollable DOM element and:
 * - Scrolls to the bottom whenever new content is detected (via
 *   `ResizeObserver` on the content).
 * - Respects the user's manual scroll position — if the user has scrolled
 *   up to read earlier content, auto-scrolling is paused until the user
 *   scrolls back to within a small threshold of the bottom.
 * - Exposes an imperative `scrollToBottom()` method.
 * - Exposes an `isAtBottom` boolean for UI indicators (e.g. "scroll to
 *   bottom" floating button).
 *
 * @example
 * ```tsx
 * function ConversationPanel() {
 *   const { containerRef, scrollToBottom, isAtBottom } = useAutoScroll();
 *
 *   return (
 *     <div ref={containerRef} className="overflow-y-auto h-96">
 *       {messages.map((m) => <MessageBubble key={m.id} message={m} />)}
 *     </div>
 *   );
 * }
 * ```
 */

import { useEffect, useRef, useCallback, useState } from 'react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Distance from the scroll bottom (in pixels) under which the container is
 * considered "at the bottom". This small tolerance avoids flickering when
 * the scrollbar is nearly at the bottom.
 */
const BOTTOM_THRESHOLD_PX = 8;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAutoScroll() {
  // The container element is stored in a ref so it is accessible inside
  // ResizeObserver and scroll event callbacks.
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Tracks whether the user has scrolled away from the bottom.
  const userScrolledUpRef = useRef(false);

  // ResizeObserver instance shared across the lifetime of the hook.
  const observerRef = useRef<ResizeObserver | null>(null);

  // Reactive flag so the UI can react to scroll position changes.
  const [isAtBottom, setIsAtBottom] = useState(true);

  // -----------------------------------------------------------------------
  // Imperative scroll-to-bottom
  // -----------------------------------------------------------------------

  const scrollToBottom = useCallback((smooth = true) => {
    const el = containerRef.current;
    if (!el) return;

    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth ? 'smooth' : 'instant',
    });

    userScrolledUpRef.current = false;
    setIsAtBottom(true);
  }, []);

  // -----------------------------------------------------------------------
  // Scroll event handler — detect user-manual scrolling
  // -----------------------------------------------------------------------

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom <= BOTTOM_THRESHOLD_PX;

    userScrolledUpRef.current = !atBottom;
    setIsAtBottom(atBottom);
  }, []);

  // -----------------------------------------------------------------------
  // ResizeObserver callback — auto-scroll when content grows (if user is
  // at the bottom).
  // -----------------------------------------------------------------------

  const handleContentResize = useCallback(() => {
    if (!userScrolledUpRef.current) {
      const el = containerRef.current;
      if (!el) return;

      el.scrollTop = el.scrollHeight;
    }
  }, []);

  // -----------------------------------------------------------------------
  // Attach the ref callback that wires up the container element
  // -----------------------------------------------------------------------

  const containerCallbackRef = useCallback(
    (node: HTMLDivElement | null) => {
      // Tear down any previous observer
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }

      // Remove previous scroll listener
      const prev = containerRef.current;
      if (prev) {
        prev.removeEventListener('scroll', handleScroll);
      }

      containerRef.current = node;

      if (node) {
        // Observe content size changes to trigger auto-scroll
        observerRef.current = new ResizeObserver(handleContentResize);
        observerRef.current.observe(node);

        // Monitor scroll position
        node.addEventListener('scroll', handleScroll, { passive: true });

        // Scroll to the initial bottom
        node.scrollTop = node.scrollHeight;
        setIsAtBottom(true);
      }
    },
    [handleScroll, handleContentResize],
  );

  // -----------------------------------------------------------------------
  // Cleanup on unmount
  // -----------------------------------------------------------------------

  useEffect(() => {
    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }

      const el = containerRef.current;
      if (el) {
        el.removeEventListener('scroll', handleScroll);
      }
      containerRef.current = null;
    };
  }, [handleScroll]);

  return {
    /**
     * Spread onto the scrollable container element:
     * ```tsx
     * <div ref={containerRef} … />
     * ```
     */
    containerRef: containerCallbackRef,
    /** Imperatively scroll to the bottom of the container. */
    scrollToBottom,
    /** True when the container is scrolled to (or near) the bottom. */
    isAtBottom,
  } as const;
}
