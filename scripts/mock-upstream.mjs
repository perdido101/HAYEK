// A tiny mock LLM upstream so the whole capture loop can be demonstrated
// locally without a paid provider. Speaks OpenAI Chat Completions and Anthropic
// Messages, streaming (chunk-by-chunk, with delays) and non-streaming.
import { createServer } from "node:http";

const PORT = process.env.MOCK_PORT ? Number(process.env.MOCK_PORT) : 8787;

// A capable model answers; a "weak" one hedges. Lets the comparison table show
// real disagreement (one PASS, one FAIL) instead of a uniform grid.
function wordsFor(model) {
  if (/weak|small|old|1b|mini/i.test(model || "")) return ["I'm", " not", " sure", " —", " maybe", " Lyon?"];
  return ["The", " capital", " of", " France", " is", " Paris."];
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

async function streamSSE(res, frames) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const f of frames) {
    res.write(f);
    await new Promise((r) => setTimeout(r, 40)); // visible token cadence
  }
  res.end();
}

function openaiChunks(words) {
  const id = "chatcmpl-mock";
  const frames = words.map(
    (w) =>
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "mock-gpt", choices: [{ index: 0, delta: { content: w } }] })}\n\n`,
  );
  frames.push(
    `data: ${JSON.stringify({ id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: words.length, total_tokens: 9 + words.length } })}\n\n`,
  );
  frames.push("data: [DONE]\n\n");
  return frames;
}

function anthropicFrames(words) {
  const WORDS = words;
  const f = [];
  f.push(
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_mock", model: "mock-claude", usage: { input_tokens: 11, output_tokens: 1 } } })}\n\n`,
  );
  f.push(
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
  );
  for (const w of WORDS) {
    f.push(
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: w } })}\n\n`,
    );
  }
  f.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
  f.push(
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: WORDS.length } })}\n\n`,
  );
  f.push(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
  return f;
}

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    const body = raw ? JSON.parse(raw) : {};
    const words = wordsFor(body.model);
    const text = words.join("");

    if (req.url?.startsWith("/v1/chat/completions")) {
      if (body.stream) return streamSSE(res, openaiChunks(words));
      return send(res, 200, { "content-type": "application/json" }, JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion",
        model: "mock-gpt",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 },
      }));
    }

    if (req.url?.startsWith("/v1/messages")) {
      if (body.stream) return streamSSE(res, anthropicFrames(words));
      return send(res, 200, { "content-type": "application/json" }, JSON.stringify({
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model: "mock-claude",
        content: [{ type: "text", text }],
        usage: { input_tokens: 11, output_tokens: 6 },
      }));
    }

    send(res, 404, { "content-type": "application/json" }, JSON.stringify({ error: "not found" }));
  });
});

server.listen(PORT, () => console.log(`mock upstream on http://127.0.0.1:${PORT}`));
