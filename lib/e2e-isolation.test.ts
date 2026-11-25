import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import {
  E2EIsolationError,
  assertE2EOrPass,
  isE2EIsolationActive,
} from "@/lib/e2e-isolation";

/** 僅供同步 callback；finally 還原鍵（含原本不存在）。 */
function withEnvKey<T>(key: string, next: string | undefined, fn: () => T): T {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prev = process.env[key];
  try {
    if (next === undefined) delete process.env[key];
    else process.env[key] = next;
    return fn();
  } finally {
    if (!had) delete process.env[key];
    else process.env[key] = prev;
  }
}

const FIXED_CHILD_KEYS = [
  "E2E_ISOLATION",
  "HOSTNAME",
  "NODE_ENV",
  "NEXT_TELEMETRY_DISABLED",
] as const;

describe("e2e-isolation helper", { concurrency: false }, () => {
  it("inactive when flag missing or not exactly 1", () => {
    withEnvKey("E2E_ISOLATION", undefined, () => {
      assert.equal(isE2EIsolationActive(), false);
      assert.doesNotThrow(() => assertE2EOrPass("noop"));
    });
    withEnvKey("E2E_ISOLATION", "true", () => {
      assert.equal(isE2EIsolationActive(), false);
    });
  });

  it("throws E2EIsolationError when E2E_ISOLATION=1", () => {
    withEnvKey("E2E_ISOLATION", "1", () => {
      assert.throws(() => assertE2EOrPass("unit.surface"), (e: unknown) => {
        assert.ok(e instanceof E2EIsolationError);
        return true;
      });
    });
  });
});

/** 入口測試尚未驗證（skip；placeholder ≠ 通過）。 */
describe.skip("app entry fail-closed (deferred; not verified)", () => {
  it("placeholder", () => assert.ok(true));
});

