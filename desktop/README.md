# Video Studio — bản app máy tính (Tauri)

Đóng gói toàn bộ web app thành một ứng dụng Windows có cửa sổ riêng, icon riêng,
bộ cài `.exe`. Người dùng cuối **không cần cài Node, ffmpeg hay Chrome** — mọi
thứ nằm trong bộ cài.

---

## Cách hoạt động

Tauri không chạy được server Node bên trong WebView, nên app làm ba việc:

1. Bật server Fastify như **tiến trình con** (`node.exe` đi kèm + thư mục `payload`)
2. **Chờ cổng 5174 mở hẳn** rồi mới mở cửa sổ — không thì người dùng thấy trang trắng
3. Đóng cửa sổ thì **giết luôn tiến trình con**, không để chạy mồ côi

```
┌─ Video Studio.exe (vỏ Rust ~5 MB) ──────────────┐
│  cửa sổ WebView2  ──nạp──►  localhost:5174      │
│         │                        ▲               │
│         └── chạy ──► node.exe ───┘               │
│                      └─ payload/dist  (server)   │
│                      └─ payload/node_modules     │
└──────────────────────────────────────────────────┘
```

Dữ liệu người dùng **không** nằm cạnh file cài (thư mục đó chỉ-đọc) mà ở
`%APPDATA%\vn.videostudio.app\projects`, truyền vào server qua biến
`VIDEO_STUDIO_DATA`.

---

## Cần cài gì để BUILD (chỉ máy của bạn, không phải máy người dùng)

| Thứ | Cách cài | Dung lượng |
|-----|----------|-----------|
| Microsoft C++ Build Tools | [tải tại đây](https://visualstudio.microsoft.com/visual-cpp-build-tools/), chọn **"Desktop development with C++"** | ~3–6 GB |
| Rust | `winget install --id Rustlang.Rustup` rồi `rustup default stable-msvc` | ~1,5 GB |
| Tauri CLI | `npm i -D @tauri-apps/cli` | nhỏ |
| WebView2 | Windows 11 đã có sẵn | — |

---

## Lệnh

```bash
# gom phần Node (biên dịch TS, chép giao diện + asset, cài thư viện, chép node.exe)
npm run desktop:payload

# chạy thử có cửa sổ thật
npm run desktop:dev

# ra bộ cài .exe
npm run desktop:build
```

Bộ cài nằm ở `desktop/src-tauri/target/release/bundle/nsis/`.

---

## Dung lượng

Đo thật sau khi chạy `npm run desktop:payload`:

| Phần | Dung lượng |
|------|-----------|
| Thư viện Node (bản chạy, đã bỏ đồ phát triển) | 145 MB |
| `node.exe` đi kèm | 89 MB |
| Mã đã biên dịch + giao diện + asset | ~3 MB |
| Vỏ Tauri | ~5 MB |
| **Bộ cài (chưa gồm Chrome)** | **~240 MB** |

**Chrome headless 271 MB tải ở lần render đầu tiên**, cache vào
`%USERPROFILE%\.cache\puppeteer`. Muốn bộ cài chạy được ngay cả khi máy đích
không có mạng lúc đầu thì chép sẵn thư mục đó vào `payload/` và trỏ biến
`PUPPETEER_CACHE_DIR` — nhưng bộ cài sẽ thành ~510 MB.

---

## Vẫn cần mạng

Không tránh được: giọng đọc dùng **edge-tts**, gọi thẳng server Microsoft mỗi
lần sinh câu. Máy không mạng thì không tạo được video.

Ngoài ra lần render đầu còn tải font Montserrat (5 MB) từ Google Fonts rồi cache
lại — lần sau không cần nữa.

---

## Muốn build cho Mac/Linux

Phải build **trên chính hệ điều hành đó** (Tauri không build chéo). Ba thứ phải
đổi theo nền tảng: `node.exe` → `node`, Chrome headless bản tương ứng, và
`bundle.targets` trong `tauri.conf.json` (`dmg` cho macOS, `deb`/`appimage` cho
Linux). Phần mã nguồn đã xử lý sẵn khác biệt hệ điều hành (nút mở thư mục dùng
`explorer` / `open` / `xdg-open`).
