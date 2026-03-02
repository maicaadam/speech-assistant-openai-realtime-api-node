import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";

dotenv.config();

const { OPENAI_API_KEY, PUBLIC_URL } = process.env;

if (!OPENAI_API_KEY) {
  console.error("Missing OpenAI API key. Please set OPENAI_API_KEY.");
  process.exit(1);
}

const fastify = Fastify({ logger: false });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const AGENCY_NAME = process.env.AGENCY_NAME || "Agentia X";

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

const VOICE = "alloy";
const TEMPERATURE = 0.7;
const PORT = Number(process.env.PORT || 8080);

const LOG_EVENT_TYPES = new Set([
  "error",
  "session.created",
  "session.updated",
  "input_audio_buffer.speech_started",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.committed",
  "response.created",
  "response.output_audio.delta",
  "response.done",
]);

fastify.addHook("onRequest", async (request) => {
  console.log(`[HTTP] ${request.method} ${request.url}`);
});

fastify.get("/", async () => {
  return { message: "Twilio Media Stream Server is running!" };
});

// healthcheck super-simplu
fastify.get("/health", async (_req, reply) => {
  reply.code(200).send("ok");
});

// Twilio webhook
fastify.all("/incoming-call", async (request, reply) => {
  const wsBase = (PUBLIC_URL ? PUBLIC_URL : `https://${request.headers.host}`)
    .replace(/^http:\/\//, "ws://")
    .replace(/^https:\/\//, "wss://");

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

// WebSocket endpoint pentru Twilio Media Streams
fastify.register(async (f) => {
  f.get("/media-stream", { websocket: true }, (connection, _req) => {
    console.log("Client connected (Twilio WS)");

    let streamSid = null;
    let latestMediaTimestamp = 0;

    const openAiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=gpt-realtime`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    let openAiReady = false;
    let awaitingResponse = false;

    // ✅ FIX #1: NU trimite session.output_modalities (era cauza "Unknown parameter")
    // păstrăm doar câmpuri compatibile; modalitățile le cerem în response.create.
    const sendSessionUpdate = () => {
      const sessionUpdate = {
        type: "session.update",
        session: {
          instructions: SYSTEM_MESSAGE,
          temperature: TEMPERATURE,

          // Audio compatibil Twilio Media Streams (PCMU / G.711 u-law)
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: VOICE,

          // VAD pe server (OpenAI)
          turn_detection: { type: "server_vad" },
        },
      };

      console.log("Sending session.update to OpenAI");
      openAiWs.send(JSON.stringify(sessionUpdate));
    };

    const requestAudioResponse = () => {
      openAiWs.send(
        JSON.stringify({
          type: "response.create",
          response: {
            // aici controlăm output-ul
            output_modalities: ["audio"],
            temperature: TEMPERATURE,
          },
        })
      );
      awaitingResponse = true;
    };

    const sendInitialPrompt = () => {
      // AI vorbește primul (opțional). Dacă nu vrei, comentează apelul la sendInitialPrompt()
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
                `Pentru ce proprietate sunați? Dacă aveți codul anunțului sau un link, spuneți-mi.`,
            },
          ],
        },
      };

      openAiWs.send(JSON.stringify(initialConversationItem));
      requestAudioResponse();
    };

    openAiWs.on("open", () => {
      console.log("Connected to OpenAI Realtime WS");
      openAiReady = true;

      setTimeout(() => {
        sendSessionUpdate();
        // dacă vrei ca AI să vorbească primul:
        sendInitialPrompt();
      }, 100);
    });

    openAiWs.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e) {
        console.error("OpenAI message parse error:", e);
        return;
      }

      if (LOG_EVENT_TYPES.has(msg.type)) {
        if (msg.type !== "response.output_audio.delta") {
          console.log(`Received event: ${msg.type}`);
        }
      }

      if (msg.type === "error") {
        console.error("OPENAI ERROR:", JSON.stringify(msg, null, 2));
        awaitingResponse = false;
        return;
      }

      // audio -> Twilio
      if (msg.type === "response.output_audio.delta" && msg.delta && streamSid) {
        connection.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: msg.delta },
          })
        );
      }

      // când VAD a comis audio-ul, cerem răspuns (o singură dată per turn)
      if (msg.type === "input_audio_buffer.committed") {
        if (!awaitingResponse) requestAudioResponse();
      }

      if (msg.type === "response.done") {
        awaitingResponse = false;

        if (msg.response?.status === "failed") {
          console.error(
            "OPENAI RESPONSE FAILED:",
            JSON.stringify(msg.response?.status_details, null, 2)
          );
        }
      }
    });

    openAiWs.on("close", () => {
      console.log("Disconnected from OpenAI Realtime WS");
      openAiReady = false;
    });

    openAiWs.on("error", (err) => {
      console.error("OpenAI WS error:", err);
    });

    // Mesaje venite de la Twilio
    connection.on("message", (message) => {
      let data;
      try {
        data = JSON.parse(message.toString());
      } catch (e) {
        console.error("Twilio message parse error:", e);
        return;
      }

      switch (data.event) {
        case "start":
          streamSid = data.start.streamSid;
          latestMediaTimestamp = 0;
          console.log("Incoming stream started:", streamSid);
          break;

        case "media":
          latestMediaTimestamp = data.media.timestamp;

          if (openAiReady && openAiWs.readyState === WebSocket.OPEN) {
            // Twilio payload base64 PCMU -> OpenAI input_audio_buffer.append
            openAiWs.send(
              JSON.stringify({
                type: "input_audio_buffer.append",
                audio: data.media.payload,
              })
            );
          }
          break;

        case "mark":
          // ignorăm
          break;

        case "stop":
          console.log("Received non-media event: stop");
          break;

        default:
          console.log("Received non-media event:", data.event);
          break;
      }
    });

    connection.on("close", () => {
      console.log("Client disconnected (Twilio WS)");
      try {
        if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      } catch {}
    });
  });
});

const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`Server is listening on port ${PORT}`);
  } catch (err) {
    console.error("Fastify listen error:", err);
    process.exit(1);
  }
};
start();

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
