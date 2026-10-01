import knowledge from "../server/toro/growwwave-knowledge.json";
import { buildSystemPrompt } from "../server/toro/prompt.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Existing website assets
    if (url.pathname !== "/api/toro-chat") {
      return env.ASSETS.fetch(request);
    }

    // Toro API — POST only
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: {
          Allow: "POST"
        }
      });
    }

    try {
      const body = await request.json();

      const messages = Array.isArray(body?.messages)
        ? body.messages.slice(-12)
        : [];

      if (!messages.length) {
        return Response.json(
          { error: "messages is required" },
          { status: 400 }
        );
      }

      const apiKey = env.GEMINI_API_KEY;

      if (!apiKey) {
        throw new Error("GEMINI_API_KEY is not configured");
      }

      const model = env.GEMINI_MODEL || "gemini-3.6-flash";
      const systemInstruction = buildSystemPrompt(knowledge);

      const geminiUrl =
        `https://generativelanguage.googleapis.com/v1beta/models/` +
        `${encodeURIComponent(model)}:streamGenerateContent` +
        `?alt=sse&key=${encodeURIComponent(apiKey)}`;

      const contents = messages
        .filter(
          (m) =>
            m &&
            typeof m.content === "string" &&
            m.content.trim()
        )
        .map((m) => ({
          role: m.role === "model" ? "model" : "user",
          parts: [{ text: m.content }]
        }));

      const response = await fetch(geminiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemInstruction }]
          },
          contents,
          generationConfig: {
            temperature: 0.35,
            maxOutputTokens: 1200
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();

        throw new Error(
          `Gemini HTTP ${response.status}: ${errorText.slice(0, 800)}`
        );
      }

      if (!response.body) {
        throw new Error("Gemini returned no stream");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      const encoder = new TextEncoder();

      const stream = new ReadableStream({
        async start(controller) {
          const send = (payload) => {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify(payload)}\n\n`
              )
            );
          };

          let buffer = "";

          try {
            while (true) {
              const { value, done } = await reader.read();

              if (done) break;

              buffer += decoder.decode(value, {
                stream: true
              });

              const events = buffer.split(/\r?\n\r?\n/);
              buffer = events.pop() || "";

              for (const event of events) {
                const dataLines = event
                  .split(/\r?\n/)
                  .filter((line) => line.startsWith("data:"))
                  .map((line) => line.slice(5).trim());

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
                    send({
                      type: "delta",
                      text: part.text
                    });
                  }
                }
              }
            }

            send({ type: "done" });
            controller.close();
          } catch (error) {
            send({
              type: "error",
              message:
                error?.message || "Toro backend error"
            });

            controller.close();
          }
        }
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no"
        }
      });
    } catch (error) {
      const message =
        error?.message || "Toro backend error";

      return Response.json(
        { error: message },
        { status: 500 }
      );
    }
  }
};
