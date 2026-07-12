use crate::error::AppResult;
use crate::speech_recognition::{RecognitionResult, SpeechRecognizer};
use crate::speech_synthesis::SpeechSynthesizer;
use crate::system_audio::SystemAudioCapture;
use crate::vad::VoiceActivityDetector;
use cpal::traits::{DeviceTrait, HostTrait};
use std::sync::Mutex;
use tauri::State;

/// Application state shared across Tauri commands.
///
/// NOTE: AudioCapture (cpal::Stream) is not stored here because cpal's macOS
/// CoreAudio streams are not `Send`. Recording is driven by the frontend via
/// the MediaRecorder / getUserMedia browser APIs. The Rust backend stores
/// received audio data in `audio_buffer` for ASR and VAD processing.
pub struct AppState {
    pub audio_buffer: Mutex<Vec<u8>>,
    pub is_recording: Mutex<bool>,
    pub speech_recognizer: Mutex<SpeechRecognizer>,
    pub speech_synthesizer: Mutex<SpeechSynthesizer>,
    pub vad: Mutex<VoiceActivityDetector>,
    pub system_audio: Mutex<SystemAudioCapture>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            audio_buffer: Mutex::new(Vec::new()),
            is_recording: Mutex::new(false),
            speech_recognizer: Mutex::new(SpeechRecognizer::new()),
            speech_synthesizer: Mutex::new(SpeechSynthesizer::new()),
            vad: Mutex::new(VoiceActivityDetector::new()),
            system_audio: Mutex::new(SystemAudioCapture::new()),
        }
    }
}

// ── Recording Commands ──
//
// Audio capture is driven by the frontend via MediaRecorder / getUserMedia
// browser APIs. These commands track recording state and buffer management
// so the frontend can coordinate the ASR → translate → TTS pipeline.

#[tauri::command]
pub fn start_recording(state: State<'_, AppState>, source: String) -> Result<(), String> {
    let mut is_rec = state.is_recording.lock().map_err(|e| e.to_string())?;
    if *is_rec {
        return Err("Already recording".into());
    }
    *is_rec = true;

    // Clear any stale audio data from the previous recording session
    let mut buf = state.audio_buffer.lock().map_err(|e| e.to_string())?;
    buf.clear();
    drop(buf);

    // System audio capture requires a virtual audio driver (BlackHole /
    // Soundflower on macOS, WASAPI loopback on Windows). When the user
    // selects system_audio, the frontend uses the appropriate capture API.
    let _ = source;

    Ok(())
}

#[tauri::command]
pub fn stop_recording(state: State<'_, AppState>) -> Result<Vec<u8>, String> {
    let mut is_rec = state.is_recording.lock().map_err(|e| e.to_string())?;
    *is_rec = false;
    drop(is_rec);

    let mut buf = state.audio_buffer.lock().map_err(|e| e.to_string())?;
    let data = std::mem::take(&mut *buf);
    Ok(data)
}

#[tauri::command]
pub fn is_recording(state: State<'_, AppState>) -> Result<bool, String> {
    state.is_recording.lock().map(|g| *g).map_err(|e| e.to_string())
}

// ── System Audio Commands (ScreenCaptureKit) ──

#[tauri::command]
pub fn start_system_audio(state: State<'_, AppState>) -> Result<(), String> {
    let mut capture = state
        .system_audio
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;
    capture.start()
}

#[tauri::command]
pub fn stop_system_audio(state: State<'_, AppState>) -> Result<(), String> {
    let mut capture = state
        .system_audio
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;
    capture.stop()
}

#[tauri::command]
pub fn get_system_audio_chunk(state: State<'_, AppState>) -> Result<Vec<u8>, String> {
    let capture = state
        .system_audio
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;
    capture.take_audio_data()
}

#[tauri::command]
pub fn is_system_audio_capturing(state: State<'_, AppState>) -> Result<bool, String> {
    let capture = state
        .system_audio
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;
    Ok(capture.is_capturing())
}

