//! WhatsApp Web, in a window of its own.
//!
//! WhatsApp is one of the pages that refuses to be framed, so it cannot be drawn
//! in the island's panel. The smallest thing that still counts as embedded is a
//! normal Tauri window pointed at it; WebView2 keeps the profile, so the QR
//! login survives restarts.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const WA: &str = "https://web.whatsapp.com";

/// Brings the WhatsApp window up, or makes a new one if it was closed.
///
/// Async on purpose: on Windows, building a window from a synchronous command
/// deadlocks, and the window opens blank and never navigates.
#[tauri::command]
pub async fn whatsapp_open(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("whatsapp") {
        window
            .show()
            .map_err(|e| format!("could not show WhatsApp: {e}"))?;
        window
            .set_focus()
            .map_err(|e| format!("could not focus WhatsApp: {e}"))?;
        return Ok(());
    }

    let url: tauri::Url = WA.parse().map_err(|e| format!("whatsapp url: {e}"))?;
    WebviewWindowBuilder::new(&app, "whatsapp", WebviewUrl::External(url))
        .title("WhatsApp")
        .inner_size(1100.0, 760.0)
        .min_inner_size(480.0, 420.0)
        .center()
        .build()
        .map_err(|e| format!("could not open WhatsApp: {e}"))?;
    Ok(())
}
