use crate::audio_format::AudioConfig;
use std::collections::VecDeque;

/// Energy-based Voice Activity Detector.
///
/// Uses RMS (Root Mean Square) energy threshold to detect speech vs silence.
/// Includes hysteresis (state machine with configurable frame counts) to prevent
/// rapid toggling at the boundary.
///
/// Supports both i16 PCM frames (via `process_frame`) and f32 PCM frames
/// (via `process_f32_frame`), so it can be used from both the standalone
/// `detect_voice_activity` command and the ScreenCaptureKit streaming pipeline.
pub struct VoiceActivityDetector {
    config: AudioConfig,
    /// Running buffer of recent frame decisions for smoothing
    recent_decisions: VecDeque<bool>,
    /// Number of consecutive frames that must be silent before we declare silence
    silence_threshold_frames: usize,
    /// Number of consecutive frames that must have speech before we declare speech
    speech_threshold_frames: usize,
    /// Current speech state
    is_speaking: bool,
    /// Frame duration in ms
    frame_duration_ms: usize,
    /// RMS energy threshold for speech detection
    energy_threshold: f64,
    /// Consecutive silence frame count (for utterance boundary detection)
    consecutive_silence: usize,
    /// Whether speech has ever been detected since last reset.
    /// Prevents utterance_complete from triggering before any speech.
    has_ever_spoken: bool,
}

impl VoiceActivityDetector {
    /// Create a new VAD with default settings (20ms frames, balanced sensitivity)
    pub fn new() -> Self {
        Self {
            config: AudioConfig::default(),
            recent_decisions: VecDeque::with_capacity(50),
            silence_threshold_frames: 15, // ~300ms at 20ms frames
            speech_threshold_frames: 3,   // ~60ms at 20ms frames
            is_speaking: false,
            frame_duration_ms: 20,
            energy_threshold: 0.005, // RMS threshold — adjust based on testing
            consecutive_silence: 0,
            has_ever_spoken: false,
        }
    }

    /// Set the energy threshold for speech detection.
    /// Lower values = more sensitive (detects quieter speech).
    /// Typical range: 0.001 (very sensitive) to 0.05 (only loud speech).
    pub fn with_energy_threshold(mut self, threshold: f64) -> Self {
        self.energy_threshold = threshold;
        self
    }

    /// Set frame duration in ms (10, 20, or 30).
    pub fn with_frame_duration(mut self, ms: usize) -> Self {
        self.frame_duration_ms = ms;
        self
    }

    /// Set hysteresis thresholds.
    pub fn with_thresholds(mut self, silence_frames: usize, speech_frames: usize) -> Self {
        self.silence_threshold_frames = silence_frames;
        self.speech_threshold_frames = speech_frames;
        self
    }

    /// Calculate RMS energy of a PCM audio frame (i16 samples).
    fn calculate_rms(samples: &[i16]) -> f64 {
        if samples.is_empty() {
            return 0.0;
        }

        let sum_squared: f64 = samples
            .iter()
            .map(|&s| {
                let normalized = s as f64 / i16::MAX as f64;
                normalized * normalized
            })
            .sum();

        (sum_squared / samples.len() as f64).sqrt()
    }

    /// Calculate RMS energy of a f32 PCM frame (used by ScreenCaptureKit pipeline).
    pub fn calculate_rms_f32(samples: &[f32]) -> f64 {
        if samples.is_empty() {
            return 0.0;
        }

        let sum_squared: f64 = samples
            .iter()
            .map(|&s| {
                let v = s as f64;
                v * v
            })
            .sum();

        (sum_squared / samples.len() as f64).sqrt()
    }

    // ── Internal state machine step ──

