/**
 * E：providers.streamFrom 載入樹隔離＋呼叫 guard（契約）。
 * - 真載入 ./providers 與 ./e2e-isolation（禁止 mock 二者）
 * - 整模 mock：./oauth ./sources ./web-research ./research-v2
 *   （與 providers 同目錄相對字面；命中依 resolve 後 URL／路徑，非猜副檔名）
 * - mock API：僅 namedExports（Node v24.13.0 文件／實作）
 * - fetch 自檢≠ module mock 安全門檻
 * - loadStubHits／callStubHits＝各階段 stub 函式呼叫數，≠模組評估次數
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { E2EIsolationError } from "./e2e-isolation";
import type { ModelInfo } from "./models";
import type { ChatMessage } from "./providers";
import type { Candidate } from "./sources";

type HitMap = Record<string, number>;

function bump(map: HitMap, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

describe("e2e streamFrom isolation (E)", { concurrency: false }, () => {
  it("mock deps before import; sync guard on streamFrom", async () => {
    const hadFlag = Object.prototype.hasOwnProperty.call(process.env, "E2E_ISOLATION");
    const prevFlag = process.env.E2E_ISOLATION;
    const originalFetch = globalThis.fetch;

    const loadStubHits: HitMap = Object.create(null);
    const callStubHits: HitMap = Object.create(null);
    let phase: "load" | "call" = "load";
    let fetchLoadHits = 0;
    let fetchCallHits = 0;

    const stubFn = (key: string) => {
      return (..._args: unknown[]) => {
        bump(phase === "load" ? loadStubHits : callStubHits, key);
        throw new Error(`E_STUB_CALLED:${key}`);
      };
    };

    const mockCtxs: { restore: () => void }[] = [];
    const cleanupErrors: unknown[] = [];
    let testError: unknown;

    try {
      process.env.E2E_ISOLATION = "1";

      globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
        if (phase === "load") fetchLoadHits += 1;
        else fetchCallHits += 1;
        throw new Error("E_FETCH_SENTINEL");
      }) as typeof fetch;

      // 依賴替換：與 providers.ts 相同相對字面；解析鍵＝resolve 後 URL（須在 dynamic import 前）
      mockCtxs.push(
        mock.module("./oauth", {
          namedExports: {
            CHATGPT_OAUTH: Object.freeze({}),
            GEMINI_OAUTH: Object.freeze({}),
            GROK_OAUTH: Object.freeze({}),
            bootstrapGeminiAccount: stubFn("oauth.bootstrapGeminiAccount"),
            chatGptWindowLabel: stubFn("oauth.chatGptWindowLabel"),
            fetchAntigravityAvailableModels: stubFn("oauth.fetchAntigravityAvailableModels"),
            grokProxyHeaders: stubFn("oauth.grokProxyHeaders"),
            pickChatGptPrimaryWindow: stubFn("oauth.pickChatGptPrimaryWindow"),
            refreshOAuthCredentials: stubFn("oauth.refreshOAuthCredentials"),
            resolveChatGptResetAt: stubFn("oauth.resolveChatGptResetAt"),
          },
        }),
      );

      mockCtxs.push(
        mock.module("./sources", {
          namedExports: {
            saveSourceQuota: stubFn("sources.saveSourceQuota"),
            saveUpdatedOAuthCreds: stubFn("sources.saveUpdatedOAuthCreds"),
            syncSourceQuotaById: stubFn("sources.syncSourceQuotaById"),
          },
        }),
      );

      mockCtxs.push(
        mock.module("./web-research", {
          namedExports: {
            buildContextualResearchQuery: stubFn("web-research.buildContextualResearchQuery"),
            formatResearchInjection: stubFn("web-research.formatResearchInjection"),
            runLiveResearch: stubFn("web-research.runLiveResearch"),
            shouldSkipLiveResearch: stubFn("web-research.shouldSkipLiveResearch"),
          },
        }),
      );

      mockCtxs.push(
        mock.module("./research-v2", {
          namedExports: {
            isResearchPipelineV2Enabled: () => {
              bump(phase === "load" ? loadStubHits : callStubHits, "research-v2.isResearchPipelineV2Enabled");
              return false;
            },
            reusePreparedResearch: () => {
              bump(phase === "load" ? loadStubHits : callStubHits, "research-v2.reusePreparedResearch");
              return null;
            },
            runResearchPipelineV2: stubFn("research-v2.runResearchPipelineV2"),
            verdictToLegacyBundle: stubFn("research-v2.verdictToLegacyBundle"),
          },
        }),
      );

      // fetch 哨兵可觸發（僅證明 fetch 防護接線；不是 module mock 安全門檻）
      let fetchSelfOk = false;
      try {
        await globalThis.fetch("http://127.0.0.1/e-fetch-self-check");
      } catch (e) {
        assert.ok(e instanceof Error);
        assert.equal(e.message, "E_FETCH_SENTINEL");
        assert.equal(fetchLoadHits, 1);
        fetchSelfOk = true;
      }
      assert.equal(fetchSelfOk, true, "fetch sentinel wiring check");
      fetchLoadHits = 0;

      let providers: typeof import("./providers");
      try {
        providers = await import("./providers");
      } catch (e) {
        assert.fail(`providers import failed (not isolation success): ${e instanceof Error ? e.stack : e}`);
      }

      assert.equal(fetchLoadHits, 0, "load-phase fetch hits must be 0 after self-check reset");
      assert.deepEqual(
        loadStubHits,
        Object.create(null),
        `load-phase stub call counts must be 0; got ${JSON.stringify(loadStubHits)}`,
      );

      phase = "call";

      const candidate: Candidate = {
        source: {
          id: "e2e-src",
          label: "e2e",
          kind: "platform",
          provider: "openai",
          authType: "api_key",
          keyHint: "e2e",
          priority: 0,
          monthlyCapPoints: null,
          shareLimitPct: 0,
          quota: null,
          quotaUpdatedAt: null,
          enabled: true,
          fromEnv: false,
          ownerUserId: null,
          removedAt: null,
        },
      };
      const model: ModelInfo = {
        id: "e2e-model",
        label: "e2e",
        provider: "openai",
        category: "chatgpt",
        quotaPool: "chatgpt",
        tier: "light",
        price: { input: 0, cachedInput: 0, output: 0 },
        openrouterId: "e2e/openrouter",
      };
      const messages: ChatMessage[] = [{ role: "user", content: "e2e-isolation-ping" }];

      assert.throws(
        () => {
          providers.streamFrom(candidate, model, messages, "e2e-safety-id");
        },
        (err: unknown) => {
          assert.ok(err instanceof E2EIsolationError, `expected E2EIsolationError, got ${err}`);
          assert.equal(err.name, "E2EIsolationError");
          assert.equal(err.surface, "providers.streamFrom");
          assert.equal(err.message, "E2E_ISOLATION blocked: providers.streamFrom");
          return true;
        },
      );

      assert.equal(fetchCallHits, 0, "call-phase fetch hits must be 0");
      assert.deepEqual(
        callStubHits,
        Object.create(null),
        `call-phase stub call counts must be 0 (guard before upstream); got ${JSON.stringify(callStubHits)}`,
      );
    } catch (e) {
      testError = e;
    } finally {
      for (const ctx of mockCtxs) {
        try {
          ctx.restore();
        } catch (e) {
          cleanupErrors.push(e);
        }
      }
      try {
        globalThis.fetch = originalFetch;
      } catch (e) {
        cleanupErrors.push(e);
      }
      try {
        if (!hadFlag) delete process.env.E2E_ISOLATION;
        else process.env.E2E_ISOLATION = prevFlag;
      } catch (e) {
        cleanupErrors.push(e);
      }
    }

    if (cleanupErrors.length > 0) {
      const detail = cleanupErrors
        .map((e) => (e instanceof Error ? e.stack ?? e.message : String(e)))
        .join("\n---\n");
      if (testError !== undefined) {
        const primary = testError instanceof Error ? testError.stack ?? testError.message : String(testError);
        assert.fail(`cleanup failed after test error.\nTest error:\n${primary}\nCleanup:\n${detail}`);
      }
      assert.fail(`cleanup failed:\n${detail}`);
    }
    if (testError !== undefined) {
      throw testError;
    }
  });
});
