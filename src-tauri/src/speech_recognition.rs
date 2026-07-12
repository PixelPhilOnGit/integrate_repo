use crate::error::{AppError, AppResult};

/// Result of speech recognition with confidence score
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RecognitionResult {
    pub text: String,
    pub confidence: f64,
}

/// Speech recognition engine type
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum AsrEngine {
    System,
    Whisper,
}

/// Unified speech recognition interface.
///
/// On macOS, uses SFSpeechRecognizer (system-native, offline-capable).
/// On Windows, uses Windows.Media.SpeechRecognition.
/// Falls back to Whisper API when system ASR confidence is low.
pub struct SpeechRecognizer {
    engine: AsrEngine,
    confidence_threshold: f64,
}

impl SpeechRecognizer {
    pub fn new() -> Self {
        Self {
            engine: AsrEngine::System,
            confidence_threshold: 0.6,
        }
    }

    pub fn with_engine(mut self, engine: AsrEngine) -> Self {
        self.engine = engine;
        self
    }

    pub fn with_confidence_threshold(mut self, threshold: f64) -> Self {
        self.confidence_threshold = threshold;
        self
    }

    /// Check if system speech recognition is available
    pub fn is_available(&self) -> bool {
        #[cfg(target_os = "macos")]
        {
            // SFSpeechRecognizer requires macOS 10.15+
            true
        }

        #[cfg(target_os = "windows")]
        {
            true
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            false
        }
    }

    /// Recognize speech from audio data.
    /// Audio must be 16kHz, mono, 16-bit PCM.
    pub fn recognize(&self, audio_data: &[u8], language: &str) -> AppResult<RecognitionResult> {
        if audio_data.is_empty() {
            return Err(AppError::SpeechRecognition("Empty audio data".into()));
        }

        match self.engine {
            AsrEngine::System => self.recognize_system(audio_data, language),
            AsrEngine::Whisper => self.recognize_whisper_stub(audio_data, language),
        }
    }

    #[cfg(target_os = "macos")]
    fn recognize_system(&self, audio_data: &[u8], language: &str) -> AppResult<RecognitionResult> {
        // SFSpeechRecognizer integration via objc2
        // This is a stub that returns a placeholder result.
        // Full implementation requires:
        // 1. Create SFSpeechRecognizer with locale
        // 2. Create SFSpeechAudioBufferRecognitionRequest
        // 3. Feed audio buffer
        // 4. Await recognition result with confidence

        let _ = audio_data;
        let _ = language;

        Err(AppError::SpeechRecognition(
            "System speech recognition is available but not fully implemented. \
             Use Whisper API as fallback.".into(),
        ))
    }

    #[cfg(target_os = "windows")]
    fn recognize_system(&self, audio_data: &[u8], language: &str) -> AppResult<RecognitionResult> {
        // Windows.Media.SpeechRecognition integration
        // Stub implementation
        let _ = audio_data;
        let _ = language;

        Err(AppError::SpeechRecognition(
            "Windows speech recognition is available but not fully implemented. \
             Use Whisper API as fallback.".into(),
        ))
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    fn recognize_system(&self, _audio_data: &[u8], _language: &str) -> AppResult<RecognitionResult> {
        Err(AppError::UnsupportedPlatform)
    }

    /// Stub for Whisper API recognition.
    /// The actual Whisper API call is made from the frontend (TypeScript)
    /// to avoid bundling HTTP client in Rust.
    fn recognize_whisper_stub(
        &self,
        _audio_data: &[u8],
        _language: &str,
    ) -> AppResult<RecognitionResult> {
        Err(AppError::SpeechRecognition(
            "Whisper recognition is handled by the frontend. Use the translation service.".into(),
        ))
    }
}

impl Default for SpeechRecognizer {
    fn default() -> Self {
        Self::new()
    }
}
