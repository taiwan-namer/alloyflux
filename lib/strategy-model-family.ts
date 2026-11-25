import type { StrategyModelOption } from "@/components/strategy-types";

/** 會議室 4C：UI 只暴露 low／medium／high（xhigh 不進選單） */
export type EffortPick = "low" | "medium" | "high";

export type ModelFamilyOption = {
  familyId: string;
  familyLabel: string;
  categoryLabel: string;
  available: boolean;
  note?: string;
  /** 可勾選的強度（不含 xhigh） */
  efforts: EffortPick[];
  byEffort: Partial<Record<EffortPick, StrategyModelOption>>;
  /** 無強度尾綴的單一模型 */
  singleton?: StrategyModelOption;
};

export function stripEffortSuffix(id: string): string {
  return id.replace(/-(low|medium|high|xhigh)$/i, "");
}

export function familyIdOf(opt: StrategyModelOption): string {
  return (opt.familyId || stripEffortSuffix(opt.id)).trim() || opt.id;
}

export function effortOf(opt: StrategyModelOption): EffortPick | "xhigh" | null {
  const raw = (opt.effort || "").toLowerCase();
  if (raw === "low" || raw === "medium" || raw === "high" || raw === "xhigh") return raw;
  const m = opt.id.match(/-(low|medium|high|xhigh)$/i);
  return m ? (m[1].toLowerCase() as EffortPick | "xhigh") : null;
}

/** 顯示／勾選用：xhigh 視同 High（選單不暴露 Extra High） */
export function uiEffortOf(opt: StrategyModelOption | undefined, modelId: string): EffortPick | null {
  if (opt) {
    const e = effortOf(opt);
    if (e === "xhigh") return "high";
    if (e === "low" || e === "medium" || e === "high") return e;
  }
  const m = modelId.match(/-(low|medium|high|xhigh)$/i);
  if (!m) return null;
  const e = m[1].toLowerCase();
  return e === "xhigh" ? "high" : (e as EffortPick);
}

export function buildModelFamilies(models: StrategyModelOption[]): ModelFamilyOption[] {
  const order: string[] = [];
  const map = new Map<string, ModelFamilyOption>();

  for (const opt of models) {
    const e = effortOf(opt);
    if (e === "xhigh") continue; // 不進選單
    const familyId = familyIdOf(opt);
    let fam = map.get(familyId);
    if (!fam) {
      const baseLabel =
        opt.familyLabel?.trim() ||
        opt.label.replace(/\s*·\s*(Low|Medium|High|Extra High)\s*/gi, "").trim() ||
        familyId;
      fam = {
        familyId,
        familyLabel: baseLabel,
        categoryLabel: opt.categoryLabel?.trim() || "其他",
        available: false,
        note: undefined,
        efforts: [],
        byEffort: {},
      };
      map.set(familyId, fam);
      order.push(familyId);
    }
    if (e === "low" || e === "medium" || e === "high") {
      if (!fam.byEffort[e]) {
        fam.byEffort[e] = opt;
        fam.efforts.push(e);
      } else if (opt.available && !fam.byEffort[e]!.available) {
        fam.byEffort[e] = opt;
      }
    } else if (!fam.singleton || (opt.available && !fam.singleton.available)) {
      fam.singleton = opt;
    }
    if (opt.available) fam.available = true;
    if (!fam.available && opt.note?.trim()) fam.note = opt.note.trim();
  }

  const rank: Record<EffortPick, number> = { low: 0, medium: 1, high: 2 };
  for (const fam of map.values()) {
    fam.efforts.sort((a, b) => rank[a] - rank[b]);
  }
  return order.map((id) => map.get(id)!);
}

export function preferredEffort(fam: ModelFamilyOption, want: EffortPick | null): EffortPick | null {
  if (fam.singleton && fam.efforts.length === 0) return null;
  if (want && fam.byEffort[want]) return want;
  for (const e of ["low", "medium", "high"] as EffortPick[]) {
    if (fam.byEffort[e]) return e;
  }
  return null;
}

/** 換家族或取消勾選時：預設 Low；無 Low 則退到最低可用強度 */
export function resolveFamilyModelId(fam: ModelFamilyOption, want: EffortPick | null): string {
  const e = preferredEffort(fam, want);
  if (e && fam.byEffort[e]) return fam.byEffort[e]!.id;
  if (fam.singleton) return fam.singleton.id;
  return fam.familyId;
}

export function familyOptionText(fam: ModelFamilyOption): string {
  if (fam.available) return fam.familyLabel;
  return `${fam.familyLabel}（${fam.note?.trim() || "暫不可用"}）`;
}

export function familyOptionTitle(fam: ModelFamilyOption): string {
  const sample = fam.byEffort.low || fam.byEffort.medium || fam.byEffort.high || fam.singleton;
  const parts = [fam.familyLabel];
  if (fam.categoryLabel) parts.push(fam.categoryLabel);
  if (!fam.available) parts.push(fam.note?.trim() || "暫不可用");
  else if (sample?.note?.trim()) parts.push(sample.note.trim());
  return parts.join("｜");
}
