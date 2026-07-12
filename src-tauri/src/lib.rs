mod audio_capture;
mod audio_format;
mod commands;
mod error;
mod shortcut_manager;
mod speech_recognition;
mod speech_synthesis;
mod system_audio;
mod tray_manager;
mod vad;

use commands::AppState;
use tauri::Emitter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Initialize system tray
            let handle = app.handle().clone();
            if let Err(e) = tray_manager::TrayManager::init(&handle) {
                eprintln!("Failed to initialize system tray: {}", e);
            }

            // Emit app-ready event so frontend can initialize
            let _ = app.emit("app-ready", ());

            Ok(())
        })
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::start_recording,
            commands::stop_recording,
            commands::is_recording,
            commands::start_system_audio,
            commands::stop_system_audio,
            commands::get_system_audio_chunk,
            commands::has_system_audio_chunk,
            commands::take_all_system_audio,
            commands::get_audio_window,
            commands::take_audio_pause,
            commands::get_next_utterance,
            commands::get_utterance_count,
            commands::is_system_audio_capturing,
            commands::recognize_speech,
            commands::check_asr_availability,
            commands::synthesize_speech,
            commands::detect_voice_activity,
            commands::get_available_microphones,
            commands::register_global_shortcut,
            commands::unregister_global_shortcut,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
