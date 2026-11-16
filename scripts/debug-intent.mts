import {
  extractUserInstructionText,
  hasExplicitLiveDemand,
  isMetaNewsSystemsTalk,
  isSummarizeOrTranslateOnly,
} from "../lib/research-v2/instruction-text";
import { detectIntent } from "../lib/research-v2/planner";

const samples: Record<string, string> = {
  ft01: `請對齊架構並分析以下文件是否合理：

# Research V2 架構說明
平台已有 Research Pipeline，但 GPT／Claude 的新聞回答品質不如 Gemini 原生搜尋。
請分析 Gate、Collector、injection 與 provenance 設計。`,
  ft09: "我們在討論指令與架構，並沒有要查任何時事。請只回答流程問題。",
  ft11: "請幫我 refactor 這個 TypeScript research collector，不要上網。",
};

for (const [k, v] of Object.entries(samples)) {
  const instr = extractUserInstructionText(v);
  console.log("---", k);
  console.log("instr:", JSON.stringify(instr));
  console.log({
    live: hasExplicitLiveDemand(instr),
    meta: isMetaNewsSystemsTalk(instr),
    sum: isSummarizeOrTranslateOnly(instr),
    intent: detectIntent(v),
  });
}
