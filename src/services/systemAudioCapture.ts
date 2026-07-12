/**
 * System audio capture service using the Screen Capture API
 * (getDisplayMedia). Captures audio from a browser tab, window,
 * or entire screen for real-time translation of videos, meetings, etc.
 *
 * Works in Chromium-based browsers and Safari 17+. The user selects
 * which tab/window to capture when prompted.
 *
 * @module systemAudioCapture
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SystemAudioState {
  isCapturing: boolean;
  error: string | null;
  /** Whether the captured audio is currently silent (no meaningful signal). */
  isSilent: boolean;
  /** Normalised audio level 0–1 (RMS from AnalyserNode). */
  audioLevel: number;
  /** Emitted once when silence persists beyond the warning threshold. */
  silenceWarning: string | null;
}

export type AudioChunkCallback = (blob: Blob) => void;
type StateListener = (state: SystemAudioState) => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Duration of each audio chunk in milliseconds */
const CHUNK_DURATION_MS = 5_000;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SystemAudioCapture {
  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private listeners = new Set<StateListener>();
  private _state: SystemAudioState = {
    isCapturing: false,
    error: null,
    isSilent: false,
    audioLevel: 0,
    silenceWarning: null,
  };
  private chunkCallback: AudioChunkCallback | null = null;

  // Audio level monitoring
  private audioContext: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private silencePollInterval: ReturnType<typeof setInterval> | null = null;
  private captureStartTime: number = 0;
  private silenceWarningEmitted: boolean = false;
  private cumulativeEnergy: number = 0;

  get state(): SystemAudioState {
    return { ...this._state };
  }

  onStateChange(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(update: Partial<SystemAudioState>): void {
    this._state = { ...this._state, ...update };
    const snapshot = this.state;
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch { /* isolate */ }
    }
  }

  /**
   * Begin monitoring audio levels from the captured stream.
   * Creates an AudioContext → AnalyserNode pipeline and polls every 500 ms.
   * After ~10 s of sustained silence, emits a `silenceWarning`.
   */
  private startAudioMonitoring(stream: MediaStream): void {
    try {
      this.audioContext = new AudioContext();
      const source = this.audioContext.createMediaStreamSource(stream);
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 256;
      source.connect(this.analyserNode);

      this.captureStartTime = Date.now();
      this.silenceWarningEmitted = false;
      this.cumulativeEnergy = 0;

      const bufferLength = this.analyserNode.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      this.silencePollInterval = setInterval(() => {
        if (!this.analyserNode) return;

        this.analyserNode.getByteFrequencyData(dataArray);

        // Calculate RMS energy (0-1 normalised)
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const avg = sum / bufferLength / 255; // 0–1
        this.cumulativeEnergy += avg;

        const elapsed = (Date.now() - this.captureStartTime) / 1000;
        const isSilent = avg < 0.005;

        this.setState({ audioLevel: avg, isSilent });

        // Warn after 10 seconds of near-zero cumulative energy
        if (
          !this.silenceWarningEmitted &&
          elapsed >= 10 &&
          this.cumulativeEnergy < 0.05
        ) {
          this.silenceWarningEmitted = true;
          const isMac = /mac/i.test(navigator.platform ?? '');
          const warning = isMac
            ? '⚠️ No audio detected. macOS desktop app cannot capture audio from other apps. Try the web version in Chrome, or install BlackHole for system-wide audio loopback.'
            : '⚠️ No audio detected. Make sure the shared tab/window is playing sound and "Share audio" is checked.';
          this.setState({ silenceWarning: warning });
          console.debug(
            '[SystemAudioCapture] silence warning emitted — cumulativeEnergy:',
            this.cumulativeEnergy.toFixed(4),
            'elapsed:',
            elapsed.toFixed(1),
            's',
          );
        }

        // Reset cumulative if we see a burst (avoid false positive on quiet moments)
        if (avg > 0.01) {
          this.cumulativeEnergy = Math.max(this.cumulativeEnergy, 0.01);
        }
      }, 500);

      console.log('[SystemAudioCapture] audio monitoring started');
    } catch (err) {
      // AudioContext may fail in some environments — non-fatal
      console.log('[SystemAudioCapture] AudioContext setup failed:', err);
    }
  }

  /** Stop audio monitoring and release AudioContext resources. */
  private stopAudioMonitoring(): void {
    if (this.silencePollInterval !== null) {
      clearInterval(this.silencePollInterval);
      this.silencePollInterval = null;
    }
    if (this.analyserNode) {
      this.analyserNode.disconnect();
      this.analyserNode = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    console.log('[SystemAudioCapture] audio monitoring stopped');
  }

  /**
   * Start capturing system audio. Prompts the user to select a tab/window.
   *
   * @param onChunk - Called every ~5 seconds with a new audio Blob.
   * @throws If getDisplayMedia is not supported, permission is denied, or
   *         no audio track is available.
   */
  async start(onChunk: AudioChunkCallback): Promise<void> {
    if (this._state.isCapturing) {
      throw new Error('Already capturing system audio.');
    }

    console.log('[SystemAudioCapture] start() called');

    this.chunkCallback = onChunk;

    // Check API availability
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error(
        'Screen capture is not supported in this browser. ' +
        'Please use a Chromium-based browser or Safari 17+.'
      );
    }

    let stream: MediaStream;
    try {
      console.log('[SystemAudioCapture] calling getDisplayMedia...');
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,  // Required by spec — user must share something
        audio: true,  // Request system audio
      });
      console.debug(
        '[SystemAudioCapture] stream acquired — audio tracks:',
        stream.getAudioTracks().length,
        'video tracks:',
        stream.getVideoTracks().length,
      );
    } catch (err: unknown) {
      const msg = err instanceof DOMException && err.name === 'NotAllowedError'
        ? 'Screen capture permission was denied.'
        : `Failed to start screen capture: ${String(err)}`;
      this.setState({ error: msg });
      console.log('[SystemAudioCapture] getDisplayMedia failed:', msg);
      throw new Error(msg);
    }

    // Check if audio track is available
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      // No audio — user might have unchecked "Share audio"
      stream.getTracks().forEach((t) => t.stop());
      throw new Error(
        'No audio track available. When sharing, make sure to check "Share audio" ' +
        'and select a tab/window that is playing sound.'
      );
    }

    console.debug(
      '[SystemAudioCapture] audio track label:',
      audioTracks[0].label,
      'settings:',
      JSON.stringify(audioTracks[0].getSettings()),
    );

    // Stop video tracks (we only need audio)
    stream.getVideoTracks().forEach((t) => t.stop());

    this.mediaStream = stream;

    // Create MediaRecorder for the audio stream
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : undefined;

    console.log('[SystemAudioCapture] MediaRecorder mimeType:', mimeType || 'default');

    try {
      this.mediaRecorder = new MediaRecorder(stream, { mimeType });
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
      throw new Error('Failed to create audio recorder from system audio.');
    }

    // Emit chunks on the configured interval
    this.mediaRecorder.ondataavailable = (e: BlobEvent) => {
      console.debug(
        '[SystemAudioCapture] ondataavailable — size:',
        e.data.size,
        'bytes',
      );
      if (e.data.size > 0 && this.chunkCallback) {
        this.chunkCallback(e.data);
      }
    };

    this.mediaRecorder.onstop = () => {
      console.log('[SystemAudioCapture] MediaRecorder stopped');
      this.setState({ isCapturing: false });
    };

    this.mediaRecorder.onerror = () => {
      console.log('[SystemAudioCapture] MediaRecorder error');
      this.setState({ error: 'System audio recording error.', isCapturing: false });
    };

    // Start recording with chunk interval
    this.mediaRecorder.start(CHUNK_DURATION_MS);
    this.setState({
      isCapturing: true,
      isSilent: false,
      audioLevel: 0,
      silenceWarning: null,
    });

    // Begin audio level monitoring
    this.startAudioMonitoring(stream);

    console.log('[SystemAudioCapture] capture started, chunk interval:', CHUNK_DURATION_MS, 'ms');
  }

  /** Stop capturing system audio. */
  stop(): void {
    console.log('[SystemAudioCapture] stop() called');
    this.chunkCallback = null;

    this.stopAudioMonitoring();

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try {
        this.mediaRecorder.stop();
      } catch { /* already stopped */ }
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }

    this.mediaRecorder = null;
    this.setState({
      isCapturing: false,
      error: null,
      isSilent: false,
      audioLevel: 0,
      silenceWarning: null,
    });
  }

  /** Check whether getDisplayMedia is available. */
  static isAvailable(): boolean {
    return !!(navigator.mediaDevices?.getDisplayMedia);
  }

  /**
   * Return platform diagnostics to help callers determine whether
   * system audio capture is likely to work.
   */
  static getDiagnostics(): {
    platform: string;
    userAgent: string;
    isMacOS: boolean;
    isWKWebView: boolean;
    isAvailable: boolean;
  } {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const platform =
      typeof navigator !== 'undefined' ? (navigator.platform ?? '') : '';

    const isMacOS = /Mac OS X/i.test(ua);
    // WKWebView detection: AppleWebKit present, but Chrome and standalone Safari absent
    const isWKWebView =
      /AppleWebKit/i.test(ua) &&
      !/Chrome/i.test(ua) &&
      !/Version\/\d+\.\d+.*Safari/i.test(ua);

    return {
      platform,
      userAgent: ua,
      isMacOS,
      isWKWebView,
      isAvailable: SystemAudioCapture.isAvailable(),
    };
  }
}

export const systemAudioCapture = new SystemAudioCapture();