    fn update_state(&mut self, is_voice: bool) {
        // Add to rolling window
        self.recent_decisions.push_back(is_voice);
        // Cap deque at the larger of the two thresholds so old frames age out
        // and the hysteresis state machine can transition correctly.
        let cap = self.silence_threshold_frames.max(self.speech_threshold_frames);
        if self.recent_decisions.len() > cap {
            self.recent_decisions.pop_front();
        }

        // Track consecutive silence for utterance boundary detection
        if is_voice {
            self.consecutive_silence = 0;
            self.has_ever_spoken = true;
        } else {
            self.consecutive_silence += 1;
        }

        // State machine: speech ↔ silence with hysteresis
        let recent_count = self.recent_decisions.len();
        let voice_count = self.recent_decisions.iter().filter(|&&v| v).count();

        if !self.is_speaking && voice_count >= self.speech_threshold_frames {
            self.is_speaking = true;
        } else if self.is_speaking
            && recent_count >= self.silence_threshold_frames
            && voice_count == 0
        {
            self.is_speaking = false;
        }
    }

    /// Process a single audio frame (i16 PCM) and return whether speech is currently detected.
    /// Audio data must be 16kHz, mono, 16-bit PCM.
    pub fn process_frame(&mut self, audio_frame: &[u8]) -> bool {
        let samples = AudioConfig::bytes_to_samples(audio_frame);
        let rms = Self::calculate_rms(&samples);
        let is_voice = rms > self.energy_threshold;
        self.update_state(is_voice);
        self.is_speaking
    }

    /// Process a single audio frame as f32 samples (used by ScreenCaptureKit pipeline).
    /// Returns whether speech is currently detected.
    pub fn process_f32_frame(&mut self, samples: &[f32]) -> bool {
        let rms = Self::calculate_rms_f32(samples);
        let is_voice = rms > self.energy_threshold;
        self.update_state(is_voice);
        self.is_speaking
    }

    /// Process raw audio data (i16 PCM), splitting into frames and detecting VAD.
    /// Returns the final speech state after processing all frames.
    pub fn process_audio(&mut self, audio_data: &[u8]) -> bool {
        let samples = AudioConfig::bytes_to_samples(audio_data);
        let samples_per_frame =
            (self.config.sample_rate as usize * self.frame_duration_ms) / 1000;

        for chunk in samples.chunks(samples_per_frame) {
            let frame_bytes = AudioConfig::samples_to_bytes(chunk);
            self.process_frame(&frame_bytes);
        }

        self.is_speaking
    }

    // ── Utterance boundary detection ──

    /// Returns true when speech has ended and enough silence has passed
    /// to consider this the end of an utterance.
    ///
    /// An utterance is "complete" when:
    /// 1. Speech was previously active (is_speaking was true)
    /// 2. Now silence has persisted for `utterance_silence_frames` frames
    ///
    /// Default utterance boundary: 800 ms of silence (40 frames at 20ms).
    /// This is longer than the hysteresis threshold to avoid cutting mid-sentence.
    pub fn utterance_complete(&self, utterance_silence_frames: usize) -> bool {
        self.has_ever_spoken
            && !self.is_speaking
            && self.consecutive_silence >= utterance_silence_frames
    }

    /// Check if speech is currently detected.
    pub fn is_speaking(&self) -> bool {
        self.is_speaking
    }

    /// Get the current consecutive silence frame count.
    pub fn silence_frames(&self) -> usize {
        self.consecutive_silence
    }

    /// Reset internal state (e.g., between recording sessions).
    pub fn reset(&mut self) {
        self.recent_decisions.clear();
        self.is_speaking = false;
        self.consecutive_silence = 0;
        self.has_ever_spoken = false;
    }
}

impl Default for VoiceActivityDetector {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Generate silence frame (all zeros)
    fn make_silence_frame() -> Vec<u8> {
        vec![0u8; 640] // 20ms of silence at 16kHz mono 16-bit
    }

    /// Generate a loud tone frame (high amplitude sine wave)
    fn make_loud_frame() -> Vec<u8> {
        let samples: Vec<i16> = (0..320)
            .map(|i| {
                let t = i as f64 / 16000.0;
                let amplitude = 0.8 * i16::MAX as f64;
                (amplitude * (2.0 * std::f64::consts::PI * 440.0 * t).sin()) as i16
            })
            .collect();
        AudioConfig::samples_to_bytes(&samples)
    }

