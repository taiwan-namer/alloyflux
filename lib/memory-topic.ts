/** 主題重疊粗判：英文詞或中文 bigram 共享 ≥2 視為同主題（供記憶／語氣覆蓋） */
export function sameTopicLoose(a: string, b: string): boolean {
  const tok = (s: string): string[] => {
    const cleaned = s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
    if (!cleaned) return [];
    const out: string[] = [];
    for (const part of cleaned.split(/\s+/).filter(Boolean)) {
      if (/[\u4e00-\u9fff]/.test(part)) {
        if (part.length <= 2) {
          if (part.length >= 2) out.push(part);
          continue;
        }
        for (let i = 0; i < part.length - 1; i++) out.push(part.slice(i, i + 2));
      } else if (part.length >= 2) {
        out.push(part);
      }
    }
    return out;
  };
  const A = new Set(tok(a));
  if (!A.size) return a.toLowerCase() === b.toLowerCase();
  let hits = 0;
  for (const t of tok(b)) {
    if (A.has(t)) hits += 1;
    if (hits >= 2) return true;
  }
  return a.toLowerCase() === b.toLowerCase();
}
