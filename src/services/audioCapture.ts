/**
 * Browser-native audio capture service using the MediaRecorder API.
 *
 * Provides microphone recording that works in Tauri's WebView without
 * depending on the Rust backend (which can't store cpal::Stream in
 * Tauri managed state due to macOS `Send` constraints).
 *
 * Audio is returned as a Blob so it can be:
 * - Sent to a cloud ASR (Whisper API) as a fallback
 * - Played back locally
 * - Attached to messages for later reference
 *
 * @module audioCapture
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AudioCaptureState {
  isRecording: boolean;
  error: string | null;
}

type StateListener = (state: AudioCaptureState) => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIME_TYPE = 'audio/webm;codecs=opus';

// ---------------------------------------------------------------------------
// AudioCapture class
// ---------------------------------------------------------------------------

export class AudioCapture {
  private mediaRecorder: MediaRecorder | null = null;
  private mediaStream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private listeners = new Set<StateListener>();
  private _state: AudioCaptureState = { isRecording: false, error: null };

  /** Subscribe to state changes. Returns an unsubscribe function. */
  onStateChange(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Get current state synchronously. */
  get state(): AudioCaptureState {
    return { ...this._state };
  }

  private setState(update: Partial<AudioCaptureState>): void {
    this._state = { ...this._state, ...update };
    const snapshot = this.state;
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // isolate listener errors
      }
    }
  }

  /**
   * Start recording from the default microphone.
   *
   * @throws If the microphone is not accessible (permission denied or no device).
   */
  async start(): Promise<void> {
    if (this._state.isRecording) {
      throw new Error('Already recording.');
    }

    // Reset state
    this.chunks = [];
    this.setState({ isRecording: false, error: null });

    // Request microphone access
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err: unknown) {
      const message =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Microphone access denied. Please allow microphone access in your browser/system settings.'
          : err instanceof DOMException && err.name === 'NotFoundError'
            ? 'No microphone found. Please connect a microphone and try again.'
            : `Failed to access microphone: ${String(err)}`;
      this.setState({ error: message });
      throw new Error(message);
    }

    this.mediaStream = stream;

    // Create MediaRecorder
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported(MIME_TYPE)
          ? MIME_TYPE
          : undefined,
      });
    } catch (err: unknown) {
      // Clean up stream on failure
      stream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
      throw new Error(`Failed to create audio recorder: ${String(err)}`);
    }

    this.mediaRecorder = recorder;

    // Collect chunks
    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0) {
        this.chunks.push(e.data);
      }
    };

    // Handle stop
    recorder.onstop = () => {
      this.setState({ isRecording: false });
    };

    // Handle errors
    recorder.onerror = () => {
      this.setState({
        error: 'Audio recording error occurred.',
        isRecording: false,
      });
    };

    // Start recording
    recorder.start();
    this.setState({ isRecording: true });
  }

  /**
   * Stop recording and return the captured audio as a Blob.
   *
   * @returns The recorded audio Blob, or null if no audio was captured.
   */
  stop(): Promise<Blob | null> {
    return new Promise((resolve, reject) => {
      const recorder = this.mediaRecorder;

      if (!recorder || recorder.state === 'inactive') {
        // Clean up regardless
        this.cleanupStream();
        resolve(this.buildBlob());
        return;
      }

      recorder.onstop = () => {
        this.setState({ isRecording: false });
        this.cleanupStream();
        resolve(this.buildBlob());
      };

      recorder.onerror = () => {
        this.cleanupStream();
        reject(new Error('Recording stopped with an error.'));
      };

      try {
        recorder.stop();
      } catch (err: unknown) {
        this.cleanupStream();
        reject(new Error(`Failed to stop recording: ${String(err)}`));
      }
    });
  }

  /**
   * Immediately cancel recording without returning audio data.
   */
  cancel(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.onstop = null;
      try {
        this.mediaRecorder.stop();
      } catch {
        // swallow — we're cancelling anyway
      }
    }
    this.chunks = [];
    this.cleanupStream();
    this.setState({ isRecording: false, error: null });
  }

  /**
   * Check whether microphone access has been granted.
   */
  static async checkPermission(): Promise<boolean> {
    try {
      // Try to query permissions API first (may be unavailable in some browsers)
      if (navigator.permissions) {
        const result = await navigator.permissions.query({
          name: 'microphone' as PermissionName,
        });
        return result.state === 'granted';
      }
    } catch {
      // Permissions API may fail in Tauri WebView — fall through
    }

    // Fallback: try to get a stream briefly
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      stream.getTracks().forEach((t) => t.stop());
      return true;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private cleanupStream(): void {
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    this.mediaRecorder = null;
  }

  private buildBlob(): Blob | null {
    if (this.chunks.length === 0) return null;
    const type = this.mediaRecorder?.mimeType || MIME_TYPE;
    const blob = new Blob(this.chunks, { type });
    this.chunks = [];
    return blob;
  }
}

/** Singleton instance shared across the app. */
export const audioCapture = new AudioCapture();
