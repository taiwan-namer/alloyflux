const ID_RE = /[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+/;

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** 主持人寫進 JSON 的問句。太短、太長或重複的丟掉。 */
export function normalizeSuggestedAsks(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const text = String(item ?? "").replace(/\s+/g, " ").trim();
    if (text.length < 8 || text.length > 80) continue;
    if (out.includes(text)) continue;
    out.push(text);
    if (out.length >= 4) break;
  }
  return out;
}

/**
 * 還沒有主持人寫的問句時，用摘要裡的項目與缺口起草可送出的句子。
 * 不使用範本上的泛用盤點句。
 */
export function asksFromSummary(summary: string): string[] {
  const text = summary.replace(/\s+/g, " ").trim();
  if (text.length < 12) return [];
  const sentences = text.split(/。+/).map((s) => s.trim()).filter(Boolean);
  if (!sentences.length) return [];
  const asks: string[] = [];
  const push = (line: string) => {
    const next = clip(line, 72);
    if (next.length < 8 || asks.includes(next)) return;
    asks.push(next);
  };
  const current =
    [...sentences].reverse().find((s) => /開始|下一步|尚未|還沒|未完成|缺口/.test(s)) ??
    sentences[sentences.length - 1]!;
  const currentId = current.match(ID_RE)?.[0];
  push(
    currentId
      ? `現在卡在${currentId}。依摘要，下一步最小可驗收的事是什麼？`
      : `依摘要，下一步只做「${clip(current.split(/[：；]/)[0] ?? current, 18)}」，不要重做已結案項目。`,
  );
  const gap = sentences.find((s) => /not_|null|0\s*命中|不可|無法|缺口|未通過|不能宣稱|不代表/.test(s));
  if (gap) {
    const bit = clip(gap.split(/[，,；]/)[0] ?? gap, 22);
    push(`摘要的缺口是「${bit}」。要補哪項證據才算查證完成？`);
  }
  const accepted = sentences.find((s) => s !== current && ID_RE.test(s) && /接受|已驗|完成/.test(s));
  const acceptedId = accepted?.match(ID_RE)?.[0];
  if (acceptedId && acceptedId !== currentId) {
    push(`${acceptedId}已寫進摘要。哪些可以確認，哪些仍不能宣稱？`);
  }
  return asks.slice(0, 4);
}
