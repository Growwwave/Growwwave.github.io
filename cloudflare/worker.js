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
        env.GEMINI_MODEL || "gemini-3.6-flash";

      // ---------------------------------------------------------
      // 3. BUILD SYSTEM PROMPT
      // ---------------------------------------------------------

      // Prevent source_policy object from becoming "[object Object]"
      const promptKnowledge = {
        ...knowledge
      };

      if (
        promptKnowledge.source_policy &&
        typeof promptKnowledge.source_policy === "object"
      ) {
        promptKnowledge.source_policy =
          JSON.stringify(
            promptKnowledge.source_policy,
            null,
            2
          );
      }

      const systemInstruction =
        buildSystemPrompt(promptKnowledge);

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
            maxOutputTokens: 1200
          }
        })
      });

      // ---------------------------------------------------------
      // 6. HANDLE GEMINI HTTP ERRORS
      // ---------------------------------------------------------

      if (!response.ok) {
        const errorText =
          await response.text();

        let readableError =
          errorText;

        try {
          const parsed =
            JSON.parse(errorText);

          readableError =
            parsed?.error?.message ||
            errorText;
        } catch {
          // Keep raw response
        }

        throw new Error(
          `Gemini HTTP ${response.status}: ${readableError.slice(
            0,
            1200
          )}`
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
            const send = (payload) => {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify(
                    payload
                  )}\n\n`
                )
              );
            };

            let buffer = "";

            try {
              while (true) {
                const {
                  value,
                  done
                } = await reader.read();

                if (done) {
                  break;
                }

                buffer += decoder.decode(
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
                  const dataLines =
                    event
                      .split(/\r?\n/)
                      .filter(
                        (line) =>
                          line.startsWith(
                            "data:"
                          )
                      )
                      .map(
                        (line) =>
                          line
                            .slice(5)
                            .trim()
                      );

                  if (
                    !dataLines.length
                  ) {
                    continue;
                  }

                  const raw =
                    dataLines.join("\n");

                  if (
                    !raw ||
                    raw === "[DONE]"
                  ) {
                    continue;
                  }

                  let parsed;

                  try {
                    parsed =
                      JSON.parse(raw);
                  } catch {
                    continue;
                  }

                  // Gemini may return an API-level error
                  if (parsed?.error) {
                    throw new Error(
                      parsed.error.message ||
                        "Gemini stream error."
                    );
                  }

                  const parts =
                    parsed
                      ?.candidates?.[0]
                      ?.content?.parts ||
                    [];

                  for (const part of parts) {
                    if (
                      part &&
                      typeof part.text ===
                        "string" &&
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

              // -------------------------------------------------
              // 8. PROCESS ANY FINAL BUFFERED SSE EVENT
              // -------------------------------------------------

              if (buffer.trim()) {
                const dataLines =
                  buffer
                    .split(/\r?\n/)
                    .filter(
                      (line) =>
                        line.startsWith(
                          "data:"
                        )
                    )
                    .map(
                      (line) =>
                        line
                          .slice(5)
                          .trim()
                    );

                if (dataLines.length) {
                  const raw =
                    dataLines.join("\n");

                  if (
                    raw &&
                    raw !== "[DONE]"
                  ) {
                    try {
                      const parsed =
                        JSON.parse(raw);

                      if (parsed?.error) {
                        throw new Error(
                          parsed.error.message ||
                            "Gemini stream error."
                        );
                      }

                      const parts =
                        parsed
                          ?.candidates?.[0]
                          ?.content?.parts ||
                        [];

                      for (const part of parts) {
                        if (
                          part &&
                          typeof part.text ===
                            "string" &&
                          part.text
                        ) {
                          send({
                            type: "delta",
                            text: part.text
                          });
                        }
                      }
                    } catch (error) {
                      if (
                        error?.message &&
                        !error.message.includes(
                          "Unexpected token"
                        )
                      ) {
                        throw error;
                      }
                    }
                  }
                }
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
            }
          }
        });

      // ---------------------------------------------------------
      // 9. RETURN SSE RESPONSE
      // ---------------------------------------------------------

      return new Response(stream, {
        status: 200,

        headers: {
          "Content-Type":
            "text/event-stream; charset=utf-8",

          "Cache-Control":
            "no-cache, no-transform",

          "X-Accel-Buffering":
            "no"
        }
      });
    } catch (error) {
      // ---------------------------------------------------------
      // 10. FINAL BACKEND ERROR
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
