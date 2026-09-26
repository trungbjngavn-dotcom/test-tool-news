// Vỏ app máy tính cho Tool News.
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

/// Nối một dòng vào file log. Lỗi ghi log thì bỏ qua — không đáng để chết app.
fn ghi_log(duong_dan: &std::path::Path, dong: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(duong_dan) {
        let _ = writeln!(f, "{dong}");
    }
}

/// Bỏ tiền tố đường dẫn dài của Windows.
///
/// Tauri trả về resource dưới dạng UNC mở rộng. Node không hiểu dạng này:
/// nó tách nhầm rồi báo `EISDIR: lstat 'C:'` và chết ngay khi khởi động.
/// Cắt tiền tố đi là chạy bình thường.
fn duong_dan_thuong(p: &std::path::Path) -> String {
    let s = p.to_string_lossy().to_string();
    // chuỗi raw của Rust không kết thúc bằng dấu gạch chéo được
    s.strip_prefix("\\\\?\\").map(str::to_string).unwrap_or(s)
}

/// Tìm chrome-headless-shell trong payload.
///
/// Đường dẫn có kèm số phiên bản (`win64-150.0.7871.24`) nên không viết cứng
/// được — quét một tầng để bản Chrome mới cũng tự nhận.
fn tim_chrome(payload: &std::path::Path) -> Option<std::path::PathBuf> {
    let goc = payload.join("chrome");
    let ten = if cfg!(windows) { "chrome-headless-shell.exe" } else { "chrome-headless-shell" };
    for muc in std::fs::read_dir(&goc).ok()? {
        let thu_muc = muc.ok()?.path();
        for con in std::fs::read_dir(&thu_muc).ok()? {
            let p = con.ok()?.path().join(ten);
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

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
                .args([duong_dan_thuong(
                    &payload.join("dist").join("web").join("server.js"),
                )])
                .current_dir(&payload)
                .env("VIDEO_STUDIO_DATA", duong_dan_thuong(&thu_muc_du_lieu))
                .env("PORT", PORT.to_string());

            // Chrome và ffmpeg đi kèm trong payload. Không trỏ vào đây thì app
            // đòi máy người dùng phải có sẵn ffmpeg (hầu như không ai có) và
            // phải tải 271 MB Chrome ở lần render đầu.
            let ext = if cfg!(windows) { ".exe" } else { "" };
            let lenh = match tim_chrome(&payload) {
                Some(p) => lenh.env("HYPERFRAMES_BROWSER_PATH", duong_dan_thuong(&p)),
                None => lenh,
            };
            let ff = payload.join("ffmpeg");
            let lenh = lenh
                .env("HYPERFRAMES_FFMPEG_PATH", duong_dan_thuong(&ff.join(format!("ffmpeg{ext}"))))
                .env("HYPERFRAMES_FFPROBE_PATH", duong_dan_thuong(&ff.join(format!("ffprobe{ext}"))));

            // Bản release ẩn console nên log phải ghi ra file, không thì có lỗi
            // cũng không biết đường nào mà lần.
            let file_log = thu_muc_du_lieu.join("server.log");
            ghi_log(&file_log, &format!("--- khởi động {:?} ---", std::time::SystemTime::now()));
            ghi_log(&file_log, &format!("payload: {}", payload.display()));

            let (mut rx, child) = match lenh.spawn() {
                Ok(v) => v,
                Err(e) => {
                    ghi_log(&file_log, &format!("KHÔNG chạy được sidecar: {e}"));
                    return Err(Box::new(e));
                }
            };
            app.state::<MayChu>().0.lock().unwrap().replace(child);

            let log_cho_luong = file_log.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(su_kien) = rx.recv().await {
                    match su_kien {
                        CommandEvent::Stdout(d) | CommandEvent::Stderr(d) => {
                            ghi_log(&log_cho_luong, String::from_utf8_lossy(&d).trim_end());
                        }
                        CommandEvent::Terminated(t) => {
                            ghi_log(&log_cho_luong, &format!("server dừng, mã {:?}", t.code));
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
                if !cong_da_mo(PORT) {
                    ghi_log(&file_log, "hết giờ chờ: server không mở được cổng");
                }
                let url = format!("http://localhost:{PORT}")
                    .parse()
                    .expect("địa chỉ không hợp lệ");
                let ket_qua = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(url))
                    .title("Tool News")
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
