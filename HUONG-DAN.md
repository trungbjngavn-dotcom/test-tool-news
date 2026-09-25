# Video Studio — tạo bản tin dọc từ text + ảnh/video trong máy

Web app chạy ngay trên máy bạn. Bạn gõ (hoặc dán) nội dung, chọn ảnh/video có sẵn
trong máy, bấm một nút và nhận về file MP4 dọc 1080×1920 đúng kiểu bản tin:
nửa trên là hình, nửa dưới là panel navy có chữ + logo, cuối video ghép outro.

> Phần này là bản dựng mới nằm trong `src/newsroom/` và `src/web/`.
> Pipeline cũ của repo gốc (`src/pipeline.ts`, `rerender.ts`) vẫn còn nguyên, không đụng tới.

---

## 1. Chạy lên

```bash
npm run web
```

Mở trình duyệt vào **http://localhost:5174**.

Cần sẵn trong máy: Node 20+, `ffmpeg` và `ffprobe` trong PATH, và kết nối mạng
(để sinh giọng đọc bằng edge-tts và để HyperFrames tải Chrome lần đầu).

---

## 2. Làm một video — 5 bước

| Bước | Ở đâu trong giao diện |
|------|------------------------|
| 1. Tạo dự án | Nút **+ Dự án mới** ở thanh trên (hoặc menu tên dự án) |
| 2. Cho nội dung vào | **Dán văn bản** ở cột giữa — dán cả bài, hệ thống tự cắt thành nhịp |
| 3. Chọn ảnh/video | Cột trái: kéo thả file vào, hoặc **Chọn file…**, hoặc **Duyệt thư mục máy…** |
| 4. Gán hình cho từng nhịp | Kéo ảnh từ thư viện thả vào ô hình của nhịp (bấm vào ô hình để đổi nhanh) |
| 5. Bấm **Tạo video** | Cột phải hiện tiến trình; xong thì có player + nút mở thư mục chứa file |

Mọi thay đổi **tự lưu** sau ~0,7 giây. Góc trên hiện "Đang lưu…" rồi "Đã lưu".

---

## 3. Các khái niệm

### Nhịp (beat)
Một nhịp = một khối chữ trên màn hình + một câu giọng đọc. Độ dài của nhịp do
**độ dài câu đọc quyết định** — không cần tự chỉnh thời gian.

Hai loại nhịp:
- **Card mở đầu** — hiện ngày + tiêu đề lớn + logo. Thường chỉ có một, đặt đầu tiên.
- **Khối chữ** — nhịp thường.

Mặc định ô "Giọng đọc" bị ẩn vì nó giống hệt chữ hiển thị. Bỏ tick
*"giọng đọc giống chữ hiển thị"* nếu muốn đọc khác với chữ — ví dụ chữ hiện
`26/9` nhưng đọc `hai mươi sáu tháng chín`.

### Cảnh (shot)
Các nhịp **liền nhau dùng chung một media** được gộp thành một cảnh: hình chạy
liên tục suốt cả cảnh, không giật lại khi chữ đổi. Nhịp nào bị gộp sẽ có nhãn
**↳ nối cảnh trên**.

### Ảnh vs video
- **Ảnh** — tự động Ken Burns (zoom + trôi chậm), mỗi cảnh một kiểu khác nhau.
- **Video** — chạy thật, luôn tắt tiếng. Đặt `mediaStartSec` trong `project.json`
  nếu muốn bắt đầu từ giữa clip.

### Độ phân giải ảnh
Nửa trên khung hình là 1080×1072 (gần vuông) và ảnh được phủ kín theo kiểu
`object-fit: cover`, cộng Ken Burns phóng sẵn 1,06 lần. Ảnh phải phóng quá
**1,6 lần** mới phủ kín thì bị đánh dấu chấm đỏ trong thư viện, và app hỏi lại
trước khi render.

Hay gặp nhất là kéo thẳng ảnh từ một trang web vào — trình duyệt chỉ đưa bản
hiển thị nhỏ (có khi chỉ 320×179). Hãy lưu ảnh gốc về máy rồi mới thả vào.

---

## 4. Giọng đọc

Dùng **edge-tts** (dịch vụ TTS của Microsoft Edge, miễn phí, không cần tài khoản).

Hai giọng tiếng Việt bản địa — Microsoft chỉ có đúng hai:

| Giọng | Mã |
|-------|-----|
| Nam Minh (nam) | `vi-VN-NamMinhNeural` |
| Hoài My (nữ) | `vi-VN-HoaiMyNeural` |

Độ đa dạng đến từ hai trục điều chỉnh:

- **Tốc độ** — chậm / hơi chậm / bình thường / hơi nhanh / nhanh kiểu bản tin
- **Cao độ** — trầm / hơi trầm / bình thường / hơi cao / cao

Tức 2 × 5 × 5 = 50 tổ hợp. (Edge còn nhóm giọng "Multilingual" đọc được tiếng
Việt nhưng pha âm sắc nước ngoài nên không đưa vào danh sách.)

Ô **Nghe thử** ở cột trái để thử nhanh; mỗi nhịp cũng có nút **Nghe thử** riêng.

### Cache giọng đọc

