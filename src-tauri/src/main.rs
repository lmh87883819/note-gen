// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod fuzzy_search;
mod keywords;
mod window;
mod mcp;
mod device;

use fuzzy_search::{fuzzy_search, fuzzy_search_parallel};
use keywords::{rank_keywords};
use mcp::{start_mcp_stdio_server, stop_mcp_server, send_mcp_message, McpServerManager};
use device::get_device_id;

fn main() {
    tauri::Builder::default()
        // 核心插件 - 最先加载
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_single_instance::init(window::handle_single_instance))
        
        // MCP 服务器管理器
        .manage(McpServerManager::new())
        
        // 系统级插件
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        
        // UI 相关插件
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        
        // 注册命令处理器
        .invoke_handler(tauri::generate_handler![
            fuzzy_search,
            fuzzy_search_parallel,
            rank_keywords,
            start_mcp_stdio_server,
            stop_mcp_server,
            send_mcp_message,
            get_device_id,
        ])
        .setup(|app| {
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(false);
                }
            }
            Ok(())
        })
        
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app_handle, event| match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { has_visible_windows, .. } => {
                window::handle_macos_reopen(&_app_handle, has_visible_windows);
            }
            _ => {}
        });
}
