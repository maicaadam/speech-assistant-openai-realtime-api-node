import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PUBLIC_URL = process.env.PUBLIC_URL; // ex: https://xxxx.up.railway.app (NU wss)
const AGENCY_NAME = process.env.AGENCY_NAME || "Agentia X";

if (!OPENAI_API_KEY) {
  console.error("Missing OpenAI API key. Please set OPENAI_API_KEY in Railway variables.");
  process.exit(1);
}

const fastify = Fastify({ logger: false });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// ---------- Config ----------
const SYSTEM_MESSAGE = `
Ești un agent virtual telefonic pentru o agenție imobiliară din România: ${AGENCY_NAME}.
Vorbești DOAR în limba română, politicos, clar, concis.

Scopul tău este:
1) să afli pentru ce proprietate sună clientul (cod anunț / link / adresă / cartier / tip proprietate),
2) să preiei date de contact (nume + număr de telefon dacă e diferit de cel de apel),
3) să întrebi 2-3 detalii utile (buget, când ar vrea vizionare, cerințe),
4) să anunți că un agent uman va reveni în maxim o oră.

Reguli:
- Nu promite lucruri sigure despre proprietate (preț, disponibilitate) dacă nu știi.
- Dacă clientul nu știe codul anunțului, întreabă: oraș, zonă/cartier, tip (apartament/casă/teren), nr camere, buget.
- Fii scurt: 1 întrebare o dată.
- La final, confirmă informațiile și încheie politicos.
`.trim();

const VOICE = "alloy"; // aici e motivul pronunției nasoale la română; e ok funcțional, dar accentul nu e grozav.
const TEMPERATURE = 0.7;

const PORT = Number(process.env.PORT) || 8080;

// loguri utile
const LOG_EVENT_TYPES = new Set([
  "error",
  "rate_limits.updated",
  "session.created",
  "session.updated",
  "input_audio_buffer.speech_started",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.committed",
  "response.done",
]);

// ---------- Routes ----------
fastify.addHook("onRequest", async (request) => {
  console.log(`[HTTP] ${request.method} ${request.url}`);
});

fastify.get("/", async (request, reply) => {
  reply.send({ message: "Twilio Media Stream Server is running!" });
});

fastify.get("/health", async (request, reply) => {
  reply.code(200).send("ok");
});