File nằm trong `projects/<id>/assets/vo/` và được đặt tên theo **chữ ký** gồm
nội dung câu + giọng + tốc độ + cao độ, ví dụ `b1-6d32dd5676.wav`. Nhờ vậy:

- sửa một câu → chỉ câu đó sinh lại, các câu khác dùng lại file cũ;
- đổi giọng, tốc độ hay cao độ → **mọi câu tự sinh lại**, không còn cảnh đổi
  giọng mà video vẫn đọc giọng cũ;
- file của những lần trước được dọn tự động.

---

## 5. Thương hiệu & outro

- **Dòng nguồn** — dòng chữ nghiêng nhỏ dưới mỗi khối chữ.
- **Logo** — PNG nền trong suốt, hiện trên card mở đầu. Kích thước tự đo khi tải lên.
- **Outro** — clip MP4 ghép vào cuối. Không có cũng được, video sẽ dừng ở nhịp cuối.

---

## 6. Lấy nội dung từ bài báo

Dán link vào ô **Lấy từ bài báo** → hệ thống đọc tiêu đề, ngày, các đoạn văn và
ảnh trong bài. Từ đó bạn có thể:
- chọn ảnh rồi **Tải ảnh đã chọn về thư viện**,
- bấm **Dùng tiêu đề làm card mở đầu**,
- bấm từng câu để thêm thành nhịp.

---

## 7. Xem trước

Nút **Xem trước** dựng lại dự án rồi mở HyperFrames Studio ở tab mới — xem được
timeline, tua tới lui, chỉnh trực tiếp. Bấm **Dừng xem trước** để tắt server nền đó.

Nếu clip nguồn là HEVC/H.265, Studio dùng bản proxy H.264 để phát; bản render vẫn
đọc thẳng file gốc nên không ảnh hưởng chất lượng.

---

## 8. File nằm ở đâu

```
projects/<id>/
├─ project.json              ← toàn bộ dự án (nhịp, media, giọng, thương hiệu)
├─ index.html                ← composition gốc (sinh ra, đừng sửa tay)
├─ compositions/scene-N.html ← mỗi cảnh một file
├─ assets/
│  ├─ media/                 ← ảnh/video đã copy vào dự án + thumbnail
│  ├─ vo/                    ← giọng đọc (.mp3 + .wav)
│  ├─ brand/badge.png        ← logo
│  ├─ outro/                 ← clip outro
│  └─ preview/               ← file nghe thử
└─ renders/                  ← MP4 thành phẩm
```

Nút **Mở thư mục chứa video** ở panel Kết quả mở thẳng File Explorer.

---

## 9. Dùng bằng dòng lệnh

Không cần giao diện:

```bash
npm run newsroom -- projects/ten-du-an/project.json --render
```

Bỏ `--render` thì chỉ dựng + kiểm tra, không encode.

---

## 10. Kiến trúc

```
Trình duyệt (src/web/public/)
        │  REST + Server-Sent Events
        ▼
Fastify :5174 (src/web/server.ts)
        │
        ├─ jobs.ts       hàng đợi một chỗ, log theo dòng qua SSE
        ├─ extract.ts    đọc bài báo bằng cheerio
        │
        └─ src/newsroom/
           ├─ types.ts        schema Zod của project.json
           ├─ pipeline.ts     sinh giọng → tính timeline → dựng → gọi hyperframes
           ├─ timeline.ts     độ dài nhịp, gộp cảnh, tham số Ken Burns
           ├─ composer.ts     xuất HTML cho HyperFrames
           └─ media-probe.ts  ffprobe, thumbnail, chuẩn hoá ảnh
```

Vì sao phải có server chứ không chạy hẳn trong trình duyệt: render cần Node,
FFmpeg và Chrome headless — trình duyệt không làm được.

Render nặng nên **chỉ chạy một job tại một thời điểm**; job sau xếp hàng chờ.

---

## 11. Gặp lỗi

| Hiện tượng | Xử lý |
|------------|-------|
| `NoAudioReceived` khi sinh giọng | edge-tts thỉnh thoảng chập; code đã tự thử lại, chạy lại là xong |
| `check_runtime_failure … timed out` | Lỗi chập chờn của HyperFrames; server tự thử lại một lần |
| Video bị đứng hình trong bản render | Mỗi `<video>` phải có `id`. Composer đã tự gắn — nếu sửa tay composition thì nhớ giữ |
| Cổng 5174 đang bận | `Get-NetTCPConnection -LocalPort 5174 \| Stop-Process` (PowerShell) |
| Cảnh báo "sparse keyframes" | Clip nguồn ít keyframe. Vẫn render đúng, chỉ chậm hơn; muốn nhanh thì re-encode `-g 30` |

---

## 12. Đã kiểm chứng

- Render qua web API: 1080×1920, 30fps, h264 + aac.
- Dự án 4 nhịp trộn **ảnh (Ken Burns) + video thật**: lint 0 lỗi, contrast 11/11 AA,
  layout 0 vấn đề, ra 23,5s / 17,5 MB trong 44 giây.
- Đã đối chiếu vùng hình giữa các khung 7s → 11,5s: khác nhau 400–650 nghìn pixel,
  tức video chạy thật chứ không đóng băng.
- Bộ test gốc của repo: 60/60 pass.