describe("scripts/e2e-dev.mjs gate", { concurrency: false }, () => {
  const script = resolve(process.cwd(), "scripts/e2e-dev.mjs");

  function runGate(cwd: string, env: Record<string, string | undefined>) {
    const base: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      SystemRoot: process.env.SystemRoot ?? "",
      TEMP: process.env.TEMP ?? "",
      TMP: process.env.TMP ?? "",
    };
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined) base[k] = v;
    }
    return spawnSync(process.execPath, [script, "--check-only"], {
      cwd,
      env: base,
      encoding: "utf8",
    });
  }

  function withTempDir(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "e2e-gate-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("rejects when E2E_ISOLATION missing", () => {
    withTempDir((dir) => {
      const r = runGate(dir, {});
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /E2E_ISOLATION must be exactly 1/);
    });
  });

  it("rejects when .git name present", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, ".git"));
      const r = runGate(dir, { E2E_ISOLATION: "1" });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /\.git/);
    });
  });

  it("rejects .env* including development/test/example", () => {
    for (const name of [
      ".env.local",
      ".env.development",
      ".env.development.local",
      ".env.test",
      ".env.example",
    ]) {
      withTempDir((dir) => {
        writeFileSync(join(dir, name), "PLACEHOLDER=1\n", "utf8");
        const r = runGate(dir, { E2E_ISOLATION: "1" });
        assert.notEqual(r.status, 0, name);
        assert.match(r.stderr, /forbidden env file present/);
      });
    }
  });

  it("rejects forbidden keys empty/whitespace/case-insensitive", () => {
    withTempDir((dir) => {
      assert.notEqual(runGate(dir, { E2E_ISOLATION: "1", DATABASE_URL: "" }).status, 0);
      assert.notEqual(runGate(dir, { E2E_ISOLATION: "1", POSTGRES_URL: "   " }).status, 0);
      assert.notEqual(runGate(dir, { E2E_ISOLATION: "1", database_url: "" }).status, 0);
    });
  });

  it("rejects illegal host/port on check-only without echoing host", () => {
    withTempDir((dir) => {
      const rHost = runGate(dir, { E2E_ISOLATION: "1", E2E_BIND_HOST: "evil.example" });
      assert.notEqual(rHost.status, 0);
      assert.match(rHost.stderr, /bind host must be loopback/);
      assert.doesNotMatch(rHost.stderr, /evil\.example/);
      assert.notEqual(runGate(dir, { E2E_ISOLATION: "1", E2E_PORT: "0" }).status, 0);
      assert.notEqual(runGate(dir, { E2E_ISOLATION: "1", E2E_PORT: "   " }).status, 0);
    });
  });

  it("passes --check-only on clean temp dir", () => {
    withTempDir((dir) => {
      const r = runGate(dir, { E2E_ISOLATION: "1" });
      assert.equal(r.status, 0, r.stderr);
    });
  });

  it("rejects junction/symlink inside copy (synthetic dirs only)", () => {
    const outer = mkdtempSync(join(tmpdir(), "e2e-junc-outer-"));
    const target = mkdtempSync(join(tmpdir(), "e2e-junc-target-"));
    const linkPath = join(outer, "linked");
    try {
      mkdirSync(join(target, ".git"));
      writeFileSync(join(target, ".env.local"), "PLACEHOLDER=1\n", "utf8");
      try {
        symlinkSync(target, linkPath, "junction");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`JUNCTION_CREATE_BLOCKED: ${msg}`);
        assert.fail("junction create blocked; do not count as pass");
      }
      const r = runGate(outer, { E2E_ISOLATION: "1" });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /symlink or junction/);
    } finally {
      try {
        rmSync(linkPath, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      rmSync(outer, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("rejects nextBin when missing or directory; spawn double must not run", () => {
    const harness = `
import { pathToFileURL } from 'node:url';
const script = ${JSON.stringify(script)};
const mod = await import(pathToFileURL(script).href);
const spawnDouble = () => {
  console.error('SPAWN_CALLED_SENTINEL');
  process.exit(2);
};
mod.runCli(['node', script], {
  PATH: process.env.PATH || '',
  SystemRoot: process.env.SystemRoot || '',
  TEMP: process.env.TEMP || '',
  TMP: process.env.TMP || '',
  E2E_ISOLATION: '1',
}, spawnDouble);
`;
    withTempDir((dir) => {
      // missing nextBin
      const rMiss = spawnSync(process.execPath, ["--input-type=module", "-e", harness], {
        cwd: dir,
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot ?? "",
          TEMP: process.env.TEMP ?? "",
          TMP: process.env.TMP ?? "",
          E2E_ISOLATION: "1",
        },
        encoding: "utf8",
      });
      assert.notEqual(rMiss.status, 0);
      assert.doesNotMatch(rMiss.stderr + rMiss.stdout, /SPAWN_CALLED_SENTINEL/);
      assert.match(rMiss.stderr, /next binary/);

      // nextBin is a directory
      const nextDir = join(dir, "node_modules", "next", "dist", "bin", "next");
      mkdirSync(nextDir, { recursive: true });
      const rDir = spawnSync(process.execPath, ["--input-type=module", "-e", harness], {
        cwd: dir,
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot ?? "",
          TEMP: process.env.TEMP ?? "",
          TMP: process.env.TMP ?? "",
          E2E_ISOLATION: "1",
        },
        encoding: "utf8",
      });
      assert.notEqual(rDir.status, 0);
      assert.doesNotMatch(rDir.stderr + rDir.stdout, /SPAWN_CALLED_SENTINEL/);
      assert.match(rDir.stderr, /regular file/);
    });
  });

  it("buildChildEnv exact key set + lowercase path input + spawn argv capture", async () => {
    const mod = await import(pathToFileURL(script).href);
    const host = "127.0.0.1";
    const sysLower = {
      path: "C:\\Windows\\system32",
      systemroot: "C:\\Windows",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
    };
    const childEnv = mod.buildChildEnv(host, {
      ...sysLower,
      NODE_OPTIONS: "--inspect",
      HTTP_PROXY: "http://proxy.invalid",
      E2E_SENTINEL_SHOULD_NOT_PASS: "1",
    });
    const expectedKeys = new Set([
      "PATH",
      "SystemRoot",
      "TEMP",
      "TMP",
      ...FIXED_CHILD_KEYS,
    ]);
    assert.deepEqual(new Set(Object.keys(childEnv)), expectedKeys);
    assert.equal(childEnv.PATH, sysLower.path);
    assert.equal(childEnv.SystemRoot, sysLower.systemroot);
    assert.equal(childEnv.TEMP, sysLower.TEMP);
    assert.equal(childEnv.TMP, sysLower.TMP);
    assert.equal(childEnv.E2E_ISOLATION, "1");
    assert.equal(childEnv.HOSTNAME, host);
    assert.equal(childEnv.NODE_ENV, "development");
    assert.equal(childEnv.NEXT_TELEMETRY_DISABLED, "1");
    assert.equal(Object.keys(childEnv).includes("path"), false);
    assert.equal(Object.keys(childEnv).includes("systemroot"), false);

    let captured: {
      cmd?: string;
      args?: string[];
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    } = {};
    const fakeChild = { on() { return fakeChild; } };
    const spawnDouble = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
      captured = { cmd, args, cwd: opts.cwd, env: opts.env };
      return fakeChild;
    };

    withTempDir((dir) => {
      const prevCwd = process.cwd();
      try {
        process.chdir(dir);
        const nextBin = join(dir, "node_modules", "next", "dist", "bin", "next");
        mkdirSync(join(dir, "node_modules", "next", "dist", "bin"), { recursive: true });
        writeFileSync(nextBin, "// stub\n", "utf8");
        assert.equal(lstatSync(nextBin).isFile(), true);
        withEnvKey("E2E_ISOLATION", "1", () => {
          const result = mod.runCli(
            ["node", script],
            {
              PATH: "C:\\Windows\\system32",
              SystemRoot: "C:\\Windows",
              WINDIR: "C:\\Windows",
              TEMP: "C:\\Temp",
              TMP: "C:\\Temp",
              E2E_ISOLATION: "1",
              E2E_PORT: "3456",
              NODE_OPTIONS: "--inspect",
              HTTP_PROXY: "http://proxy.invalid",
            },
            spawnDouble,
          );
          assert.equal(result.checkOnly, false);
          assert.equal(captured.cmd, process.execPath);
          assert.deepEqual(captured.args, [nextBin, "dev", "-H", "127.0.0.1", "-p", "3456"]);
          assert.equal(captured.cwd, dir);
          const envKeys = new Set(Object.keys(captured.env ?? {}));
          const expectSpawn = new Set([
            "PATH",
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            ...FIXED_CHILD_KEYS,
          ]);
          assert.deepEqual(envKeys, expectSpawn);
          assert.equal(captured.env!.PATH, "C:\\Windows\\system32");
          assert.equal(captured.env!.SystemRoot, "C:\\Windows");
          assert.equal(captured.env!.WINDIR, "C:\\Windows");
          assert.equal(captured.env!.TEMP, "C:\\Temp");
          assert.equal(captured.env!.TMP, "C:\\Temp");
          assert.equal(captured.env!.E2E_ISOLATION, "1");
          assert.equal(captured.env!.HOSTNAME, "127.0.0.1");
          assert.equal(captured.env!.NODE_ENV, "development");
          assert.equal(captured.env!.NEXT_TELEMETRY_DISABLED, "1");
          assert.equal(captured.env!.NODE_OPTIONS, undefined);
          assert.equal(captured.env!.HTTP_PROXY, undefined);
        });
      } finally {
        process.chdir(prevCwd);
      }
    });
  });
});