#[tauri::command]
pub fn has_system_audio_chunk(state: State<'_, AppState>) -> Result<bool, String> {
    let capture = state
        .system_audio
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;
    capture.has_chunk()
}

#[tauri::command]
pub fn take_all_system_audio(state: State<'_, AppState>) -> Result<Vec<u8>, String> {
    let capture = state
        .system_audio
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;
    capture.take_all_audio()
}

/// Get the last `secs` seconds of audio as WAV (streaming mode).
#[tauri::command]
pub fn get_audio_window(state: State<'_, AppState>, secs: f32) -> Result<Vec<u8>, String> {
    let capture = state
        .system_audio
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;
    capture.get_window(secs)
}

/// Check if VAD detected a pause, consume the flag.
#[tauri::command]
pub fn take_audio_pause(state: State<'_, AppState>) -> Result<bool, String> {
    let capture = state
        .system_audio
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;
    capture.take_pause()
}

/// Get the next complete utterance from the VAD-driven utterance queue.
/// Returns empty Vec if no utterance is available yet.
/// Each utterance is a semantically complete speech segment (sentence/phrase)
/// encoded as 16kHz mono WAV.
#[tauri::command]
pub fn get_next_utterance(state: State<'_, AppState>) -> Result<Vec<u8>, String> {
    let capture = state
        .system_audio
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;
    capture.get_next_utterance()
}

/// Return the number of complete utterances waiting in the queue.
#[tauri::command]
pub fn get_utterance_count(state: State<'_, AppState>) -> Result<u32, String> {
    let capture = state
        .system_audio
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;
    capture.get_utterance_count()
}

// ── Speech Recognition Commands ──

#[tauri::command]
pub fn recognize_speech(
    state: State<'_, AppState>,
    audio_data: Vec<u8>,
    language: String,
) -> Result<RecognitionResult, String> {
    state
        .speech_recognizer
        .lock()
        .map_err(|e| e.to_string())?
        .recognize(&audio_data, &language)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn check_asr_availability(state: State<'_, AppState>) -> Result<bool, String> {
    state
        .speech_recognizer
        .lock()
        .map_err(|e| e.to_string())
        .map(|r| r.is_available())
}

// ── Speech Synthesis Commands ──

#[tauri::command]
pub fn synthesize_speech(
    state: State<'_, AppState>,
    text: String,
    language: String,
) -> Result<(), String> {
    state
        .speech_synthesizer
        .lock()
        .map_err(|e| e.to_string())?
        .speak(&text, &language)
        .map_err(|e| e.to_string())
}

// ── VAD Commands ──

#[tauri::command]
pub fn detect_voice_activity(
    state: State<'_, AppState>,
    audio_data: Vec<u8>,
) -> Result<bool, String> {
    state
        .vad
        .lock()
        .map_err(|e| e.to_string())
        .map(|mut v| v.process_audio(&audio_data))
}

// ── Audio Device Commands ──

#[derive(serde::Serialize)]
pub struct AudioDevice {
    pub name: String,
    pub is_default: bool,
}

#[tauri::command]
pub fn get_available_microphones() -> Result<Vec<AudioDevice>, String> {
    let host = cpal::default_host();
    let devices: Vec<AudioDevice> = host
        .input_devices()
        .map(|devices| {
            devices
                .filter_map(|d| {
                    Some(AudioDevice {
                        name: d.name().ok()?,
                        is_default: d.default_input_config().is_ok(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(devices)
}

// ── Shortcut Commands ──

#[tauri::command]
pub fn register_global_shortcut(shortcut: String) -> Result<(), String> {
    // Global shortcut registration is a stub — the actual OS-level hotkey
    // registration requires platform-specific APIs not yet implemented.
    // The frontend uses its own keyboard event handlers (via useKeyboardShortcut
    // hook) for in-app shortcuts as a workaround.
    let _ = shortcut;
    Ok(())
}

#[tauri::command]
pub fn unregister_global_shortcut(shortcut: String) -> Result<(), String> {
    let _ = shortcut;
    Ok(())
}
