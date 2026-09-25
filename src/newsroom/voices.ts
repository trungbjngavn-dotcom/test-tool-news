/**
 * Danh mục giọng đọc edge-tts dùng được cho tiếng Việt.
 *
 * Microsoft chỉ có đúng HAI giọng tiếng Việt bản địa. Ngoài ra còn nhóm giọng
 * "Multilingual" đọc xuyên ngôn ngữ — đã thử thật với một câu tiếng Việt, tất cả
 * đều ra audio dài tương đương giọng bản địa (4,6–5,7 giây cho cùng một câu),
 * nghĩa là chúng đọc chứ không đánh vần. Chất giọng thì có pha âm sắc nước ngoài
 * ở mức khác nhau, nên hãy bấm "Nghe thử" trước khi chốt.
 */

export interface VoiceInfo {
  id: string;
  label: string;
  gender: "nam" | "nữ";
  /** Nhóm để gom trong <optgroup>. */
  group: string;
  /** Giọng bản địa tiếng Việt hay giọng đa ngữ. */
  native: boolean;
}

export const VOICES: VoiceInfo[] = [
  // ── tiếng Việt bản địa ────────────────────────────────────────────────
  { id: "vi-VN-NamMinhNeural", label: "Nam Minh", gender: "nam", group: "Tiếng Việt bản địa", native: true },
  { id: "vi-VN-HoaiMyNeural", label: "Hoài My", gender: "nữ", group: "Tiếng Việt bản địa", native: true },

  // ── đa ngữ, đọc được tiếng Việt ───────────────────────────────────────
  { id: "en-US-AndrewMultilingualNeural", label: "Andrew", gender: "nam", group: "Đa ngữ (giọng hơi lai)", native: false },
  { id: "en-US-BrianMultilingualNeural", label: "Brian", gender: "nam", group: "Đa ngữ (giọng hơi lai)", native: false },
  { id: "en-US-AvaMultilingualNeural", label: "Ava", gender: "nữ", group: "Đa ngữ (giọng hơi lai)", native: false },
  { id: "en-US-EmmaMultilingualNeural", label: "Emma", gender: "nữ", group: "Đa ngữ (giọng hơi lai)", native: false },
  { id: "en-AU-WilliamMultilingualNeural", label: "William", gender: "nam", group: "Đa ngữ (giọng hơi lai)", native: false },
  { id: "ko-KR-HyunsuMultilingualNeural", label: "Hyunsu", gender: "nam", group: "Đa ngữ (giọng hơi lai)", native: false },
  { id: "it-IT-GiuseppeMultilingualNeural", label: "Giuseppe", gender: "nam", group: "Đa ngữ (giọng hơi lai)", native: false },
  { id: "de-DE-FlorianMultilingualNeural", label: "Florian", gender: "nam", group: "Đa ngữ (giọng hơi lai)", native: false },
  { id: "fr-FR-RemyMultilingualNeural", label: "Rémy", gender: "nam", group: "Đa ngữ (giọng hơi lai)", native: false },
  { id: "de-DE-SeraphinaMultilingualNeural", label: "Seraphina", gender: "nữ", group: "Đa ngữ (giọng hơi lai)", native: false },
  { id: "fr-FR-VivienneMultilingualNeural", label: "Vivienne", gender: "nữ", group: "Đa ngữ (giọng hơi lai)", native: false },
  { id: "pt-BR-ThalitaMultilingualNeural", label: "Thalita", gender: "nữ", group: "Đa ngữ (giọng hơi lai)", native: false },
];

export const VOICE_IDS = new Set(VOICES.map((v) => v.id));

/** Tốc độ đọc — giá trị đúng định dạng edge-tts. */
export const RATES = [
  { value: "-15%", label: "Chậm" },
  { value: "-7%", label: "Hơi chậm" },
  { value: "+0%", label: "Bình thường" },
  { value: "+12%", label: "Hơi nhanh" },
  { value: "+25%", label: "Nhanh (kiểu bản tin)" },
];

/** Cao độ — cách duy nhất để đa dạng thêm khi chỉ có hai giọng bản địa. */
export const PITCHES = [
  { value: "-8Hz", label: "Trầm" },
  { value: "-4Hz", label: "Hơi trầm" },
  { value: "+0Hz", label: "Bình thường" },
  { value: "+4Hz", label: "Hơi cao" },
  { value: "+8Hz", label: "Cao" },
];
