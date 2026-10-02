import knowledge from "../server/toro/growwwave-knowledge.json";
import { buildSystemPrompt } from "../server/toro/prompt.js";

const FALLBACK_MODEL = "openrouter/free";

const PUBLIC_ERROR_MESSAGE =
  "Toro is temporarily unavailable right now. Please try again in a moment. For immediate assistance, you can reach the GrowwWave team directly via WhatsApp or email.";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://growwwave.github.io",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function getReadableProviderError(rawText, fallbackMessage) {
  let readableError = rawText;

  try {
    const parsed = JSON.parse(rawText);

    readableError =
      parsed?.error?.message ||
      parsed?.error?.status ||
      parsed?.message ||
      rawText;
  } catch {
    // Keep raw response text.
  }

  return String(
    readableError || fallbackMessage
  ).slice(0, 1500);
}

function isGeminiFallbackStatus(status) {
  return [
    408,
    409,
    429,
    500,
    502,
    503,
    504
  ].includes(status);
}

async function readProviderError(response, providerName) {
  const errorText = await response.text();

  const readableError = getReadableProviderError(
    errorText,
    `Unknown ${providerName} error.`
  );

  return new Error(
    `${providerName} HTTP ${response.status}: ${readableError}`
  );
}

function buildOpenRouterMessages(
  systemInstruction,
  contents
) {
  return [
    {
      role: "system",
      content: systemInstruction
    },

    ...contents.map((message) => ({
      role:
        message.role === "model"
          ? "assistant"
          : "user",

      content:
        message.parts?.[0]?.text || ""
    }))
  ];
}

