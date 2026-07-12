/// Native macOS system audio capture using ScreenCaptureKit (macOS 13+).
///
/// **Architecture (v2): Utterance-driven segmentation**
///
/// Instead of returning arbitrary sliding windows, this module now:
/// 1. Continuously captures system audio via ScreenCaptureKit.
/// 2. Feeds RMS energy into a `VoiceActivityDetector` to track speech/silence.
/// 3. When speech is detected, accumulates samples into an utterance buffer.
/// 4. When silence persists for 800 ms after speech, the utterance is considered
///    complete — it is encoded as 16 kHz mono WAV and pushed onto a queue.
/// 5. The frontend polls `get_next_utterance()` to consume complete utterances,
///    each of which is a semantically coherent unit (sentence / phrase).
///
/// Audio preprocessing is applied before encoding: DC offset removal, high-pass
/// filter (80 Hz), and soft noise gating to improve ASR accuracy on YouTube audio.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

// ---------------------------------------------------------------------------
// Shared utterance metadata
// ---------------------------------------------------------------------------

/// A complete detected utterance, ready for ASR/translation.
#[derive(Clone, Debug)]
pub struct Utterance {
    /// WAV-encoded audio (16 kHz, mono, i16 PCM).
    pub wav_data: Vec<u8>,
    /// Monotonic timestamp (ms since capture start) when speech began.
    pub start_ms: u64,
    /// Duration of the utterance in ms.
    pub duration_ms: u64,
    /// Peak RMS energy (0.0–1.0) — useful for gain decisions downstream.
    pub peak_rms: f64,
}

