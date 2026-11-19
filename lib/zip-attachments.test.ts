import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { zipSync, strToU8 } from "fflate";
import {
  extractZipAttachmentText,
  isZipAttachment,
  MAX_ZIP_FILE_BYTES,
  ZIP_TEXT_FILE_RE,
} from "./zip-attachments";

function zipFile(name: string, files: Record<string, string | Uint8Array>): File {
  const encoded: Record<string, Uint8Array> = {};
  for (const [path, body] of Object.entries(files)) {
    encoded[path] = typeof body === "string" ? strToU8(body) : body;
  }
  const bytes = zipSync(encoded);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new File([copy], name, { type: "application/zip" });
}

describe("isZipAttachment", () => {
  it("認 .zip 副檔名與 MIME", () => {
    assert.equal(isZipAttachment(new File([], "a.zip")), true);
    assert.equal(isZipAttachment(new File([], "a.TXT")), false);
    assert.equal(
      isZipAttachment(new File([], "noext", { type: "application/zip" })),
      true,
    );
  });
});

describe("ZIP_TEXT_FILE_RE", () => {
  it("接受 .jsonl", () => {
    assert.equal(ZIP_TEXT_FILE_RE.test("events.jsonl"), true);
    assert.equal(ZIP_TEXT_FILE_RE.test("data/JSONL"), false);
    assert.equal(ZIP_TEXT_FILE_RE.test("logs/run.JSONL"), true);
  });
});

describe("extractZipAttachmentText", () => {
  it("合併文字檔並略過系統垃圾與二進位", async () => {
    const file = zipFile("demo.zip", {
      "readme.md": "# 你好\n這是說明",
      "src/app.ts": "export const x = 1;\n",
      "__MACOSX/._readme.md": "junk",
      ".DS_Store": "\0\0\0",
      "photo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
      "nested/dir/note.txt": "內層文字",
    });
    const result = await extractZipAttachmentText(file, 15_000);
    assert.ok(result.fileCount >= 3);
    assert.match(result.text, /readme\.md/);
    assert.match(result.text, /app\.ts/);
    assert.match(result.text, /note\.txt/);
    assert.doesNotMatch(result.text, /__MACOSX|DS_Store|photo\.png/);
  });

  it("阻擋路徑穿越與空壓縮檔", async () => {
    const empty = zipFile("empty.zip", {});
    // fflate zipSync with empty may still produce valid empty archive
    await assert.rejects(() => extractZipAttachmentText(empty, 1000), /空的|沒有可讀取/);

    const traversal = zipFile("bad.zip", {
      "../secret.txt": "should not appear",
      "ok.txt": "safe",
    });
    const result = await extractZipAttachmentText(traversal, 5000);
    assert.match(result.text, /ok\.txt/);
    assert.doesNotMatch(result.text, /secret/);
  });

  it("超過壓縮檔大小上限會拒絕", async () => {
    const huge = new File([new Uint8Array(MAX_ZIP_FILE_BYTES + 1)], "big.zip", {
      type: "application/zip",
    });
    await assert.rejects(() => extractZipAttachmentText(huge, 1000), /超過/);
  });
});
