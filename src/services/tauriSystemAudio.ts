/**
 * Native system audio capture via Tauri's Rust backend (ScreenCaptureKit).
 *
 * On macOS 13+, uses Apple's ScreenCaptureKit API for zero-dependency
 * system audio capture. No virtual audio driver (BlackHole) needed.
 *
 * **Architecture (v2): Utterance-driven**
 *
 * The Rust backend now performs VAD-based utterance segmentation. Instead of
 * polling arbitrary sliding windows, we poll `get_next_utterance()` which
 * returns complete speech segments (sentences/phrases) detected by the VAD.
 * Each utterance is a semantically coherent unit → better ASR accuracy.
 *
 * Falls back to the browser getDisplayMedia approach when Tauri APIs
 * are unavailable (e.g. running in a regular browser for dev/testing).
 *
 * @module tauriSystemAudio
 */

// ---------------------------------------------------------------------------
// PCM → WAV conversion (kept for browser fallback path)
// ---------------------------------------------------------------------------

/**
 * Convert raw PCM audio data to a WAV Blob suitable for Whisper API.
 *
 * ScreenCaptureKit outputs non-interleaved (planar) f32 PCM at 48kHz stereo.
 * We convert to 16kHz mono i16 WAV for best compatibility with ASR APIs.
 */
export function pcmToWavBlob(
  pcmData: Uint8Array,
  sampleRate: number = 48000,
  numChannels: number = 2,
): Blob {
  const totalFloats = Math.floor(pcmData.length / 4);
  const numFrames = Math.floor(totalFloats / numChannels);
  const f32View = new Float32Array(
    pcmData.buffer,
    pcmData.byteOffset,
    totalFloats,
  );

  // Downmix stereo → mono + downsample 48kHz → 16kHz
  const downsampleRatio = Math.round(sampleRate / 16000);
  const outFrames = Math.floor(numFrames / downsampleRatio);
  const f32Samples = new Float32Array(outFrames);

  let peak = 0;
  for (let i = 0; i < outFrames; i++) {
    const baseFrame = i * downsampleRatio;
    let sum = 0;
    let count = 0;
    for (let j = 0; j < downsampleRatio && (baseFrame + j) < numFrames; j++) {
      let frameSum = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        const idx = ch * numFrames + baseFrame + j;
        frameSum += f32View[idx];
      }
      sum += frameSum / numChannels;
      count++;
    }
    const avg = sum / count;
    f32Samples[i] = avg;
    if (Math.abs(avg) > peak) peak = Math.abs(avg);
  }

  // Normalize and convert to i16
  const gain = peak > 0.001 ? Math.min(0.95 / peak, 5) : 1;
  const i16Samples = new Int16Array(outFrames);
  for (let i = 0; i < outFrames; i++) {
    const clamped = Math.max(-1, Math.min(1, f32Samples[i] * gain));
    i16Samples[i] = Math.round(clamped * 32767);
  }

  return encodeWav(i16Samples, 16000, 1);
}

function encodeWav(
  samples: Int16Array,
  sampleRate: number,
  numChannels: number,
): Blob {
  const byteRate = sampleRate * numChannels * 2;
  const blockAlign = numChannels * 2;
  const dataSize = samples.length * 2;
  const headerSize = 44;
  const buffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const samplesView = new Int16Array(buffer, 44, samples.length);
  samplesView.set(samples);

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// ---------------------------------------------------------------------------
// Tauri native capture (utterance-driven)
// ---------------------------------------------------------------------------

export interface TauriSystemAudioState {
  isCapturing: boolean;
}

type StateListener = (state: TauriSystemAudioState) => void;

/** Callback receives a complete utterance WAV blob from the Rust VAD. */
export type UtteranceCallback = (wavBlob: Blob) => void;

export class TauriSystemAudioCapture {
  private listeners = new Set<StateListener>();
  private _isCapturing = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private utteranceCallback: UtteranceCallback | null = null;

  get isCapturing(): boolean {
    return this._isCapturing;
  }

  onStateChange(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(isCapturing: boolean): void {
    this._isCapturing = isCapturing;
    for (const listener of this.listeners) {
      try { listener({ isCapturing }); } catch { /* isolate */ }
    }
  }

  /**
   * Start utterance-driven capture.
   *
   * The Rust backend performs VAD-based segmentation internally.
   * We poll `get_next_utterance()` every 200ms — when a complete
   * utterance is available, the callback is invoked with its WAV data.
   *
   * @param onUtterance - Called with each complete utterance (WAV blob).
   */
  async start(onUtterance: UtteranceCallback): Promise<void> {
    console.log('[TauriSystemAudio] Starting utterance-driven capture...');

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('start_system_audio');
      console.log('[TauriSystemAudio] Capture started (utterance mode)');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[TauriSystemAudio] Failed to start:', msg);
      throw new Error(`System audio capture failed: ${msg}`);
    }

    this.utteranceCallback = onUtterance;
    this.setState(true);

    // Poll for complete utterances at 200ms intervals
    // This is fast enough for low latency but won't busy-wait the CPU
    this.pollInterval = setInterval(async () => {
      if (!this._isCapturing || !this.utteranceCallback) return;
      try {
        const { invoke } = await import('@tauri-apps/api/core');

        // Check how many utterances are waiting
        const count = await invoke<number>('get_utterance_count');
        if (count === 0) return;

        // Consume all available utterances
        for (let i = 0; i < count; i++) {
          const wavData = await invoke<number[]>('get_next_utterance');
          if (!wavData || wavData.length === 0) continue;

          const wavBlob = new Blob([new Uint8Array(wavData)], { type: 'audio/wav' });
          console.log('[TauriSystemAudio] Utterance:', wavBlob.size, 'bytes');
          this.utteranceCallback(wavBlob);
        }
      } catch (err) {
        console.error('[TauriSystemAudio] Poll error:', err);
      }
    }, 200);
  }

  /** Stop native system audio capture. */
  async stop(): Promise<void> {
    console.log('[TauriSystemAudio] Stopping...');

    if (this.pollInterval !== null) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    // Grab any remaining utterances before stopping
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      // Drain remaining utterances
      let drained = 0;
      while (drained < 20) {
        const wavData = await invoke<number[]>('get_next_utterance');
        if (!wavData || wavData.length === 0) break;
        if (this.utteranceCallback) {
          const wavBlob = new Blob([new Uint8Array(wavData)], {
            type: 'audio/wav',
          });
          this.utteranceCallback(wavBlob);
        }
        drained++;
      }
      await invoke('stop_system_audio');
    } catch {
      // Best effort
    }

    this.utteranceCallback = null;
    this.setState(false);
  }

  /** Check whether Tauri native APIs are available. */
  static async isNativeAvailable(): Promise<boolean> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('is_system_audio_capturing');
      return true;
    } catch {
      return false;
    }
  }
}

export const tauriSystemAudioCapture = new TauriSystemAudioCapture();