// ---------------------------------------------------------------------------
// macOS implementation
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use crate::vad::VoiceActivityDetector;
    use screencapturekit::prelude::*;
    use screencapturekit::stream::configuration::PixelFormat;
    use std::cell::Cell;
    use std::time::Instant;

    // ── Constants ──

    /// RMS threshold above which audio is considered speech.
    const RMS_SPEECH_THRESHOLD: f64 = 0.005;
    /// Number of 16 kHz samples represented by one 20 ms VAD frame.
    const FRAME_SAMPLES_16K: usize = 16_000 * 20 / 1_000;
    /// Frames of silence needed to declare utterance complete.
    /// At 20 ms per VAD frame, 40 frames = 800 ms.
    const UTTERANCE_SILENCE_FRAMES: usize = 40;
    /// Silence needed before a too-short utterance is abandoned for good.
    /// Much longer than `UTTERANCE_SILENCE_FRAMES` so a brief interjection
    /// ("yes", "对", "OK") has a chance to merge with the speech that
    /// follows it instead of being discarded outright.
    const SHORT_UTTERANCE_ABANDON_FRAMES: usize = 100; // ~2000 ms

    /// Minimum utterance duration in ms — shorter segments are likely false
    /// positives (coughs, clicks, background noise spikes). Utterances under
    /// this are NOT dropped immediately; see `SHORT_UTTERANCE_ABANDON_FRAMES`.
    const MIN_UTTERANCE_DURATION_MS: u64 = 300;

    /// Maximum utterance duration in ms — if someone talks continuously for
    /// longer than this, we force-split to keep ASR latency reasonable.
    const MAX_UTTERANCE_DURATION_MS: u64 = 15_000;
    /// Audio tail carried over across a forced split so the word spanning
    /// the cut point isn't chopped in half.
    const FORCE_SPLIT_OVERLAP_MS: u64 = 240;

    // ── Audio preprocessing (interior mutability via Cell for Fn closures) ──

    /// DC offset tracker — simple exponential moving average.
    /// Uses `Cell` for state so `process()` only needs `&self`.
    struct DcBlocker {
        alpha: f32,
        prev_input: Cell<f32>,
        prev_output: Cell<f32>,
    }

    impl DcBlocker {
        fn new(alpha: f32) -> Self {
            Self { alpha, prev_input: Cell::new(0.0), prev_output: Cell::new(0.0) }
        }

        #[inline]
        fn process(&self, sample: f32) -> f32 {
            let pi = self.prev_input.get();
            let po = self.prev_output.get();
            let out = sample - pi + self.alpha * po;
            self.prev_input.set(sample);
            self.prev_output.set(out);
            out
        }
    }

    /// Simple first-order high-pass filter (Butterworth approximation).
    /// Cuts frequencies below ~80 Hz to remove rumble (AC, fans, traffic).
    /// Uses `Cell` for state so `process()` only needs `&self`.
    struct HighPassFilter {
        alpha: f32,
        prev_input: Cell<f32>,
        prev_output: Cell<f32>,
    }

    impl HighPassFilter {
        fn new(sample_rate: f32, cutoff: f32) -> Self {
            let rc = 1.0 / (2.0 * std::f32::consts::PI * cutoff);
            let dt = 1.0 / sample_rate;
            let alpha = rc / (rc + dt);
            Self { alpha, prev_input: Cell::new(0.0), prev_output: Cell::new(0.0) }
        }

        #[inline]
        fn process(&self, sample: f32) -> f32 {
            let pi = self.prev_input.get();
            let po = self.prev_output.get();
            let out = self.alpha * (po + sample - pi);
            self.prev_input.set(sample);
            self.prev_output.set(out);
            out
        }
    }

    // ── Callback state (shared via Arc for interior mutability) ──

    /// All mutable state needed inside the audio callback.
    struct CallbackState {
        dc_blocker: DcBlocker,
        hp_filter: HighPassFilter,
        utterance_builder: UtteranceBuilder,
        logged: Cell<bool>,
    }

    impl CallbackState {
        fn new() -> Self {
            Self {
                dc_blocker: DcBlocker::new(0.995),
                hp_filter: HighPassFilter::new(48000.0, 80.0),
                utterance_builder: UtteranceBuilder::new(),
                logged: Cell::new(false),
            }
        }
    }

    // ── Utterance builder ──

    struct UtteranceBuilder {
        /// Samples belonging to the current utterance (16 kHz mono f32).
        buffer: Vec<f32>,
        start_ms: u64,
        sample_count_since_start: usize,
    }

    impl UtteranceBuilder {
        fn new() -> Self {
            Self { buffer: Vec::new(), start_ms: 0, sample_count_since_start: 0 }
        }

        fn clear(&mut self) {
            self.buffer.clear();
            self.start_ms = 0;
            self.sample_count_since_start = 0;
        }

        fn is_active(&self) -> bool {
            !self.buffer.is_empty()
        }

        fn duration_ms(&self, sample_rate: usize) -> u64 {
            (self.buffer.len() as u64 * 1000) / (sample_rate as u64)
        }

        fn peak_rms(&self) -> f64 {
            if self.buffer.is_empty() {
                return 0.0;
            }
            let sum_sq: f64 = self.buffer.iter().map(|&v| (v as f64).powi(2)).sum();
            (sum_sq / self.buffer.len() as f64).sqrt()
        }

        /// Encode the utterance buffer as a 16 kHz mono i16 WAV.
        fn to_wav(&self) -> Vec<u8> {
            if self.buffer.is_empty() {
                return Vec::new();
            }

            let peak = self.buffer.iter().map(|v| v.abs()).fold(0.0f32, f32::max);
            let gain = if peak > 0.001 { 0.9 / peak } else { 1.0 };

            let i16_samples: Vec<i16> = self
                .buffer
                .iter()
                .map(|&v| {
                    let clamped = (v as f64 * gain as f64).clamp(-1.0, 1.0);
                    (clamped * 32767.0) as i16
                })
                .collect();

            encode_wav_i16(&i16_samples, 16000, 1)
        }
    }

    // ── Main capture struct ──

    pub struct SystemAudioCapture {
        /// Queue of completed utterances waiting for the frontend to consume.
        utterance_queue: Arc<Mutex<VecDeque<Utterance>>>,
        /// VAD instance shared with the audio callback.
        vad: Arc<Mutex<VoiceActivityDetector>>,
        /// The ScreenCaptureKit stream handle.
        stream: Option<SCStream>,
        /// Whether capture is currently active.
        is_capturing: Arc<Mutex<bool>>,
        /// Start time for timestamp calculations.
        start_time: Option<Instant>,
    }

    impl SystemAudioCapture {
        pub fn new() -> Self {
            Self {
                utterance_queue: Arc::new(Mutex::new(VecDeque::new())),
                vad: Arc::new(Mutex::new(
                    VoiceActivityDetector::new()
                        .with_energy_threshold(RMS_SPEECH_THRESHOLD)
                        .with_frame_duration(20)
                        .with_thresholds(15, 3),
                )),
                stream: None,
                is_capturing: Arc::new(Mutex::new(false)),
                start_time: None,
            }
        }

        pub fn start(&mut self) -> Result<(), String> {
            let mut capturing = self.is_capturing.lock().map_err(|e| format!("Lock error: {e}"))?;
            if *capturing {
                return Err("Already capturing".into());
            }

            // Reset state
            self.utterance_queue.lock().unwrap().clear();
            self.vad.lock().unwrap().reset();
            self.start_time = Some(Instant::now());

            // ── Set up ScreenCaptureKit ──
            let content = SCShareableContent::get()
                .map_err(|e| format!("Failed to get shareable content: {e}"))?;
            let display = content
                .displays()
                .into_iter()
                .next()
                .ok_or_else(|| "No display available".to_string())?;

            eprintln!(
                "[SystemAudio] Display: {}x{}",
                display.width(),
                display.height()
            );

            let filter = SCContentFilter::create()
                .with_display(&display)
                .with_excluding_windows(&[])
                .build();

            let config = SCStreamConfiguration::new()
                .with_width(display.width())
                .with_height(display.height())
                .with_pixel_format(PixelFormat::BGRA)
                .with_minimum_frame_interval(&CMTime::new(1, 1))
                .with_captures_audio(true)
                .with_sample_rate(48000)
                .with_channel_count(2)
                .with_queue_depth(3);

            let utterance_queue = Arc::clone(&self.utterance_queue);
            let vad = Arc::clone(&self.vad);
            let is_capturing = Arc::clone(&self.is_capturing);
            let start_instant = self.start_time.unwrap();
            let callback_state = Arc::new(Mutex::new(CallbackState::new()));

            let mut stream = SCStream::new(&filter, &config);

            // Video handler — required but we ignore frames
            stream.add_output_handler(
                |_s: CMSampleBuffer, _t: SCStreamOutputType| {},
                SCStreamOutputType::Screen,
            );

            // ── Audio callback: preprocessing → VAD → utterance building ──
            stream.add_output_handler(
                move |sample: CMSampleBuffer, of_type: SCStreamOutputType| {
                    if of_type != SCStreamOutputType::Audio {
                        return;
                    }
                    if !*is_capturing.lock().unwrap() {
                        return;
                    }

                    if let Some(list) = sample.audio_buffer_list() {
                        let mut cb = callback_state.lock().unwrap();

                        if !cb.logged.get() {
                            cb.logged.set(true);
                            eprintln!(
                                "[SystemAudio] Streaming: {} bufs × {} samples",
                                list.num_buffers(),
                                sample.num_samples()
                            );
                        }

                        // ── Step 1: Collect samples, compute per-callback RMS ──
                        let mut rms_sum: f64 = 0.0;
                        let mut n: usize = 0;
                        let mut mono_chunk: Vec<f32> = Vec::new();

                        for ab in list.iter() {
                            let data = ab.data();
                            let s: &[f32] = unsafe {
                                std::slice::from_raw_parts(
                                    data.as_ptr() as *const f32,
                                    data.len() / 4,
                                )
                            };

                            // Process in chunks of 6 f32 values (3 stereo pairs)
                            for chunk in s.chunks(6) {
                                if chunk.len() < 6 { break; }
                                let mut frame_mono = 0.0f32;
                                for pair_idx in 0..3 {
                                    let l = chunk[pair_idx * 2];
                                    let r = chunk[pair_idx * 2 + 1];
                                    // Noise gate
                                    let l = if l.abs() < 0.0001 { 0.0 } else { l };
                                    let r = if r.abs() < 0.0001 { 0.0 } else { r };
                                    // Preprocessing chain
                                    let mono = (cb.dc_blocker.process(l) + cb.dc_blocker.process(r)) * 0.5;
                                    let clean = cb.hp_filter.process(mono);
                                    rms_sum += (clean as f64).powi(2);
                                    n += 1;
                                    frame_mono += clean;
                                }
                                mono_chunk.push(frame_mono / 3.0);
                            }
                        }

                        let rms = if n > 0 {
                            (rms_sum / n as f64).sqrt()
                        } else {
                            0.0
                        };

                        // ── Step 2: Feed VAD ──
                        // Feed one VAD "frame" for every 20ms of audio actually contained
                        // in this callback, rather than always exactly one call per
                        // callback. ScreenCaptureKit doesn't guarantee a fixed callback
                        // size, so treating every callback as "one frame" lets the
                        // hysteresis/silence timers (tuned in units of 20ms) drift from
                        // real time whenever a callback happens to deliver more or less
                        // audio than expected — silently shortening or lengthening the
                        // silence gap needed to end an utterance.
                        let mut vad_guard = vad.lock().unwrap();
                        let frame: Vec<f32> = vec![rms as f32; 160];
                        let was_speaking = vad_guard.is_speaking();
                        let frames_in_chunk = (mono_chunk.len() / FRAME_SAMPLES_16K).max(1);
                        let mut is_speaking = was_speaking;
                        for _ in 0..frames_in_chunk {
                            is_speaking = vad_guard.process_f32_frame(&frame);
                        }
                        let elapsed_ms = start_instant.elapsed().as_millis() as u64;

                        // ── Step 3: Utterance state machine ──
                        if is_speaking && !was_speaking && !cb.utterance_builder.is_active() {
                            // Speech just started with no pending fragment to merge
                            // into — begin a fresh utterance.
                            cb.utterance_builder.start_ms = elapsed_ms;
                            cb.utterance_builder.sample_count_since_start = 0;
                        }

                        if is_speaking {
                            cb.utterance_builder.buffer.extend_from_slice(&mono_chunk);
                            cb.utterance_builder.sample_count_since_start += mono_chunk.len();

                            // Force-split if utterance is too long. Carry a short audio
                            // tail into the next segment so the word spanning the cut
                            // point isn't chopped in half for ASR.
                            let dur = cb.utterance_builder.duration_ms(16000);
                            if dur >= MAX_UTTERANCE_DURATION_MS {
                                let wav = cb.utterance_builder.to_wav();
                                if !wav.is_empty() {
                                    let utterance = Utterance {
                                        wav_data: wav,
                                        start_ms: cb.utterance_builder.start_ms,
                                        duration_ms: dur,
                                        peak_rms: cb.utterance_builder.peak_rms(),
                                    };
                                    utterance_queue.lock().unwrap().push_back(utterance);
                                }
                                let overlap_samples = ((FORCE_SPLIT_OVERLAP_MS as usize
                                    * 16_000)
                                    / 1000)
                                    .min(cb.utterance_builder.buffer.len());
                                let tail_start = cb.utterance_builder.buffer.len() - overlap_samples;
                                let tail: Vec<f32> =
                                    cb.utterance_builder.buffer[tail_start..].to_vec();
                                cb.utterance_builder.clear();
                                cb.utterance_builder.start_ms =
                                    elapsed_ms.saturating_sub(FORCE_SPLIT_OVERLAP_MS);
                                cb.utterance_builder.buffer.extend_from_slice(&tail);
                                cb.utterance_builder.sample_count_since_start = tail.len();
                            }
                        }

                        // Check for utterance completion
                        let utt_is_active = cb.utterance_builder.is_active();
                        let is_complete = vad_guard.utterance_complete(UTTERANCE_SILENCE_FRAMES);

                        if !is_speaking && utt_is_active && is_complete {
                            let dur = cb.utterance_builder.duration_ms(16000);
                            if dur >= MIN_UTTERANCE_DURATION_MS {
                                let wav = cb.utterance_builder.to_wav();
                                if !wav.is_empty() {
                                    let utterance = Utterance {
                                        wav_data: wav,
                                        start_ms: cb.utterance_builder.start_ms,
                                        duration_ms: dur,
                                        peak_rms: cb.utterance_builder.peak_rms(),
                                    };
                                    let mut queue = utterance_queue.lock().unwrap();
                                    queue.push_back(utterance);
                                    eprintln!(
                                        "[SystemAudio] Utterance complete: {}ms, queue size: {}",
                                        dur,
                                        queue.len()
                                    );
                                }
                                cb.utterance_builder.clear();
                            } else if vad_guard.silence_frames() >= SHORT_UTTERANCE_ABANDON_FRAMES
                            {
                                // Too short and nothing followed for ~2s — genuinely not
                                // speech (click/cough/noise spike). Safe to drop now.
                                cb.utterance_builder.clear();
                            }
                            // else: leave the fragment buffered. If more speech follows
                            // shortly it merges into this same utterance instead of being
                            // silently discarded — fixes short interjections/words
                            // ("yes"/"OK"/"对") that were previously dropped entirely.
                        }
                    }
                },
                SCStreamOutputType::Audio,
            );

            stream
                .start_capture()
                .map_err(|e| format!("Failed to start capture: {e}"))?;
            *capturing = true;
            self.stream = Some(stream);
            eprintln!("[SystemAudio] Utterance-driven streaming started");
            Ok(())
        }

        pub fn stop(&mut self) -> Result<(), String> {
            *self.is_capturing.lock().unwrap() = false;
            if let Some(s) = self.stream.take() {
                s.stop_capture()
                    .map_err(|e| format!("Stop failed: {e}"))?;
            }
            eprintln!("[SystemAudio] Stopped");
            Ok(())
        }

        // ── Utterance queue API ──

        /// Get the next complete utterance from the queue, if any.
        /// Returns `Ok(Vec::new())` (empty) if no utterance is available.
        pub fn get_next_utterance(&self) -> Result<Vec<u8>, String> {
            let mut queue = self.utterance_queue.lock().unwrap();
            if let Some(utt) = queue.pop_front() {
                eprintln!(
                    "[SystemAudio] Dequeued utterance: {}ms, peak_rms={:.4}, {} utterances remain",
                    utt.duration_ms,
                    utt.peak_rms,
                    queue.len()
                );
                Ok(utt.wav_data)
            } else {
                Ok(Vec::new())
            }
        }

        /// Return the number of utterances waiting in the queue.
        pub fn get_utterance_count(&self) -> Result<u32, String> {
            Ok(self.utterance_queue.lock().unwrap().len() as u32)
        }

        // ── Legacy API (kept for backward compatibility) ──

        pub fn get_window(&self, secs: f32) -> Result<Vec<u8>, String> {
            // Legacy window method — not used in utterance mode, but kept for fallback.
            // Returns empty; the frontend should use get_next_utterance() instead.
            let _ = secs;
            Ok(Vec::new())
        }

        pub fn take_pause(&self) -> Result<bool, String> {
            // Legacy pause method — not meaningful in utterance mode.
            Ok(false)
        }

        pub fn take_audio_data(&self) -> Result<Vec<u8>, String> {
            // Legacy chunk method.
            Ok(Vec::new())
        }

        pub fn take_all_audio(&self) -> Result<Vec<u8>, String> {
            // Legacy — return all pending utterances as a single chunk.
            let mut queue = self.utterance_queue.lock().unwrap();
            if queue.is_empty() {
                return Ok(Vec::new());
            }
            // Concatenate all utterance WAVs (simple approach — frontend can split)
            let mut all = Vec::new();
            while let Some(utt) = queue.pop_front() {
                all.extend_from_slice(&utt.wav_data);
            }
            Ok(all)
        }

        pub fn has_chunk(&self) -> Result<bool, String> {
            Ok(!self.utterance_queue.lock().unwrap().is_empty())
        }

        pub fn is_capturing(&self) -> bool {
            *self.is_capturing.lock().unwrap()
        }
    }

    impl Drop for SystemAudioCapture {
        fn drop(&mut self) {
            let _ = self.stop();
        }
    }

    // ── WAV encoder (shared utility) ──

    /// Encode i16 PCM samples to a standard WAV file.
    fn encode_wav_i16(samples: &[i16], sample_rate: u32, num_channels: u16) -> Vec<u8> {
        let byte_rate = sample_rate * num_channels as u32 * 2;
        let block_align = num_channels * 2;
        let data_size = (samples.len() * 2) as u32;
        let header_size: u32 = 44;
        let total_size = header_size + data_size;

        let mut wav = Vec::with_capacity(total_size as usize);

        // RIFF header
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(total_size - 8).to_le_bytes());
        wav.extend_from_slice(b"WAVE");

        // fmt chunk
        wav.extend_from_slice(b"fmt ");
        wav.extend_from_slice(&16u32.to_le_bytes()); // chunk size
        wav.extend_from_slice(&1u16.to_le_bytes());  // PCM format
        wav.extend_from_slice(&num_channels.to_le_bytes());
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(&byte_rate.to_le_bytes());
        wav.extend_from_slice(&block_align.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes()); // bits per sample

        // data chunk
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_size.to_le_bytes());
        for &s in samples {
            wav.extend_from_slice(&s.to_le_bytes());
        }

        wav
    }
}

