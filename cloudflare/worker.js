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
      // ---------------------------------------------------------
      // 1. READ REQUEST
      // ---------------------------------------------------------

      const body = await request.json();

      const messages = Array.isArray(body?.messages)
        ? body.messages.slice(-12)
        : [];

      if (!messages.length) {
        return Response.json(
          {
            error: "messages is required"
          },
          {
            status: 400
          }
        );
      }

      // ---------------------------------------------------------
      // 2. GEMINI CONFIG
      // ---------------------------------------------------------

      const apiKey = env.GEMINI_API_KEY;

      if (!apiKey) {
        throw new Error(
          "GEMINI_API_KEY is not configured in Cloudflare Worker secrets."
        );
      }

      const model =
        (env.GEMINI_MODEL || "gemini-3.6-flash").trim();

      if (!model) {
        throw new Error("GEMINI_MODEL is empty.");
      }

      // ---------------------------------------------------------
      // 3. BUILD SYSTEM PROMPT
      // ---------------------------------------------------------

      // Pass the full structured knowledge object to the prompt.
      // prompt.js now handles source_policy whether it is a string or object.
      const promptKnowledge = {
        ...knowledge
      };

      const systemInstruction =
        buildSystemPrompt(promptKnowledge);

      if (
        !systemInstruction ||
        typeof systemInstruction !== "string"
      ) {
        throw new Error(
          "Toro system prompt could not be generated."
        );
      }

      // ---------------------------------------------------------
      // 4. BUILD GEMINI CONTENTS
      // ---------------------------------------------------------

      const contents = messages
        .filter(
          (message) =>
            message &&
            typeof message.content === "string" &&
            message.content.trim()
        )
        .map((message) => ({
          role:
            message.role === "model"
              ? "model"
              : "user",
          parts: [
            {
              text: message.content.trim()
            }
          ]
        }));

      if (!contents.length) {
        throw new Error(
          "No valid message content was provided."
        );
      }

      // Gemini chat history must end with the user's message.
      const lastMessage =
        contents[contents.length - 1];

      if (lastMessage.role !== "user") {
        throw new Error(
          "Invalid conversation state: final message must be from the user."
        );
      }

      // ---------------------------------------------------------
      // 5. GEMINI STREAMING REQUEST
      // ---------------------------------------------------------

      const geminiUrl =
        `https://generativelanguage.googleapis.com/v1beta/models/` +
        `${encodeURIComponent(model)}` +
        `:streamGenerateContent?alt=sse`;

      const response = await fetch(geminiUrl, {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "Accept": "text/event-stream",
          "x-goog-api-key": apiKey
        },

        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: systemInstruction
              }
            ]
          },

          contents,

          generationConfig: {
            thinkingConfig: {
              thinkingLevel: "minimal"
            }
          }
        })
      });

      // ---------------------------------------------------------
      // 6. HANDLE GEMINI HTTP ERRORS
      // ---------------------------------------------------------

      if (!response.ok) {
        const errorText =
          await response.text();

        let readableError = errorText;

        try {
          const parsed =
            JSON.parse(errorText);

          readableError =
            parsed?.error?.message ||
            parsed?.error?.status ||
            errorText;
        } catch {
          // Keep raw response text.
        }

        throw new Error(
          `Gemini HTTP ${response.status}: ${String(
            readableError || "Unknown Gemini error."
          ).slice(0, 1500)}`
        );
      }

      if (!response.body) {
        throw new Error(
          "Gemini returned no response stream."
        );
      }

      // ---------------------------------------------------------
      // 7. STREAM GEMINI → TORO
      // ---------------------------------------------------------

      const reader =
        response.body.getReader();

      const decoder =
        new TextDecoder();

      const encoder =
        new TextEncoder();

      const stream =
        new ReadableStream({
          async start(controller) {
            let buffer = "";
            let sentText = false;

            const send = (payload) => {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify(
                    payload
                  )}\n\n`
                )
              );
            };

            const processEvent = (event) => {
              const dataLines =
                event
                  .split(/\r?\n/)
                  .filter((line) =>
                    line.startsWith("data:")
                  )
                  .map((line) =>
                    line.slice(5).trim()
                  );

              if (!dataLines.length) {
                return;
              }

              const raw =
                dataLines.join("\n").trim();

              if (!raw || raw === "[DONE]") {
                return;
              }

              let parsed;

              try {
                parsed =
                  JSON.parse(raw);
              } catch {
                // Ignore non-JSON SSE frames.
                return;
              }

              if (parsed?.error) {
                throw new Error(
                  parsed.error.message ||
                    parsed.error.status ||
                    "Gemini stream error."
                );
              }

              if (
                parsed?.promptFeedback?.blockReason
              ) {
                throw new Error(
                  `Gemini blocked the request: ${parsed.promptFeedback.blockReason}`
                );
              }

              const candidate =
                parsed?.candidates?.[0];

              if (
                candidate?.finishReason &&
                candidate.finishReason !== "STOP" &&
                candidate.finishReason !== "MAX_TOKENS"
              ) {
                throw new Error(
                  `Gemini finished without a normal response: ${candidate.finishReason}`
                );
              }

              const parts =
                candidate?.content?.parts || [];

              for (const part of parts) {
                // Never expose Gemini internal thinking/reasoning text to UI.
                if (part?.thought === true) {
                  continue;
                }

                if (
                  part &&
                  typeof part.text === "string" &&
                  part.text
                ) {
                  sentText = true;

                  send({
                    type: "delta",
                    text: part.text
                  });
                }
              }
            };

            try {
              while (true) {
                const {
                  value,
                  done
                } = await reader.read();

                if (done) {
                  break;
                }

                buffer +=
                  decoder.decode(
                    value,
                    {
                      stream: true
                    }
                  );

                const events =
                  buffer.split(
                    /\r?\n\r?\n/
                  );

                buffer =
                  events.pop() || "";

                for (const event of events) {
                  processEvent(event);
                }
              }

              // Flush decoder remainder.
              buffer += decoder.decode();

              // Process final SSE event even if blank-line terminator is missing.
              if (buffer.trim()) {
                processEvent(buffer);
              }

              if (!sentText) {
                throw new Error(
                  "Gemini completed the request but returned no text response."
                );
              }

              send({
                type: "done"
              });

              controller.close();
            } catch (error) {
              send({
                type: "error",
                message:
                  error?.message ||
                  "Toro backend stream error."
              });

              controller.close();
            } finally {
              try {
                reader.releaseLock();
              } catch {
                // Ignore reader cleanup errors.
              }
            }
          }
        });

      // ---------------------------------------------------------
      // 8. RETURN SSE RESPONSE
      // ---------------------------------------------------------

      return new Response(stream, {
        status: 200,

        headers: {
          "Content-Type":
            "text/event-stream; charset=utf-8",

          "Cache-Control":
            "no-cache, no-transform",

          "X-Accel-Buffering":
            "no",

          "Connection":
            "keep-alive"
        }
      });
    } catch (error) {
      // ---------------------------------------------------------
      // 9. FINAL BACKEND ERROR
      // ---------------------------------------------------------

      const message =
        error?.message ||
        "Toro backend error.";

      return Response.json(
        {
          error: message
        },
        {
          status: 500,
          headers: {
            "Cache-Control":
              "no-store"
          }
        }
      );
    }
  }
};
