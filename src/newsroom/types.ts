/**
 * Kiểu dữ liệu cho template "newsroom" — bản tin dọc 1080x1920:
 * nửa trên ảnh/video, nửa dưới panel navy chứa chữ + dòng nguồn.
 *
 * Khác với `src/render/script-schema.ts` (template gốc của repo) ở ba điểm
 * quan trọng, đều là yêu cầu thực tế:
 *   1. Media nhận ĐƯỜNG DẪN FILE TRONG MÁY, không bắt buộc URL.
 *   2. Media có thể là VIDEO, không chỉ ảnh.
 *   3. Không giới hạn 5–8 cảnh, không bắt cảnh đầu/cuối phải là hook/outro.
 */

import { z } from "zod";

/** Ảnh tĩnh (có Ken Burns) hoặc clip video chạy thật. */
export const MediaSchema = z.object({
  /** Đường dẫn tương đối so với thư mục dự án, ví dụ "assets/media/p1.jpg". */
  src: z.string().min(1),
  kind: z.enum(["image", "video"]),
  /** object-position, ví dụ "50% 30%" — chọn vùng giữ lại khi cắt về khung gần vuông. */
  position: z.string().default("50% 50%"),
  /** Chỉ dùng cho video: bắt đầu lấy từ giây thứ mấy của file nguồn. */
  mediaStartSec: z.number().min(0).default(0),
  /** Chỉ dùng cho video: có lấy tiếng gốc của clip không (mặc định không, để nghe voiceover). */
  useSourceAudio: z.boolean().default(false),
});
export type Media = z.infer<typeof MediaSchema>;

/** Một nhịp: một khối chữ + câu giọng đọc, gắn với một media. */
export const BeatSchema = z.object({
  id: z.string().min(1),
  /** Khoá tới `media` trong Project. Các beat LIỀN NHAU dùng chung một media
   *  sẽ gộp thành một cảnh để Ken Burns chạy liên tục, ảnh không reset. */
  mediaKey: z.string().min(1),
  kind: z.enum(["title", "beat"]).default("beat"),

  /** kind="beat": chữ hiện giữa panel navy. */
  text: z.string().default(""),

  /** kind="title": hộp ngày + headline nhiều dòng + badge. */
  date: z.string().default(""),
  headline: z.array(z.string()).default([]),

  /** Câu giọng đọc. Viết số ra chữ để TTS đọc đúng. */
  vo: z.string().min(1),

  // ── do pipeline ghi vào, không nhập tay ──
  voDurationSec: z.number().optional(),
  startSec: z.number().optional(),
  durationSec: z.number().optional(),
});
export type Beat = z.infer<typeof BeatSchema>;

export const OutroSchema = z.object({
  /** Clip video outro có sẵn (kèm nhạc hiệu). Bỏ trống = không có outro. */
  src: z.string().default(""),
  durationSec: z.number().min(0).default(0),
  startSec: z.number().optional(),
});

export const BrandSchema = z.object({
  /** Ảnh badge PNG trong suốt, dán ở đường giao hai nửa, chỉ hiện ở card mở đầu. */
  badgeSrc: z.string().default("assets/brand/badge.png"),
  badgeLeft: z.number().default(0),
  badgeTop: z.number().default(892),
  badgeWidth: z.number().default(600),
  badgeHeight: z.number().default(127),
  /** Màu nền panel + màu bản đồ chìm. */
  navy: z.string().default("#22356C"),
  mapColor: z.string().default("#2F4073"),
  sourceLabel: z.string().default("Nguồn : Tổng Hợp"),
});
export type Brand = z.infer<typeof BrandSchema>;

export const VoiceSchema = z.object({
  provider: z.enum(["edge-tts", "lucylab", "elevenlabs", "vbee"]).default("edge-tts"),
  voiceId: z.string().default("vi-VN-NamMinhNeural"),
  /** Định dạng edge-tts: "+0%", "+25%", "-10%". */
  rate: z.string().default("+0%"),
});

export const ProjectSchema = z.object({
  version: z.literal("1"),
  title: z.string().min(1),
  width: z.number().default(1080),
  height: z.number().default(1920),
  fps: z.number().default(30),

  // .prefault (không phải .default): Zod v4 bắt .default khớp kiểu ĐẦU RA,
  // mà kiểu đầu ra đã điền sẵn mọi field nên {} không hợp lệ.
  voice: VoiceSchema.prefault({}),
  brand: BrandSchema.prefault({}),
  outro: OutroSchema.prefault({}),

  /** Kho media dùng chung, khoá tuỳ ý ("p1", "anh-dien-gia"...). */
  media: z.record(z.string(), MediaSchema).default({}),
  beats: z.array(BeatSchema).min(1),

  /** Nhịp nghỉ (giây). */
  leadInSec: z.number().default(0.25),
  gapSec: z.number().default(0.16),
  titlePadSec: z.number().default(0.55),

  // ── do pipeline ghi vào ──
  shots: z
    .array(
      z.object({
        mediaKey: z.string(),
        startSec: z.number(),
        endSec: z.number(),
        durationSec: z.number(),
        beatIds: z.array(z.string()),
      }),
    )
    .optional(),
  totalSec: z.number().optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

/** Dự án rỗng để giao diện web bắt đầu. */
export function emptyProject(title = "Bản tin mới"): Project {
  return ProjectSchema.parse({
    version: "1",
    title,
    beats: [
      {
        id: "t0",
        mediaKey: "m1",
        kind: "title",
        date: "",
        headline: ["DÒNG TIÊU ĐỀ 1", "DÒNG TIÊU ĐỀ 2"],
        vo: "Câu giọng đọc cho card mở đầu.",
      },
    ],
  });
}