function createToroSSEStream(
  response,
  provider
) {
  const reader =
    response.body.getReader();

  const decoder =
    new TextDecoder();

  const encoder =
    new TextEncoder();

  return new ReadableStream({
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

      const processGeminiEvent = (event) => {
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
          parsed = JSON.parse(raw);
        } catch {
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
          // Never expose Gemini internal thinking text.
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

      const processOpenRouterEvent = (event) => {
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
          parsed = JSON.parse(raw);
        } catch {
          return;
        }

        if (parsed?.error) {
          throw new Error(
            parsed.error.message ||
              parsed.error.code ||
              "OpenRouter stream error."
          );
        }

        const choice =
          parsed?.choices?.[0];

        if (
          choice?.finish_reason &&
          choice.finish_reason !== "stop" &&
          choice.finish_reason !== "length"
        ) {
          throw new Error(
            `OpenRouter finished without a normal response: ${choice.finish_reason}`
          );
        }

        const text =
          choice?.delta?.content;

        if (
          typeof text === "string" &&
          text
        ) {
          sentText = true;

          send({
            type: "delta",
            text
          });
        }
      };

      const processEvent = (event) => {
        if (provider === "openrouter") {
          processOpenRouterEvent(event);
          return;
        }

        processGeminiEvent(event);
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
            `${provider} completed the request but returned no text response.`
          );
        }

        send({
          type: "done"
        });

        controller.close();
      } catch (error) {
        console.error(
          `[Toro] ${provider} stream error:`,
          error
        );

        send({
          type: "error",
          message: PUBLIC_ERROR_MESSAGE
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
}

export default {
  async fetch(request, env) {
    const url =
      new URL(request.url);

    // Existing website assets
    if (
      url.pathname !==
      "/api/toro-chat"
    ) {
      return env.ASSETS.fetch(request);
    }

    // Toro API — CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    // Toro API — POST only
    if (request.method !== "POST") {
      return new Response(
        "Method Not Allowed",
        {
          status: 405,
          headers: {
            Allow: "POST",
            ...CORS_HEADERS
          }
        }
      );
    }

    try {
      // ---------------------------------------------------------
      // 1. READ REQUEST
      // ---------------------------------------------------------

      const body =
        await request.json();

      const messages =
        Array.isArray(
          body?.messages
        )
          ? body.messages.slice(-12)
          : [];

      if (!messages.length) {
        return Response.json(
          {
            error:
              "messages is required"
          },
          {
            status: 400,
            headers: {
              ...CORS_HEADERS
            }
          }
        );
      }

      // ---------------------------------------------------------
      // 2. PROVIDER CONFIG
      // ---------------------------------------------------------

      const geminiApiKey =
        env.GEMINI_API_KEY;

      if (!geminiApiKey) {
        throw new Error(
          "GEMINI_API_KEY is not configured."
        );
      }

      // Primary Gemini model.
      // Can still be overridden from Cloudflare env.
      const model =
        (
          env.GEMINI_MODEL ||
          "gemini-3.5-flash-lite"
        ).trim();

      if (!model) {
        throw new Error(
          "GEMINI_MODEL is empty."
        );
      }

      // Fallback OpenRouter key.
      const openRouterApiKey =
        env.OPENROUTER_API_KEY;

      // ---------------------------------------------------------
      // 3. BUILD SYSTEM PROMPT
      // ---------------------------------------------------------

      const promptKnowledge = {
        ...knowledge
      };

      const systemInstruction =
        buildSystemPrompt(
          promptKnowledge
        );

      if (
        !systemInstruction ||
        typeof systemInstruction !==
          "string"
      ) {
        throw new Error(
          "Toro system prompt could not be generated."
        );
      }

      // ---------------------------------------------------------
      // 4. BUILD CONTENTS
      // ---------------------------------------------------------

      const contents =
        messages
          .filter(
            (message) =>
              message &&
              typeof message.content ===
                "string" &&
              message.content.trim()
          )
          .map((message) => ({
            role:
              message.role === "model"
                ? "model"
                : "user",

            parts: [
              {
                text:
                  message.content.trim()
              }
            ]
          }));

      if (!contents.length) {
        throw new Error(
          "No valid message content was provided."
        );
      }

      // Gemini chat history must end with user's message.
      const lastMessage =
        contents[
          contents.length - 1
        ];

      if (
        lastMessage.role !== "user"
      ) {
        throw new Error(
          "Invalid conversation state: final message must be from the user."
        );
      }

      // ---------------------------------------------------------
      // 5. GEMINI PRIMARY REQUEST
      // ---------------------------------------------------------

      const geminiUrl =
        `https://generativelanguage.googleapis.com/v1beta/models/` +
        `${encodeURIComponent(model)}` +
        `:streamGenerateContent?alt=sse`;

      let response = null;
      let provider = "gemini";
      let geminiError = null;

      try {
        response =
          await fetch(
            geminiUrl,
            {
              method: "POST",

              headers: {
                "Content-Type":
                  "application/json",

                "Accept":
                  "text/event-stream",

                "x-goog-api-key":
                  geminiApiKey
              },

              body: JSON.stringify({
                systemInstruction: {
                  parts: [
                    {
                      text:
                        systemInstruction
                    }
                  ]
                },

                contents,

                generationConfig: {
                  thinkingConfig: {
                    thinkingLevel:
                      "minimal"
                  }
                }
              })
            }
          );
      } catch (error) {
        // Network/DNS/runtime failure.
        geminiError = error;

        console.warn(
          "[Toro] Gemini request failed before receiving a response. Falling back to OpenRouter.",
          error
        );
      }

      // ---------------------------------------------------------
      // 6. GEMINI HTTP ERROR → OPENROUTER FALLBACK
      // ---------------------------------------------------------

      if (
        !response ||
        !response.ok
      ) {
        if (response) {
          geminiError =
            await readProviderError(
              response,
              "Gemini"
            );
        }

        const geminiStatus =
          response?.status;

        const shouldFallback =
          !response ||
          isGeminiFallbackStatus(
            geminiStatus
          );

        if (
          !shouldFallback
        ) {
          throw (
            geminiError ||
            new Error(
              "Gemini request failed."
            )
          );
        }

        if (!openRouterApiKey) {
          console.error(
            "[Toro] Gemini failed but OPENROUTER_API_KEY is not configured.",
            geminiError
          );

          throw new Error(
            "Toro fallback provider is not configured."
          );
        }

        console.warn(
          "[Toro] Gemini unavailable. Switching to OpenRouter free fallback.",
          geminiError
        );

        const openRouterMessages =
          buildOpenRouterMessages(
            systemInstruction,
            contents
          );

        try {
          response =
            await fetch(
              "https://openrouter.ai/api/v1/chat/completions",
              {
                method: "POST",

                headers: {
                  "Content-Type":
                    "application/json",

                  "Accept":
                    "text/event-stream",

                  "Authorization":
                    `Bearer ${openRouterApiKey}`,

                  "HTTP-Referer":
                    "https://growwwave.github.io",

                  "X-Title":
                    "GrowwWave Toro"
                },

                body:
                  JSON.stringify({
                    model:
                      FALLBACK_MODEL,

                    stream: true,

                    messages:
                      openRouterMessages
                  })
              }
            );
        } catch (error) {
          console.error(
            "[Toro] OpenRouter network error:",
            error
          );

          throw new Error(
            "OpenRouter fallback request failed."
          );
        }

        if (!response.ok) {
          const openRouterError =
            await readProviderError(
              response,
              "OpenRouter"
            );

          console.error(
            "[Toro] OpenRouter fallback failed:",
            openRouterError
          );

          throw new Error(
            "OpenRouter fallback request failed."
          );
        }

        provider = "openrouter";
      }

      // ---------------------------------------------------------
      // 7. VALIDATE STREAM
      // ---------------------------------------------------------

      if (!response.body) {
        throw new Error(
          `${provider} returned no response stream.`
        );
      }

      // ---------------------------------------------------------
      // 8. STREAM PROVIDER → TORO
      // ---------------------------------------------------------

      const stream =
        createToroSSEStream(
          response,
          provider
        );

      // ---------------------------------------------------------
      // 9. RETURN SSE RESPONSE
      // ---------------------------------------------------------

      return new Response(
        stream,
        {
          status: 200,

          headers: {
            ...CORS_HEADERS,

            "Content-Type":
              "text/event-stream; charset=utf-8",

            "Cache-Control":
              "no-cache, no-transform",

            "X-Accel-Buffering":
              "no",

            "Connection":
              "keep-alive"
          }
        }
      );
    } catch (error) {
      console.error(
        "[Toro] Backend error:",
        error
      );

      return Response.json(
        {
          error:
            PUBLIC_ERROR_MESSAGE
        },
        {
          status: 503,

          headers: {
            ...CORS_HEADERS,

            "Cache-Control":
              "no-store"
          }
        }
      );
    }
  }
};
