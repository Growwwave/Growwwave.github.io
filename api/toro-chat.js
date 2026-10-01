const { getKnowledge } = require("../server/toro/knowledge");
const { getProvider } = require("../server/toro/provider");
const { buildSystemPrompt } = require("../server/toro/server/toro/prompt");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return;
  }

  try {
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : (req.body || {});

    const messages = Array.isArray(body.messages)
      ? body.messages.slice(-12)
      : [];

    if (!messages.length) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "messages is required" }));
      return;
    }

    const knowledge = await getKnowledge();
    const provider = getProvider();
    const systemInstruction = buildSystemPrompt(knowledge);

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    if (res.flushHeaders) {
      res.flushHeaders();
    }

    const send = (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    await provider.streamGemini({
      messages,
      systemInstruction,
      onText: async (text) => {
        send({
          type: "delta",
          text
        });
      }
    });

    send({ type: "done" });
    res.end();
  } catch (error) {
    const message = error?.message || "Toro backend error";

    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: message }));
      return;
    }

    res.write(
      `data: ${JSON.stringify({
        type: "error",
        message
      })}\n\n`
    );

    res.end();
  }
};
