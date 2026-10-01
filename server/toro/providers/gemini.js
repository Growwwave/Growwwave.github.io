function buildContents(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter(m => m && typeof m.content === "string" && m.content.trim())
    .map(m => ({
      role: m.role === "model" ? "model" : "user",
      parts: [{ text: m.content }]
    }));
}

async function streamGemini({ messages, systemInstruction, onText }) {
  const key = process.env.GEMINI_API_KEY;

  if (!key) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
    `:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;

  const body = {
    systemInstruction: {
      parts: [{ text: systemInstruction }]
    },
    contents: buildContents(messages),
    generationConfig: {
      temperature: 0.35,
      maxOutputTokens: 1200
    }
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const err = await response.text();

    throw new Error(
      `Gemini HTTP ${response.status}: ${err.slice(0, 800)}`
    );
  }

  if (!response.body) {
    throw new Error("Gemini returned no stream");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();

    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || "";

    for (const event of events) {
      const dataLines = event
        .split(/\r?\n/)
        .filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trim());

      if (!dataLines.length) continue;

      const raw = dataLines.join("\n");

      if (!raw || raw === "[DONE]") continue;

      let parsed;

      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }

      const parts =
        parsed?.candidates?.[0]?.content?.parts || [];

      for (const part of parts) {
        if (
          part &&
          typeof part.text === "string" &&
          part.text
        ) {
          await onText(part.text);
        }
      }
    }
  }
}

module.exports = { streamGemini };
