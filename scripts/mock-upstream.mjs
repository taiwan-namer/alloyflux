// Local stand-in for the OpenAI / Anthropic APIs so routing and failover can be tested without spending credits.
// Keys starting with "bad" fail auth, keys starting with "rate" return 429, anything else streams a canned answer.
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 4010);

function keyOf(req) {
  return req.headers["x-api-key"] ?? (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
}

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
}

createServer((req, res) => {
  const key = keyOf(req);
  console.log(`${req.method} ${req.url} key=${key.slice(0, 14)}`);
  if (key.startsWith("bad")) {
    res.writeHead(401, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "invalid api key" } }));
  }
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ data: [] }));
  }
  if (key.startsWith("rate")) {
    res.writeHead(429, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "rate limited" } }));
  }
  const tag = key.slice(0, 14);
  if (req.url.startsWith("/anthropic/")) {
    sse(res, [
      { type: "message_start", message: { usage: { input_tokens: 1200, cache_read_input_tokens: 0 } } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "你好，" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: `這是模擬回覆（由 ${tag} 回答）。` } },
      { type: "message_delta", usage: { output_tokens: 800 } },
      { type: "message_stop" },
    ]);
    return res.end();
  }
  sse(res, [
    { choices: [{ delta: { content: "你好，" } }] },
    { choices: [{ delta: { content: `這是模擬回覆（由 ${tag} 回答）。` } }] },
    { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 800, prompt_tokens_details: { cached_tokens: 200 } } },
  ]);
  res.write("data: [DONE]\n\n");
  res.end();
}).listen(PORT, "127.0.0.1", () => console.log(`mock upstream on http://127.0.0.1:${PORT}`));