    #[test]
    fn test_silence_not_detected() {
        let mut vad = VoiceActivityDetector::new();
        // Feed many silence frames
        for _ in 0..20 {
            vad.process_frame(&make_silence_frame());
        }
        assert!(!vad.is_speaking());
    }

    #[test]
    fn test_loud_speech_detected() {
        let mut vad = VoiceActivityDetector::new();
        // Feed loud frames
        for _ in 0..10 {
            vad.process_frame(&make_loud_frame());
        }
        assert!(vad.is_speaking());
    }

    #[test]
    fn test_hysteresis_transitions() {
        let mut vad = VoiceActivityDetector::new()
            .with_thresholds(5, 2);

        // Start with silence
        for _ in 0..10 {
            vad.process_frame(&make_silence_frame());
        }
        assert!(!vad.is_speaking());

        // Speech starts
        vad.process_frame(&make_loud_frame());
        vad.process_frame(&make_loud_frame());
        assert!(vad.is_speaking());

        // Silence returns — need 5 frames
        for _ in 0..4 {
            vad.process_frame(&make_silence_frame());
        }
        assert!(vad.is_speaking()); // Still speaking (hysteresis)

        vad.process_frame(&make_silence_frame());
        assert!(!vad.is_speaking()); // Now silent
    }

    #[test]
    fn test_reset() {
        let mut vad = VoiceActivityDetector::new();
        vad.is_speaking = true;
        vad.recent_decisions.push_back(true);
        vad.consecutive_silence = 10;
        vad.reset();
        assert!(!vad.is_speaking());
        assert!(vad.recent_decisions.is_empty());
        assert_eq!(vad.consecutive_silence, 0);
    }

    #[test]
    fn test_rms_silence() {
        let silence: Vec<i16> = vec![0; 320];
        let rms = VoiceActivityDetector::calculate_rms(&silence);
        assert_eq!(rms, 0.0);
    }

    #[test]
    fn test_rms_loud() {
        let loud: Vec<i16> = vec![16000; 320];
        let rms = VoiceActivityDetector::calculate_rms(&loud);
        assert!(rms > 0.1);
    }

    #[test]
    fn test_rms_f32_silence() {
        let silence: Vec<f32> = vec![0.0; 320];
        let rms = VoiceActivityDetector::calculate_rms_f32(&silence);
        assert_eq!(rms, 0.0);
    }

    #[test]
    fn test_rms_f32_loud() {
        let loud: Vec<f32> = vec![0.5; 320];
        let rms = VoiceActivityDetector::calculate_rms_f32(&loud);
        assert!(rms > 0.4);
    }

    #[test]
    fn test_utterance_complete() {
        let mut vad = VoiceActivityDetector::new().with_thresholds(5, 2);

        // Silence first
        for _ in 0..50 {
            vad.process_frame(&make_silence_frame());
        }
        assert!(!vad.utterance_complete(40)); // no speech yet, shouldn't trigger

        // Speech
        for _ in 0..10 {
            vad.process_frame(&make_loud_frame());
        }
        assert!(vad.is_speaking());

        // Short silence (not enough for utterance boundary)
        for _ in 0..20 {
            vad.process_frame(&make_silence_frame());
        }
        assert!(!vad.is_speaking()); // hysteresis says silent
        assert!(!vad.utterance_complete(40)); // but not enough silence for utterance

        // More silence
        for _ in 0..30 {
            vad.process_frame(&make_silence_frame());
        }
        assert!(vad.utterance_complete(40)); // now utterance is complete
    }

    #[test]
    fn test_f32_frame_basic() {
        let mut vad = VoiceActivityDetector::new();
        let loud: Vec<f32> = vec![0.5; 320];
        for _ in 0..10 {
            vad.process_f32_frame(&loud);
        }
        assert!(vad.is_speaking());
    }
}
