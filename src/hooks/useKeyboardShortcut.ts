/**
 * React hook that implements a push-to-talk interaction model via the
 * Space key.
 *
 * Behaviour:
 * - **Space press** (keydown): calls `onPress` callback (typically starts
 *   recording) when no input / textarea / contenteditable element is focused.
 * - **Space release** (keyup): calls `onRelease` callback (typically stops
 *   recording) regardless of which element is focused (but only if the press
 *   was accepted).
 *
 *
 * The hook returns an `isPressed` boolean that components can use to show
 * a visual indicator, plus `registerShortcut` / `unregisterShortcut` to
 * dynamically toggle the listener.
 *
 * @example
 * ```tsx
 * const { isPressed } = useKeyboardShortcut({
 *   onPress: startRecording,
 *   onRelease: stopRecording,
 * });
 *
 * return <div className={isPressed ? 'bg-blue-100' : ''}>…</div>;
 * ```
 */

import { useEffect, useRef, useCallback, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseKeyboardShortcutOptions {
  /** Called when the Space key is pressed (and not inside an input). */
  onPress?: () => void;
  /** Called when the Space key is released after a tracked press. */
  onRelease?: () => void;
  /** When false, keyboard and global shortcuts are ignored. Default true. */
  enabled?: boolean;
}

export interface UseKeyboardShortcutReturn {
  /** True while the Space key is held down (tracked). */
  isPressed: boolean;
  /** Enable the keyboard listener. No-op if already registered. */
  registerShortcut: () => void;
  /** Disable the keyboard listener and clean up global shortcuts. */
  unregisterShortcut: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Elements that should not trigger push-to-talk when focused. */
const INPUT_SELECTOR =
  'input, textarea, [contenteditable="true"], [contenteditable=""]';


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return true when the event target is a text-editable element where
 * Space should insert a character rather than trigger recording.
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  return target.matches(INPUT_SELECTOR) || target.closest(INPUT_SELECTOR) !== null;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useKeyboardShortcut(
  options: UseKeyboardShortcutOptions = {},
): UseKeyboardShortcutReturn {
  const { onPress, onRelease, enabled = true } = options;

  // --- Refs (avoid stale closures in event handlers) ---------------------
  const onPressRef = useRef(onPress);
  const onReleaseRef = useRef(onRelease);
  const pressedRef = useRef(false);
  const enabledRef = useRef(enabled);

  // Keep refs in sync with latest values
  onPressRef.current = onPress;
  onReleaseRef.current = onRelease;
  enabledRef.current = enabled;

  // --- Local state (used for reactive UI updates) ------------------------
  const [isPressed, setIsPressed] = useState(false);
  const [registered, setRegistered] = useState(enabled);

  // -----------------------------------------------------------------------
  // Keydown handler
  // -----------------------------------------------------------------------
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.code !== 'Space' && e.key !== ' ') return;
    if (!enabledRef.current) return;
    if (isEditableTarget(e.target)) return;

    e.preventDefault();

    if (!pressedRef.current) {
      pressedRef.current = true;
      setIsPressed(true);
      onPressRef.current?.();
    }
  }, []);

  // -----------------------------------------------------------------------
  // Keyup handler
  // -----------------------------------------------------------------------
  const handleKeyUp = useCallback((e: KeyboardEvent) => {
    if (e.code !== 'Space' && e.key !== ' ') return;
    if (!pressedRef.current) return;

    pressedRef.current = false;
    setIsPressed(false);
    onReleaseRef.current?.();
  }, []);

  // -----------------------------------------------------------------------
  // Browser key listener
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!registered) return;

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    window.addEventListener('keyup', handleKeyUp, { capture: true });

    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      window.removeEventListener('keyup', handleKeyUp, { capture: true });
    };
  }, [registered, handleKeyDown, handleKeyUp]);

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Enable the shortcut. */
  const registerShortcut = useCallback(() => {
    setRegistered(true);
  }, []);

  /** Disable the shortcut and release any stuck pressed state. */
  const unregisterShortcut = useCallback(() => {
    setRegistered(false);
    pressedRef.current = false;
    setIsPressed(false);
  }, []);

  return { isPressed, registerShortcut, unregisterShortcut };
}
