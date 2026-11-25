import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { E2EIsolationError } from "@/lib/e2e-isolation";

const FETCH_SENTINEL = "FETCH_SENTINEL";
const CLOUD_DB_PROXY_ERROR = "E2E_ISOLATION blocked: cloud-api.cloudDbProxy";

type FetchFn = typeof globalThis.fetch;

/**
 * A–C 入口 fail-closed（單一循序流程）。
 * 自檢失敗 → 不得動態載入 cloud-api。
 * 本檔施工後未執行（主持人另令測試）。
 */
describe("e2e-entry-isolation A–C", { concurrency: false }, () => {
  it("fetch sentinel self-check then A/B/C with zero fetch hits", async () => {
    const hadFlag = Object.prototype.hasOwnProperty.call(process.env, "E2E_ISOLATION");
    const prevFlag = process.env.E2E_ISOLATION;
    const originalFetch = globalThis.fetch;

    let fetchHits = 0;
    const sentinelFetch: FetchFn = ((..._args: Parameters<FetchFn>) => {
      fetchHits += 1;
      throw new Error(FETCH_SENTINEL);
    }) as FetchFn;

    let cloudApiLoaded = false;

    try {
      process.env.E2E_ISOLATION = "1";
      globalThis.fetch = sentinelFetch;

      // --- 純替身自檢（尚未載入 cloud-api）---
      fetchHits = 0;
      let selfOk = false;
      try {
        await globalThis.fetch("http://127.0.0.1/e2e-fetch-sentinel");
      } catch (e) {
        assert.ok(e instanceof Error);
        assert.equal(e.message, FETCH_SENTINEL);
        assert.equal(fetchHits, 1);
        selfOk = true;
      }
      assert.equal(selfOk, true, "fetch sentinel self-check must succeed before loading cloud-api");
      fetchHits = 0;

      // --- 自檢通過後才動態載入 ---
      assert.equal(globalThis.fetch, sentinelFetch);
      const cloudApi = await import("@/lib/cloud-api");
      cloudApiLoaded = true;
      const loadHits = fetchHits;
      assert.equal(loadHits, 0, "cloud-api load must not call fetch");
      assert.equal(globalThis.fetch, sentinelFetch, "fetch stub must remain installed after import");

      // --- A persistOAuthViaCloud ---
      {
        const before = fetchHits;
        await assert.rejects(
          () => cloudApi.persistOAuthViaCloud({ action: "e2e" }),
          (e: unknown) =>
            e instanceof E2EIsolationError && e.surface === "cloud-api.persistOAuthViaCloud",
        );
        assert.equal(fetchHits - before, 0, "A callHits must be 0");
      }

      // --- B proxyRequestToCloud ---
      {
        const before = fetchHits;
        await assert.rejects(
          () => cloudApi.proxyRequestToCloud(new Request("http://127.0.0.1/api/e2e")),
          (e: unknown) =>
            e instanceof E2EIsolationError && e.surface === "cloud-api.proxyRequestToCloud",
        );
        assert.equal(fetchHits - before, 0, "B callHits must be 0");
      }

      // --- C cloudDbProxy：503 + 精確 error ---
      {
        const before = fetchHits;
        const res = await cloudApi.cloudDbProxy(new Request("http://127.0.0.1/api/e2e"));
        assert.ok(res);
        assert.equal(res!.status, 503);
        const body = (await res!.json()) as { error?: string };
        assert.equal(body.error, CLOUD_DB_PROXY_ERROR);
        assert.equal(fetchHits - before, 0, "C callHits must be 0");
      }

      assert.equal(cloudApiLoaded, true);
    } finally {
      globalThis.fetch = originalFetch;
      if (!hadFlag) delete process.env.E2E_ISOLATION;
      else process.env.E2E_ISOLATION = prevFlag;
    }
  });
});
