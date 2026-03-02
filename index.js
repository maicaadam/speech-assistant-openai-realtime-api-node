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

// --- app routes ---
fastify.addHook("onRequest", async (request) => {
  console.log(`[HTTP] ${request.method} ${request.url}`);
});

fastify.get("/", async () => ({ ok: true }));
fastify.get("/health", async (_req, reply) => reply.code(200).send("ok"));

// Twilio webhook: fara <Say> - conectam direct stream-ul
fastify.all("/incoming-call", async (request, reply) => {
  const wsBase = (PUBLIC_URL ? PUBLIC_URL : `https://${request.headers.host}`)
    .replace(/^http:\/\//, "ws://")
    .replace(/^https:\/\//, "wss://");

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsBase}/media-stream" />
  </Connect>
</Response>`;

  reply.type("text/xml").send(twiml);
});

// --- Twilio Media Stream WS ---
fastify.register(async (f) => {
  f.get("/media-stream", { websocket: true }, (connection) => {
    console.log("Client connected (Twilio WS)");

    let streamSid = null;

    // OpenAI state
    let openAiReady = false;
    let sessionConfigured = false;

    // Raspuns in zbor (OpenAI)
    let responseInFlight = false;

    // Cand user vorbeste, VAD face committed -> setam pending si raspundem doar cand e safe
    let pendingResponse = false;

    // Ignoram committed-uri din primele X ms (zgomot/tacere de start)
    const callStartAt = Date.now();
    const IGNORE_COMMITTED_MS = 1200;

    // Mic delay dupa response.done inainte sa permitem alt response.create
    const AFTER_DONE_DELAY_MS = 250;

    // Ca sa nu spamam response.create din greseala
    let lastResponseCreateAt = 0;
    const MIN_GAP_BETWEEN_RESPONSES_MS = 400;

    // OpenAI WS
    const openAiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=gpt-realtime`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    const sendSessionUpdate = () => {
      const sessionUpdate = {
        type: "session.update",
        session: {
          instructions: SYSTEM_MESSAGE,
          temperature: TEMPERATURE,
          voice: VOICE,
          turn_detection: { type: "server_vad" },
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
        },
      };

      console.log("Sending session.update to OpenAI");
      openAiWs.send(JSON.stringify(sessionUpdate));
    };

    const safeCreateResponse = (reason) => {
      const now = Date.now();

      if (openAiWs.readyState !== WebSocket.OPEN) return;
      if (responseInFlight) return;

      // throttle
      if (now - lastResponseCreateAt < MIN_GAP_BETWEEN_RESPONSES_MS) return;

      lastResponseCreateAt = now;
      console.log(`Sending response.create (${reason})`);

      openAiWs.send(
        JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            temperature: TEMPERATURE,
            // uneori ajuta sa fie explicit si aici
            voice: VOICE,
          },
        })
      );
      // responseInFlight devine true pe response.created
    };

    const greetOnce = () => {
      // OpenAI vorbeste primul
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
      safeCreateResponse("greeting");
    };

    const maybeStart = () => {
      if (!openAiReady || !streamSid) return;
      if (sessionConfigured) return;

      sessionConfigured = true;
      sendSessionUpdate();

      // greeting
      greetOnce();
    };

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

        // daca OpenAI ne-a respins pentru active_response, NU mai incercam imediat.
        // pastram pendingResponse si incercam dupa urmatorul response.done + delay.
        return;
      }

      if (msg.type === "response.created") {
        responseInFlight = true;
      }

      if (msg.type === "response.output_audio.delta" && msg.delta && streamSid) {
        // DEBUG: confirma ca vine audio
        // (daca vezi AUDIO_DELTA in logs dar nu se aude, e problema pe Twilio playback)
        // Daca NU vezi AUDIO_DELTA, OpenAI nu livreaza audio.
        console.log("AUDIO_DELTA");
        connection.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: msg.delta },
          })
        );
      }

      if (msg.type === "response.done") {
        // IMPORTANT: nu eliberam instant; asteptam putin
        setTimeout(() => {
          responseInFlight = false;

          // daca intre timp user a vorbit (pendingResponse), raspundem acum
          if (pendingResponse) {
            pendingResponse = false;
            safeCreateResponse("pending_after_done");
          }
        }, AFTER_DONE_DELAY_MS);

        if (msg.response?.status === "failed") {
          console.error(
            "OPENAI RESPONSE FAILED:",
            JSON.stringify(msg.response?.status_details, null, 2)
          );
        }
      }

      if (msg.type === "input_audio_buffer.committed") {
        // ignora committed in primele momente ale apelului
        if (Date.now() - callStartAt < IGNORE_COMMITTED_MS) return;

        // daca e raspuns in flight, doar marcam pending
        if (responseInFlight) {
          pendingResponse = true;
          return;
        }

        // daca nu e in flight, cerem response
        safeCreateResponse("vad_committed");
      }
    });

    openAiWs.on("close", () => {
      console.log("Disconnected from OpenAI Realtime WS");
      openAiReady = false;
      responseInFlight = false;
      pendingResponse = false;
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

// start server
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
