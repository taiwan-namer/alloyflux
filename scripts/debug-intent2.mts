import {
  extractUserInstructionText,
  isMetaNewsSystemsTalk,
  hasExplicitLiveDemand,
} from "../lib/research-v2/instruction-text";
import { detectIntent } from "../lib/research-v2/planner";

const samples = [
  "請整理 NVIDIA 過去 7 天最重要的 3 件新聞。每件新聞必須包含發布日期、來源網址與可核對的事實。若來源只有標題沒有正文，請明確標示。",
  "請整理 NVIDIA 最近 7 天最重要的 3 則新聞，附上發布日期、來源網址與可核對的事實。若來源只有標題沒有正文，請明確標示。",
  "川普關稅這則新聞來源是哪裡",
  "英超 fixture 怎麼排",
  "這則新聞來源是哪裡",
];
for (const s of samples) {
  const instr = extractUserInstructionText(s);
  console.log({
    s: s.slice(0, 72),
    instrLen: instr.length,
    instr: instr.slice(0, 100),
    live: hasExplicitLiveDemand(instr),
    meta: isMetaNewsSystemsTalk(instr),
    intent: detectIntent(s),
  });
}
