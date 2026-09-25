/**
 * Danh mục giọng đọc edge-tts cho tiếng Việt.
 *
 * Microsoft chỉ có đúng HAI giọng tiếng Việt bản địa. Nhóm giọng "Multilingual"
 * cũng đọc được tiếng Việt nhưng còn pha âm sắc nước ngoài nên không đưa vào.
 * Độ đa dạng lấy từ hai trục tốc độ và cao độ bên dưới.
 */

export interface VoiceInfo {
  id: string;
  label: string;
  gender: "nam" | "nữ";
}

export const VOICES: VoiceInfo[] = [
  { id: "vi-VN-NamMinhNeural", label: "Nam Minh", gender: "nam" },
  { id: "vi-VN-HoaiMyNeural", label: "Hoài My", gender: "nữ" },
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

/** Cao độ — trục đa dạng chính vì chỉ có hai giọng bản địa. */
export const PITCHES = [
  { value: "-8Hz", label: "Trầm" },
  { value: "-4Hz", label: "Hơi trầm" },
  { value: "+0Hz", label: "Bình thường" },
  { value: "+4Hz", label: "Hơi cao" },
  { value: "+8Hz", label: "Cao" },
];
