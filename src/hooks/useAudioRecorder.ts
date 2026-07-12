/**
 * React hook that manages the audio recording lifecycle.
 *
 * Integrates with the audio service layer and the conversation store to
 * provide a simple start / stop recording API with automatic duration
 * tracking and error handling.
 *
 * Uses refs internally for all mutable state so that timeout callbacks
 * and event handlers always read the latest values without stale closures.
 *
 * @example
 * ```tsx
 * const { startRecording, stopRecording, isRecording, duration, error }
 *   = useAudioRecorder();
 *
 * <button onClick={() => startRecording('microphone')} disabled={isRecording}>
 *   {isRecording ? `Recording... ${duration}s` : 'Start'}
 * </button>
 * <button onClick={stopRecording} disabled={!isRecording}>Stop</button>
 * ```
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useConversationStore } from '@/stores/conversationStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { MAX_RECORDING_DURATION_MS } from '@/constants/languages';
import type { AudioSource } from '@/types';

// ---------------------------------------------------------------------------
// Audio service interface
// ---------------------------------------------------------------------------

/**
 * Minimal interface expected from the audio service layer.
 * The concrete implementation lives in `@/services/audioService`.
 */
interface AudioService {
  startRecording: (source: AudioSource) => Promise<void>;
  stopRecording: () => Promise<string>;
}

/**
 * Lazy-load the audio service so that a missing implementation during
 * early development does not crash the module import.
 */
async function getAudioService(): Promise<AudioService | null> {
  try {
    const mod = await import('@/services/audioService');
    return mod.audioService ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAudioRecorder() {
  // --- Store subscriptions (selectors) -----------------------------------
  const recordingState = useConversationStore((s) => s.recordingState);
  const setRecordingState = useConversationStore((s) => s.setRecordingState);
  const setStatusMessage = useConversationStore((s) => s.setStatusMessage);
  const audioSource = useSettingsStore((s) => s.audioSource);

  // --- Local state -------------------------------------------------------
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // --- Refs (avoid stale closures in callbacks / timeouts) ---------------

  /** Keep the current recording state in a ref so async operations always
   *  see the latest value regardless of when the callback was created. */
  const recordingStateRef = useRef(recordingState);
  recordingStateRef.current = recordingState;

  const serviceRef = useRef<AudioService | null>(null);
  const startTimeRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortedRef = useRef(false);

  // -----------------------------------------------------------------------
  // Cleanup on unmount
  // -----------------------------------------------------------------------
  useEffect(() => {
    return () => {
      if (intervalRef.current !== null) clearInterval(intervalRef.current);
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    };
  }, []);

  // -----------------------------------------------------------------------
  // Core stop logic
  // -----------------------------------------------------------------------

  const stopRecordingCore = useCallback(
    async (): Promise<string | null> => {
      if (recordingStateRef.current !== 'recording') return null;

      // Cancel timers
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }

      abortedRef.current = true;

      if (!serviceRef.current) {
        setRecordingState('idle');
        return null;
      }

      try {
        setRecordingState('recognizing');
        const audioData = await serviceRef.current.stopRecording();
        setRecordingState('idle');
        setDuration(0);
        return audioData;
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : 'Failed to stop recording';
        setError(msg);
        setStatusMessage(msg);
        setRecordingState('idle');
        return null;
      }
    },
    [setRecordingState, setStatusMessage],
  );

  // Keep a ref to the latest stopRecordingCore so the timeout inside
  // startRecording always has access to the current version.
  const stopCoreRef = useRef(stopRecordingCore);
  stopCoreRef.current = stopRecordingCore;

  // -----------------------------------------------------------------------
  // Start recording
  // -----------------------------------------------------------------------
  const startRecording = useCallback(
    async (source?: AudioSource): Promise<void> => {
      if (recordingStateRef.current === 'recording') return;

      setError(null);
      abortedRef.current = false;

      const effectiveSource = source ?? audioSource;

      // Lazy-load the audio service
      if (!serviceRef.current) {
        const svc = await getAudioService();
        if (!svc) {
          const msg = 'Audio service is not available';
          setError(msg);
          setStatusMessage(msg);
          return;
        }
        serviceRef.current = svc;
      }

      try {
        setRecordingState('recording');
        startTimeRef.current = Date.now();
        setDuration(0);
        abortedRef.current = false;

        // Duration ticker -- 200 ms interval
        intervalRef.current = setInterval(() => {
          if (!abortedRef.current) {
            setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
          }
        }, 200);

        // Auto-stop after the maximum recording duration
        timeoutRef.current = setTimeout(() => {
          if (!abortedRef.current) {
            // Use the ref so this always calls the latest version of
            // stopRecordingCore regardless of when this timeout was scheduled.
            stopCoreRef.current().catch(() => {
              /* Errors surfaced via state in stopRecordingCore */
            });
          }
        }, MAX_RECORDING_DURATION_MS);

        await serviceRef.current.startRecording(effectiveSource);
      } catch (err) {
        abortedRef.current = true;
        if (intervalRef.current !== null) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        if (timeoutRef.current !== null) {
          clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }
        const msg =
          err instanceof Error ? err.message : 'Failed to start recording';
        setError(msg);
        setStatusMessage(msg);
        setRecordingState('idle');
      }
    },
    [audioSource, setRecordingState, setStatusMessage],
  );

  // -----------------------------------------------------------------------
  // Public stop -- delegates to the core logic
  // -----------------------------------------------------------------------
  const stopRecording = useCallback(
    async (): Promise<string | null> => {
      return stopRecordingCore();
    },
    [stopRecordingCore],
  );

  // -----------------------------------------------------------------------
  // Return value
  // -----------------------------------------------------------------------

  return {
    /** Begin recording from the given (or default) audio source. */
    startRecording,
    /** Stop the active recording and return captured audio data. */
    stopRecording,
    /** Whether the microphone is currently active. */
    isRecording: recordingState === 'recording',
    /** The raw recording pipeline state. */
    recordingState,
    /** Elapsed recording duration in seconds. */
    duration,
    /** Most recent error message, or null when no error. */
    error,
  } as const;
}
