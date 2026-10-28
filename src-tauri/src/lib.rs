mod db;
mod http;
mod oauth;
mod ratelimit;
mod sys;

use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      let paths = sys::AppPaths::create(app.handle())?;
      app.manage(db::Db::new(paths.data_dir.clone(), paths.projects_dir.clone()));
      app.manage(paths);
      app.manage(http::Net::default());
      app.manage(sys::Llama::default());
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      db::db_query,
      db::db_exec,
      db::db_batch,
      db::db_delete_project,
      http::http_request,
      http::http_stream,
      http::http_download,
      http::set_network_config,
      oauth::oauth_login,
      oauth::oauth_cancel,
      oauth::oauth_ensure,
      oauth::oauth_status,
      oauth::oauth_logout,
      sys::secret_set,
      sys::secret_delete,
      sys::secret_exists,
      sys::llama_start,
      sys::llama_stop,
      sys::llama_status,
      sys::run_cli,
      sys::app_paths,
      sys::write_file,
      sys::read_file_text,
      sys::pdf_text,
      sys::open_login_window,
      sys::gpu_info,
      sys::extract_archive,
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      if let RunEvent::Exit = event {
        sys::stop_llama(&app.state());
      }
    });
}
