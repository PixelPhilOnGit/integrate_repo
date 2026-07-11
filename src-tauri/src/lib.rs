// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use chrono::{DateTime, NaiveDateTime, Utc, TimeZone};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn timestamp_to_date(timestamp: i64) -> Result<String, String> {
    match Utc.timestamp_opt(timestamp, 0) {
          chrono::LocalResult::Single(dt) => Ok(dt.format("%Y-%m-%d %H:%M:%S").to_string()),
          _ => Err("Invalid timestamp".into()),
    }
}

#[tauri::command]
fn date_to_timestamp(date_str: &str) -> Result<i64, String> {
    let fmt = "%Y-%m-%d %H:%M:%S";
    NaiveDateTime::parse_from_str(date_str, fmt)
        .map(|dt| dt.and_utc().timestamp())
        .map_err(|e| format!("Parse error: {}. Use format: 2024-01-15 08:30:00", e))
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, timestamp_to_date, date_to_timestamp])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
