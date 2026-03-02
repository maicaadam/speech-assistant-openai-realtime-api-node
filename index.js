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

fastify.addHook("onRequest", async (request) => {
  console.log(`[HTTP] ${request.method} ${request.url}`);
});

fastify.get("/", async () => ({ ok: true, service: "twilio-openai-realtime" }));
fastify.get("/health", async (_req, reply) => reply.code(200).send("ok"));

// Twilio webhook: FARA Say. Conecteaza direct stream-ul.
fastify.all("/incoming-call", async (request, reply) => {
  const wsBase = (PUBLIC_URL ? PUBLIC_URL : `https://${request.headers.host}`)
    .replace(/^http:\/\//, "ws://")
    .replace(/^https:\/\//, "wss://");

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsBase}/media-stream" />
  </Connect>
</Response>`;

  reply.type("text/xml").send(twimlResponse);
});

fastify.register(async (f) => {
  f.get("/media-stream", { websocket: true }, (connection) => {
    console.log("Client connected (Twilio WS)");

    let streamSid = null;

    // OpenAI state
    let openAiReady = false;
    let sessionConfigured = false;

    // SUPER IMPORTANT: gating pentru response.create
    let responseInFlight = false;

    // Optional: OpenAI vorbeste primul
    let greetingSent = false;
    let greetingInFlight = false;

    const openAiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=gpt-realtime`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    function sendSessionUpdate() {
      // IMPORTANT: schema moderna, fara "session.audio" (care iti dadea unknown_parameter)
      const sessionUpdate = {
        type: "session.update",
        session: {
          instructions: SYSTEM_MESSAGE,
          temperature: TEMPERATURE,
          voice: VOICE,
          turn_detection: { type: "server_vad" },

          // Twilio Media Streams payload = PCMU (G.711 u-law)
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
        },
      };

      console.log("Sending session.update to OpenAI");
      openAiWs.send(JSON.stringify(sessionUpdate));
    }

    function requestResponse(modalities = ["audio", "text"]) {
      if (openAiWs.readyState !== WebSocket.OPEN) return;
      if (responseInFlight) return; // ✅ fix: nu cerem alt raspuns daca e deja unul activ

      openAiWs.send(
        JSON.stringify({
          type: "response.create",
          response: {
            modalities,
            temperature: TEMPERATURE,
          },
        })
      );
      // NOTA: responseInFlight devine true pe "response.created"
    }

    function sendGreeting() {
      if (greetingSent) return;
      greetingSent = true;
      greetingInFlight = true;

      const item = {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                `Bună! Sunt agentul virtual de la ${AGENCY_NAME}. ` +
                `Spune-mi, te rog, pentru ce proprietate suni? Dacă ai codul anunțului sau un link, spune-mi.`,
            },
          ],
        },
      };

      openAiWs.send(JSON.stringify(item));
      requestResponse(["audio", "text"]);
    }

    function maybeStart() {
      if (!openAiReady || !streamSid) return;
      if (sessionConfigured) return;

      sessionConfigured = true;
      sendSessionUpdate();

      // OpenAI vorbeste primul (cum ai cerut).
      // Daca vrei sa NU vorbeasca primul, comenteaza linia urmatoare:
      sendGreeting();
    }

    // OpenAI events
    openAiWs.on("open", () => {
      console.log("Connected to OpenAI Realtime WS");
      openAiReady = true;
      maybeStart();
    });

    openAiWs.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e) {
        console.error("OpenAI message parse error:", e);
        return;
      }

      if (
        msg.type === "session.created" ||
        msg.type === "session.updated" ||
        msg.type === "response.created" ||
        msg.type === "response.done" ||
        msg.type === "input_audio_buffer.committed" ||
        msg.type === "error"
      ) {
        console.log(`Received event: ${msg.type}`);
      }

      if (msg.type === "error") {
        console.error("OPENAI ERROR:", JSON.stringify(msg, null, 2));
        // daca OpenAI respinge cererea, eliberam gating-ul ca sa nu blocam flow-ul
        responseInFlight = false;
        greetingInFlight = false;
        return;
      }

      if (msg.type === "response.created") {
        responseInFlight = true;
      }

      if (msg.type === "response.output_audio.delta" && msg.delta && streamSid) {
        connection.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: msg.delta },
          })
        );
      }

      if (msg.type === "response.done") {
        responseInFlight = false;

        // daca asta a fost greeting-ul, de acum raspundem normal la user
        if (greetingInFlight) greetingInFlight = false;

        if (msg.response?.status === "failed") {
          console.error(
            "OPENAI RESPONSE FAILED:",
            JSON.stringify(msg.response?.status_details, null, 2)
          );
        }
      }

      // Cand VAD comite vocea user-ului, cerem raspuns,
      // DAR NU daca greeting-ul e inca in progress sau deja exista raspuns activ.
      if (msg.type === "input_audio_buffer.committed") {
        if (greetingInFlight) return;
        requestResponse(["audio", "text"]);
      }
    });

    openAiWs.on("close", () => {
      console.log("Disconnected from OpenAI Realtime WS");
      openAiReady = false;
      responseInFlight = false;
      greetingInFlight = false;
    });

    openAiWs.on("error", (err) => {
      console.error("OpenAI WS error:", err);
    });

    // Twilio -> server
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
          console.log("Incoming stream started:", streamSid);
          maybeStart();
          break;

        case "media":
          // forward audio către OpenAI
          if (openAiReady && openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(
              JSON.stringify({
                type: "input_audio_buffer.append",
                audio: data.media.payload,
              })
            );
          }
          break;

        case "stop":
          console.log("Twilio stop");
          break;

        default:
          // connected / mark etc
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
