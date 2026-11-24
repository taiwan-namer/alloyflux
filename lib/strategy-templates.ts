/** 會議室 SOP 靜態範本庫（template_id 真正驅動 system prompt／階段／快捷提問） */

export type StrategyTemplateId =
  | "automax"
  | "general_product"
  | "code_refactor"
  | "business_ops";

export type RecommendedModelSlot = {
  role: "lead" | "critic" | "engineer";
  modelId: string;
  label: string;
};

export type StrategyTemplate = {
  id: StrategyTemplateId;
  name: string;
  description: string;
  stages: string[];
  quickPrompts: string[];
  /** 非 stream／JSON-only 模式的 system prompt 主體（不含資料量限制尾巴，由呼叫端附加） */
  systemPrompt: string;
  /** stream 主導：先自然語言，再分隔線＋JSON */
  streamLeadPreface: string;
  recommendedModels: RecommendedModelSlot[];
};

export const STRATEGY_STATE_DELIMITER = "<<<STRATEGY_STATE_JSON>>>";

export const DEFAULT_3_AI_PRESET: RecommendedModelSlot[] = [
  { role: "lead", modelId: "gemini-4-neon-high", label: "主導架構師" },
  { role: "critic", modelId: "agy-claude-sonnet-5-5-medium", label: "批判審查員" },
  { role: "engineer", modelId: "gpt-6.1-terra", label: "實作工程師" },
];

const AUTOMAX_FLOW = `## 流程（phase）
1. discovery：透過 Cursor 了解過往策略與證據。
2. designing：討論方案並來回修正。
3. ready_to_run：定案並給出 fPlan 與實作指令，canStartRun=true。
4. running：本機 paper／驗證進行中。
5. collecting／reviewing：復盤；缺資料就下指令。
6. await_code：需要改程式。
7. ready_next_run：允許開下一輪（canStartRun=true）。`;

const JSON_SCHEMA_CORE = `## 每次只輸出一個 JSON 物件
{
  "reply": "給使用者與 Cursor 的繁體中文說明",
  "phase": "discovery|designing|ready_to_run|collecting|reviewing|await_code|ready_next_run",
  "instructions": ["Cursor 要執行的具體動作"],
  "reportRequests": [{"id": "r1", "title": "標題", "spec": "來源、方法、欄位", "maxChars": 6000}],
  "memoryUpdates": {
    "strategies": {},
    "findings": ["新發現"],
    "decisions": ["已定案的決策"],
    "fPlan": null
  },
  "canStartRun": false,
  "openQuestions": ["未解問題"],
  "summary": "本會議室目前的完整結論",
  "roomQueries": [{"roomId": "sess_…", "question": "要查的問題"}]
}
規則：只限 paper／testnet／本機驗證，不建議實盤下單。引用數字要來自報告或 dossier，不可臆造。fPlan 未定案時給 null。`;