// ---------------------------------------------------------------------------
// Non-macOS stub
// ---------------------------------------------------------------------------

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::*;

    pub struct SystemAudioCapture;

    impl SystemAudioCapture {
        pub fn new() -> Self {
            Self
        }
        pub fn start(&mut self) -> Result<(), String> {
            Err("macOS 13+ only".into())
        }
        pub fn stop(&mut self) -> Result<(), String> {
            Ok(())
        }
        pub fn get_next_utterance(&self) -> Result<Vec<u8>, String> {
            Ok(Vec::new())
        }
        pub fn get_utterance_count(&self) -> Result<u32, String> {
            Ok(0)
        }
        pub fn get_window(&self, _: f32) -> Result<Vec<u8>, String> {
            Ok(Vec::new())
        }
        pub fn take_pause(&self) -> Result<bool, String> {
            Ok(false)
        }
        pub fn take_audio_data(&self) -> Result<Vec<u8>, String> {
            Ok(Vec::new())
        }
        pub fn take_all_audio(&self) -> Result<Vec<u8>, String> {
            Ok(Vec::new())
        }
        pub fn has_chunk(&self) -> Result<bool, String> {
            Ok(false)
        }
        pub fn is_capturing(&self) -> bool {
            false
        }
    }
}

pub use imp::SystemAudioCapture;
