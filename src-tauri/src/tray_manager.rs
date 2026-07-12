use crate::error::AppResult;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Manages the system tray icon and menu.
pub struct TrayManager;

impl TrayManager {
    /// Initialize the system tray with menu items.
    pub fn init<R: Runtime>(app: &AppHandle<R>) -> AppResult<()> {
        let show = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)
            .map_err(|e| crate::error::AppError::Tray(e.to_string()))?;

        let conversation = MenuItem::with_id(
            app, "conversation", "Conversation Mode", true, None::<&str>,
        )
        .map_err(|e| crate::error::AppError::Tray(e.to_string()))?;

        let simultaneous = MenuItem::with_id(
            app, "simultaneous", "Simultaneous Mode", true, None::<&str>,
        )
        .map_err(|e| crate::error::AppError::Tray(e.to_string()))?;

        let separator = PredefinedMenuItem::separator(app)
            .map_err(|e| crate::error::AppError::Tray(e.to_string()))?;

        let quit = MenuItem::with_id(app, "quit", "Quit VoiceLingua", true, None::<&str>)
            .map_err(|e| crate::error::AppError::Tray(e.to_string()))?;

        let menu = Menu::with_items(
            app,
            &[&show, &conversation, &simultaneous, &separator, &quit],
        )
        .map_err(|e| crate::error::AppError::Tray(e.to_string()))?;

        let _tray = TrayIconBuilder::with_id("main-tray")
            .tooltip("VoiceLingua — Real-time Voice Translation")
            .menu(&menu)
            .menu_on_left_click(false)
            .on_menu_event(|app, event| {
                let id = event.id().as_ref();
                match id {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "conversation" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = app.emit("navigate", "conversation");
                    }
                    "simultaneous" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = app.emit("navigate", "simultaneous");
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                }
            })
            .on_tray_icon_event(|tray, event| {
                if let tauri::tray::TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    let app = tray.app_handle();
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            })
            .build(app)
            .map_err(|e| crate::error::AppError::Tray(e.to_string()))?;

        Ok(())
    }
}