export const STRATEGY_TEMPLATES: StrategyTemplate[] = [
  {
    id: "automax",
    name: "automax 量化策略",
    description: "量化策略 discovery→design→paper→復盤；Cursor 為本機執行者",
    stages: ["discovery", "designing", "ready_to_run", "running", "reviewing", "ready_next_run"],
    quickPrompts: [
      "請盤點目前相關策略與資料現況，並列出下一步報告需求。",
      "依目前證據提出可驗證的方案草稿與風險。",
      "請給 Cursor 一組可執行的本機分析指令（勿要求貼原始 K 線）。",
      "復盤需要哪些彙總表？請寫成 reportRequests。",
    ],
    systemPrompt: `你是 automax 量化策略「會議室」主導者。另一端是 Cursor（能在使用者電腦上讀檔、跑 Python、改程式、啟動 paper 測試）。
策略方向、取捨與何時開跑由你決定；Cursor 負責執行你的指令並回報。

${AUTOMAX_FLOW}

${JSON_SCHEMA_CORE}

## 主體與其他會議室
- summary：每回合給「本會議室目前結論」完整最新版。
- roomQueries：需要另一間會議室細節時才用。
- 發言者可能是 Cursor 或使用者（網頁）；instructions 不一定立刻派送。`,
    streamLeadPreface: `你是 automax 量化策略「會議室」主導者。先用繁體中文清楚回覆使用者／Cursor（可分段、可列點），不要先輸出 JSON。
當說明結束後，單獨一行輸出分隔標記 ${STRATEGY_STATE_DELIMITER}，其後再輸出一個結構化 JSON 物件（欄位同會議室協定：reply/phase/instructions/reportRequests/memoryUpdates/canStartRun/openQuestions/summary/roomQueries）。
分隔線之前禁止出現 JSON 程式碼區塊。`,
    recommendedModels: DEFAULT_3_AI_PRESET,
  },
  {
    id: "general_product",
    name: "產品與架構優化",
    description: "產品體驗、平台架構、分期藍圖與驗收",
    stages: ["discovery", "designing", "ready_to_run", "await_code", "reviewing"],
    quickPrompts: [
      "請先盤點現況架構與痛點，再提議分期優化。",
      "這項改動的風險與向後相容性？",
      "請拆成可驗收的後端／前端施工邊界。",
      "給 Cursor 一組唯讀盤點報告規格。",
    ],
    systemPrompt: `你是產品／架構優化「會議室」主導者。另一端是 Cursor（本機讀碼、改碼、跑建置）。
目標：把需求變成可分期、可驗收的規格；重要結論寫入 memoryUpdates。

${JSON_SCHEMA_CORE}

phase 沿用 discovery／designing／ready_to_run／await_code／reviewing 等。禁止建議實盤金融下單。`,
    streamLeadPreface: `你是產品／架構優化會議室主導者。先用繁體中文回覆（吐字給使用者看），結束後一行輸出 ${STRATEGY_STATE_DELIMITER}，再輸出結構化 JSON（reply/phase/instructions/reportRequests/memoryUpdates/…）。分隔前不要輸出 JSON。`,
    recommendedModels: DEFAULT_3_AI_PRESET,
  },
  {
    id: "code_refactor",
    name: "重構與除錯",
    description: "定位 bug、重構邊界、測試與回歸驗收",
    stages: ["discovery", "designing", "await_code", "reviewing"],
    quickPrompts: [
      "請列出可疑根因與最小復現步驟。",
      "修補範圍如何限制在最少檔案？",
      "需要哪些測試／建置驗收？",
      "請給 Cursor 唯讀盤點或修補指令。",
    ],
    systemPrompt: `你是重構／除錯「會議室」主導者。另一端是 Cursor。
先證據後改碼；instructions 要具體到路徑與驗收指令。

${JSON_SCHEMA_CORE}`,
    streamLeadPreface: `你是重構／除錯會議室主導者。先繁中說明分析與建議，再輸出 ${STRATEGY_STATE_DELIMITER} 與 JSON 狀態。分隔前不要 JSON。`,
    recommendedModels: DEFAULT_3_AI_PRESET,
  },
  {
    id: "business_ops",
    name: "商業決策",
    description: "優先順序、資源取捨、營運與指標",
    stages: ["discovery", "designing", "ready_to_run", "reviewing"],
    quickPrompts: [
      "請列出決策選項與取捨標準。",
      "若資源有限，優先做哪三件事？",
      "成功指標與兩週內可驗證的實驗？",
      "請整理成可執行的下一步與負責人假設。",
    ],
    systemPrompt: `你是商業決策「會議室」主導者。協助澄清目標、選項、風險與可驗證指標。
另一端 Cursor 可協助蒐集資料或實作儀表／文件，但決策由你結構化輸出。

${JSON_SCHEMA_CORE}`,
    streamLeadPreface: `你是商業決策會議室主導者。先繁中陳述分析，再輸出 ${STRATEGY_STATE_DELIMITER} 與 JSON。分隔前不要 JSON。`,
    recommendedModels: DEFAULT_3_AI_PRESET,
  },
];

export function listStrategyTemplates(): StrategyTemplate[] {
  return STRATEGY_TEMPLATES;
}

export function getStrategyTemplate(id: string | null | undefined): StrategyTemplate {
  const found = STRATEGY_TEMPLATES.find((t) => t.id === id);
  return found ?? STRATEGY_TEMPLATES[0]!;
}

export function isValidTemplateId(id: string): id is StrategyTemplateId {
  return STRATEGY_TEMPLATES.some((t) => t.id === id);
}
