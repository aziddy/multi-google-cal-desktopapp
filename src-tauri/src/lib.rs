// SPDX-License-Identifier: AGPL-3.0-only
mod google;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(google::setup)
        .invoke_handler(tauri::generate_handler![
            google::google_snapshot,
            google::google_import_client,
            google::google_connect,
            google::google_cancel_connect,
            google::google_disconnect,
            google::google_sync,
            google::google_refresh_accounts,
            google::google_retry_credentials,
            google::google_open_event,
            google::writes::google_mutate,
            google::writes::google_series,
            google::writes::google_recover_pending,
            google::writes::google_retry_pending,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Multi Calendar");
}
