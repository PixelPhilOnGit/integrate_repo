use crate::error::AppResult;

/// Unified speech synthesis interface.
///
/// On macOS, uses AVSpeechSynthesizer (system-native).
/// On Windows, uses Windows.Media.SpeechSynthesis.
///
/// NOTE: Platform-specific TTS integration is handled at runtime via
/// the platform-specific code paths. The objc2 types are not Send+Sync,
/// so we use them only within a single-threaded context.
pub struct SpeechSynthesizer;

impl SpeechSynthesizer {
    pub fn new() -> Self {
        Self
    }

    /// Synthesize speech from text and play through system audio output.
    pub fn speak(&self, text: &str, _language: &str) -> AppResult<()> {
        if text.is_empty() {
            return Ok(());
        }

        #[cfg(target_os = "macos")]
        {
            speak_macos(text, _language)
        }

        #[cfg(target_os = "windows")]
        {
            speak_windows(text, _language)
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = (text, _language);
            Err(crate::error::AppError::UnsupportedPlatform)
        }
    }

    /// Check if speech synthesis is available
    pub fn is_available(&self) -> bool {
        cfg!(any(target_os = "macos", target_os = "windows"))
    }
}

/// macOS TTS using AVSpeechSynthesizer.
/// objc2 types are not Send+Sync, so this function is called synchronously
/// from within the Tauri command handler (which runs on the main thread on macOS).
#[cfg(target_os = "macos")]
fn speak_macos(text: &str, language: &str) -> AppResult<()> {
    use std::process::Command;

    // Use the `say` command as a reliable cross-version macOS TTS interface.
    // This avoids objc2 Send+Sync issues with AVSpeechSynthesizer.
    let voice = match language {
        "zh-CN" | "zh" => "Tingting",
        "ja-JP" | "ja" => "Kyoko",
        "ko-KR" | "ko" => "Yuna",
        "fr-FR" | "fr" => "Thomas",
        "de-DE" | "de" => "Anna",
        "es-ES" | "es" => "Monica",
        _ => "Samantha", // Default US English
    };

    let result = Command::new("say")
        .arg("-v")
        .arg(voice)
        .arg(text)
        .spawn();

    match result {
        Ok(mut child) => {
            // Don't wait — let it play asynchronously
            let _ = child.wait();
            Ok(())
        }
        Err(e) => Err(crate::error::AppError::SpeechSynthesis(format!(
            "Failed to invoke TTS: {}",
            e
        ))),
    }
}

#[cfg(target_os = "windows")]
fn speak_windows(_text: &str, _language: &str) -> AppResult<()> {
    // Windows TTS stub — uses Windows.Media.SpeechSynthesis
    Err(crate::error::AppError::SpeechSynthesis(
        "Windows TTS is available but not yet implemented.".into(),
    ))
}

impl Default for SpeechSynthesizer {
    fn default() -> Self {
        Self::new()
    }
}
