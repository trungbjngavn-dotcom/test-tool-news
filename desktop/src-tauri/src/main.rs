// Vỏ app máy tính cho Video Studio.
//
// Tauri không chạy được server Node bên trong WebView, nên cách làm là:
//   1. bật server Fastify như một tiến trình con (sidecar node.exe + payload)
//   2. chờ cổng mở hẳn rồi mới nạp trang, tránh cửa sổ trắng "không kết nối được"
//   3. tắt app thì giết luôn tiến trình con, không để nó chạy mồ côi
//
// Dữ liệu người dùng để trong thư mục dữ liệu của app chứ không nằm cạnh file
// cài, vì thư mục cài thường chỉ-đọc.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const PORT: u16 = 5174;
/// Máy chậm, lần đầu Node phải nạp cả cây thư viện — cho rộng tay.
const KHOI_DONG_TOI_DA: Duration = Duration::from_secs(90);

/// Giữ tiến trình con để lúc thoát còn giết được.
struct MayChu(Arc<Mutex<Option<CommandChild>>>);

/// Server đã nghe cổng chưa. Thử mở TCP là cách chắc nhất.
fn cong_da_mo(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &([127, 0, 0, 1], port).into(),
        Duration::from_millis(300),
    )
    .is_ok()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(MayChu(Arc::new(Mutex::new(None))))
        .setup(|app| {
            let thu_muc_du_lieu = app
                .path()
                .app_data_dir()
                .expect("không lấy được thư mục dữ liệu của app");
            std::fs::create_dir_all(&thu_muc_du_lieu).ok();

            // payload/ nằm trong resource của bản cài
            let payload = app
                .path()
                .resolve("payload", tauri::path::BaseDirectory::Resource)
                .expect("không thấy thư mục payload");

            let lenh = app
                .shell()
                .sidecar("node")
                .expect("không thấy sidecar node")
                .args([payload
                    .join("dist")
                    .join("web")
                    .join("server.js")
                    .to_string_lossy()
                    .to_string()])
                .current_dir(payload)
                .env("VIDEO_STUDIO_DATA", thu_muc_du_lieu.to_string_lossy().to_string())
                .env("PORT", PORT.to_string());

            let (mut rx, child) = lenh.spawn().expect("không chạy được server Node");
            app.state::<MayChu>().0.lock().unwrap().replace(child);

            // in log của server ra console để còn gỡ lỗi khi chạy bản dev
            tauri::async_runtime::spawn(async move {
                while let Some(su_kien) = rx.recv().await {
                    match su_kien {
                        CommandEvent::Stdout(d) | CommandEvent::Stderr(d) => {
                            print!("[server] {}", String::from_utf8_lossy(&d));
                        }
                        CommandEvent::Terminated(t) => {
                            eprintln!("[server] đã dừng, mã {:?}", t.code);
                        }
                        _ => {}
                    }
                }
            });

            // Chờ ở luồng riêng rồi mới mở cửa sổ — nạp sớm quá là trang trắng.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let bat_dau = Instant::now();
                while bat_dau.elapsed() < KHOI_DONG_TOI_DA && !cong_da_mo(PORT) {
                    std::thread::sleep(Duration::from_millis(250));
                }
                let url = format!("http://localhost:{PORT}")
                    .parse()
                    .expect("địa chỉ không hợp lệ");
                let ket_qua = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(url))
                    .title("Video Studio")
                    .inner_size(1440.0, 940.0)
                    .min_inner_size(900.0, 600.0)
                    .center()
                    .build();
                if let Err(e) = ket_qua {
                    eprintln!("không mở được cửa sổ: {e}");
                }
            });

            Ok(())
        })
        .on_window_event(|window, su_kien| {
            if let tauri::WindowEvent::Destroyed = su_kien {
                // đóng cửa sổ là tắt server, không để tiến trình con sống tiếp
                if let Some(child) = window.state::<MayChu>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("không khởi động được Tauri");
}
