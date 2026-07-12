/**
 * Audio service — bridges the frontend to Tauri Rust commands.
 *
 * Every function in this module calls `invoke()` from `@tauri-apps/api/core`
 * to execute the corresponding backend command. Errors are caught and
 * re-thrown as user-friendly messages.
 *
 * @module audioService
 */

import { invoke } from '@tauri-apps/api/core';
import type { AudioDeviceInfo, RecognitionResult, RecordingState } from '@/types';

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a Tauri invoke call with structured error handling.
 *
 * Translates raw Rust panics/errors into descriptive messages suitable
 * for showing in the UI.
 */
async function safeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    // Map known error patterns
    if (message.includes('permission') || message.includes('denied')) {
      throw new Error(
        `Microphone permission denied for "${command}". ` +
        'Please grant microphone access in System Settings > Privacy & Security > Microphone.',
      );
    }
    if (message.includes('no device') || message.includes('not found')) {
      throw new Error(
        `No audio device available for "${command}". ` +
        'Please connect a microphone and try again.',
      );
    }
    if (message.includes('timeout') || message.includes('timed out')) {
      throw new Error(
        `Audio operation timed out for "${command}". Please try again.`,
      );
    }

    throw new Error(`Audio service error (${command}): ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Recording state tracking
// ---------------------------------------------------------------------------

/** Internal tracking of the current recording pipeline state. */
let _recordingState: RecordingState = 'idle';

// ---------------------------------------------------------------------------
// Audio service
// ---------------------------------------------------------------------------

export const audioService = {
  /**
   * Start recording audio from the selected source.
   *
   * @param source - The audio source ("microphone" or "system_audio").
   * @param deviceId - Optional specific device ID to use.
   * @returns A promise that resolves once recording has started.
   */
  async startRecording(source: string = 'microphone', deviceId?: string): Promise<void> {
    _recordingState = 'recording';
    await safeInvoke<void>('start_recording', {
      source,
      ...(deviceId ? { deviceId } : {}),
    });
  },

  /**
   * Stop the active recording session and return the captured audio data.
   *
   * @returns The recorded audio data as a base64-encoded string.
   */
  async stopRecording(): Promise<string> {
    const result = await safeInvoke<string>('stop_recording');
    _recordingState = 'idle';
    return result;
  },

  /**
   * Return the current recording pipeline state.
   *
   * Unlike the async `isRecording()` check which queries the Rust backend,
   * this synchronous call uses a client-side track of the recording state
   * that is updated whenever `startRecording` or `stopRecording` is called.
   *
   * @returns The current {@link RecordingState}.
   */
  getRecordingState(): RecordingState {
    return _recordingState;
  },

  /**
   * Check whether the application is currently recording.
   *
   * @returns `true` if recording is active.
   */
  async isRecording(): Promise<boolean> {
    return safeInvoke<boolean>('is_recording');
  },

  /**
   * Run Automatic Speech Recognition on audio data.
   *
   * @param audioData - Base64-encoded audio data.
   * @param language - Optional BCP-47 language hint for the ASR engine.
   * @returns The recognized text with confidence score.
   */
  async recognizeSpeech(audioData: string, language?: string): Promise<RecognitionResult> {
    return safeInvoke<RecognitionResult>('recognize_speech', {
      audioData,
      ...(language ? { language } : {}),
    });
  },

  /**
   * Synthesize text into speech and play it through the default output device.
   *
   * This runs as a fire-and-forget operation since TTS playback is inherently
   * asynchronous and non-blocking. Errors are silently caught to avoid
   * disrupting the user's workflow.
   *
   * @param text - The text to synthesize.
   * @param language - BCP-47 language code for TTS voice selection.
   */
  async synthesizeSpeech(text: string, language: string): Promise<void> {
    try {
      await invoke<void>('synthesize_speech', { text, language });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[audioService] TTS playback failed: ${message}`);
      // Fire-and-forget: do not propagate to the caller
    }
  },

  /**
   * Detect voice activity in audio data (Voice Activity Detection).
   *
   * @param audioData - Base64-encoded audio data to analyze.
   * @returns `true` if speech is detected.
   */
  async detectVoiceActivity(audioData: string): Promise<boolean> {
    return safeInvoke<boolean>('detect_voice_activity', { audioData });
  },

  /**
   * Retrieve a list of available microphone devices.
   *
   * @returns Array of audio device descriptors.
   */
  async getAvailableMicrophones(): Promise<AudioDeviceInfo[]> {
    return safeInvoke<AudioDeviceInfo[]>('get_available_microphones');
  },

  /**
   * Check whether the selected ASR engine is available on the current system.
   *
   * @returns `true` if the ASR engine can be used.
   */
  async checkAsrAvailability(): Promise<boolean> {
    return safeInvoke<boolean>('check_asr_availability');
  },

  /**
   * Start capturing system audio (loopback / stereo mix).
   *
   * @returns A promise that resolves once system audio capture begins.
   */
  async startSystemAudio(): Promise<void> {
    return safeInvoke<void>('start_system_audio');
  },

  /**
   * Stop capturing system audio.
   *
   * @returns A promise that resolves once system audio capture stops.
   */
  async stopSystemAudio(): Promise<void> {
    return safeInvoke<void>('stop_system_audio');
  },
};