// Twilio webhook
fastify.all("/incoming-call", async (request, reply) => {
  const hostFromRequest = request.headers.host;

  // PUBLIC_URL trebuie să fie https://... (nu wss)
  // dacă nu există, folosim host-ul requestului
  const baseHttp = (PUBLIC_URL ? PUBLIC_URL : `https://${hostFromRequest}`).trim();

  const wsBase = baseHttp
    .replace(/^http:\/\//i, "ws://")
    .replace(/^https:\/\//i, "wss://");

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Carmen" language="ro-RO">
    Bună! Vă rog să așteptați. Vă conectez la agentul virtual al agenției.
  </Say>
  <Connect>
    <Stream url="${wsBase}/media-stream" />
  </Connect>
</Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// ---------- WebSocket (Twilio <-> OpenAI) ----------
fastify.register(async (f) => {
  f.get("/media-stream", { websocket: true }, (connection, req) => {
    console.log("Client connected (Twilio WS)");

    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    // OpenAI Realtime WS
    const openAiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime", {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    });

    const safeSendOpenAI = (obj) => {
      if (openAiWs.readyState === WebSocket.OPEN) {
        openAiWs.send(JSON.stringify(obj));
      }
    };

    const initializeSession = () => {
      // IMPORTANT: Twilio Media Streams trimite G.711 u-law (PCMU) base64.
      // În Realtime API, asta se setează ca g711_ulaw.
      const sessionUpdate = {
        type: "session.update",
        session: {
          type: "realtime",
          model: "gpt-realtime",
          voice: VOICE,
          instructions: SYSTEM_MESSAGE,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: { type: "server_vad" },
        },
      };

      console.log("Sending session.update to OpenAI");
      safeSendOpenAI(sessionUpdate);
    };

    const sendInitialConversationItem = () => {
      const initialConversationItem = {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                `Bună! Sunt agentul virtual de la ${AGENCY_NAME}. ` +
                `Spuneți-mi, vă rog, pentru ce proprietate sunați? ` +
                `Dacă aveți codul anunțului sau un link, îl puteți spune acum.`,
            },
          ],
        },
      };

      safeSendOpenAI(initialConversationItem);

      // cerem răspuns audio
      safeSendOpenAI({
        type: "response.create",
        response: {
          modalities: ["audio"],
          temperature: TEMPERATURE,
        },
      });
    };

    const sendMark = () => {
      if (!streamSid) return;
      connection.send(
        JSON.stringify({
          event: "mark",
          streamSid,
          mark: { name: "responsePart" },
        })
      );
      markQueue.push("responsePart");
    };

    const handleSpeechStartedEvent = () => {
      if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
        const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;

        if (lastAssistantItem) {
          safeSendOpenAI({
            type: "conversation.item.truncate",
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: elapsedTime,
          });
        }

        // cere Twilio să “șteargă” audio bufferul redat
        connection.send(JSON.stringify({ event: "clear", streamSid }));

        markQueue = [];
        lastAssistantItem = null;
        responseStartTimestampTwilio = null;
      }
    };

    openAiWs.on("open", () => {
      console.log("Connected to OpenAI Realtime WS");
      setTimeout(() => {
        initializeSession();
        sendInitialConversationItem();
      }, 100);
    });

    openAiWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (LOG_EVENT_TYPES.has(msg.type)) {
          console.log(`Received event: ${msg.type}`);
        }

        // log detalii când fail
        if (msg.type === "response.done" && msg.response?.status === "failed") {
          console.error("OPENAI RESPONSE FAILED:", JSON.stringify(msg.response?.status_details, null, 2));
        }

        // audio spre Twilio
        if (msg.type === "response.output_audio.delta" && msg.delta) {
          connection.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: msg.delta },
            })
          );

          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;
          }
          if (msg.item_id) lastAssistantItem = msg.item_id;

          sendMark();
        }

        if (msg.type === "input_audio_buffer.speech_started") {
          handleSpeechStartedEvent();
        }

        // rezumat text în logs (când cerem)
        if (msg.type === "response.output_text.delta" && msg.delta) {
          console.log("SUMMARY_DELTA:", msg.delta);
        }
        if (msg.type === "response.output_text.done" && msg.text) {
          console.log("SUMMARY_DONE:", msg.text);
        }
      } catch (e) {
        console.error("Error processing OpenAI message:", e);
      }
    });

    // Twilio -> OpenAI
    connection.on("message", (message) => {
      try {
        const data = JSON.parse(message.toString());

        switch (data.event) {
          case "start":
            streamSid = data.start.streamSid;
            latestMediaTimestamp = 0;
            responseStartTimestampTwilio = null;
            console.log("Incoming stream started:", streamSid);
            break;

          case "media":
            latestMediaTimestamp = data.media.timestamp;
            // Twilio trimite base64 audio (PCMU). Trimitem direct la OpenAI.
            safeSendOpenAI({
              type: "input_audio_buffer.append",
              audio: data.media.payload,
            });
            break;

          case "mark":
            if (markQueue.length > 0) markQueue.shift();
            break;

          default:
            console.log("Received non-media event:", data.event);
            break;
        }
      } catch (err) {
        console.error("Error parsing Twilio message:", err);
      }
    });

    // când Twilio închide, cerem rezumat text (opțional)
    connection.on("close", () => {
      console.log("Client disconnected (Twilio WS). Generating summary...");

      if (openAiWs.readyState === WebSocket.OPEN) {
        safeSendOpenAI({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  "Te rog generează un REZUMAT scurt pentru agent (max 8 linii) în română, cu câmpuri:\n" +
                  "- Proprietate (cod/link/zonă)\n" +
                  "- Tip + detalii (camere/mp)\n" +
                  "- Buget\n" +
                  "- Program vizionare\n" +
                  "- Nume client\n" +
                  "- Telefon (dacă a fost spus)\n" +
                  "- Alte observații\n",
              },
            ],
          },
        });

        safeSendOpenAI({
          type: "response.create",
          response: {
            modalities: ["text"],
            temperature: 0.2,
          },
        });

        setTimeout(() => {
          try {
            openAiWs.close();
          } catch {}
        }, 1200);
      } else {
        try {
          openAiWs.close();
        } catch {}
      }
    });

    openAiWs.on("close", () => {
      console.log("Disconnected from OpenAI Realtime WS");
    });

    openAiWs.on("error", (err) => {
      console.error("OpenAI WS error:", err);
    });
  });
});

// ---------- Start server ----------
fastify.ready((err) => {
  if (err) console.error("Fastify not ready:", err);
  else console.log("Fastify ready");
});

const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`Server is listening on port ${PORT}`);
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
};

start();

// Graceful shutdown (Railway poate trimite SIGTERM)
process.on("SIGTERM", async () => {
  console.log("Received SIGTERM - shutting down gracefully");
  try {
    await fastify.close();
    console.log("Fastify closed");
  } catch (e) {
    console.error("Error during shutdown:", e);
  } finally {
    process.exit(0);
  }
});
