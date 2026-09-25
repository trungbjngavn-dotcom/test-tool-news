/**
 * Tính timeline từ độ dài giọng đọc THẬT (không phải số cố định),
 * rồi gộp các beat liền nhau dùng chung một media thành "shot".
 *
 * Gộp shot là chi tiết quan trọng: nếu mỗi beat là một cảnh riêng thì
 * Ken Burns sẽ reset khi text đổi, trong khi bản tin gốc giữ ảnh chạy
 * liên tục xuyên nhiều khối chữ.
 */

import type { Project } from "./types.js";

export interface Shot {
  mediaKey: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  beatIds: string[];
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Điền `startSec`/`durationSec` cho từng beat, dựng `shots`, đặt `outro.startSec`
 * và `totalSec`. Yêu cầu mọi beat đã có `voDurationSec` (đo từ file audio thật).
 */
export function computeTimeline(project: Project): Project {
  const missing = project.beats.filter((b) => typeof b.voDurationSec !== "number");
  if (missing.length > 0) {
    throw new Error(
      `Thiếu voDurationSec cho beat: ${missing.map((b) => b.id).join(", ")} — chạy TTS trước.`,
    );
  }

  let t = project.leadInSec;
  for (const b of project.beats) {
    const pad = b.kind === "title" ? project.titlePadSec : project.gapSec;
    b.startSec = round(t);
    b.durationSec = round((b.voDurationSec as number) + pad);
    t = round(t + b.durationSec);
  }

  const shots: Shot[] = [];
  let cur: Shot | null = null;
  for (const b of project.beats) {
    const end = round((b.startSec as number) + (b.durationSec as number));
    if (cur && cur.mediaKey === b.mediaKey) {
      cur.endSec = end;
      cur.beatIds.push(b.id);
    } else {
      cur = {
        mediaKey: b.mediaKey,
        startSec: b.startSec as number,
        endSec: end,
        durationSec: 0,
        beatIds: [b.id],
      };
      shots.push(cur);
    }
  }
  // shot đầu phủ luôn khoảng lặng mở đầu để không hở khung đen
  if (shots.length > 0) shots[0].startSec = 0;
  for (const s of shots) s.durationSec = round(s.endSec - s.startSec);

  project.shots = shots;
  project.outro.startSec = round(t);
  project.totalSec = round(t + project.outro.durationSec);
  return project;
}

/**
 * Ken Burns xoay vòng theo THỨ TỰ SHOT, không theo tên media — để cùng một ảnh
 * dùng lại ở shot khác vẫn có chuyển động khác, và không vỡ khi thêm media mới.
 */
export const KEN_BURNS: ReadonlyArray<{ from: number; to: number; xFrom: number; xTo: number }> = [
  { from: 1.06, to: 1.17, xFrom: 0, xTo: -16 },
  { from: 1.16, to: 1.06, xFrom: 14, xTo: -12 },
  { from: 1.07, to: 1.17, xFrom: -14, xTo: 12 },
  { from: 1.17, to: 1.07, xFrom: -10, xTo: 10 },
  { from: 1.06, to: 1.16, xFrom: 12, xTo: -14 },
];

export const kenBurnsFor = (shotIndex: number) => KEN_BURNS[shotIndex % KEN_BURNS.length];
