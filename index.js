import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";

dotenv.config();

const { OPENAI_API_KEY, PUBLIC_URL } = process.env;

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
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

// --- basic routes ---
fastify.addHook("onRequest", async (req) => {
  console.log(`[HTTP] ${req.method} ${req.url}`);
});

fastify.get("/", async () => ({ ok: true }));
fastify.get("/health", async (_req, reply) => reply.code(200).send("ok"));

// Twilio webhook: fara Say, conectare directa la stream
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

// --- Twilio Media Streams WS ---
fastify.register(async (f) => {
  f.get("/media-stream", { websocket: true }, (connection) => {
    console.log("Client connected (Twilio WS)");

    let streamSid = null;

    // --- OpenAI state ---
    let openAiReady = false;
    let sessionUpdated = false;

    // “server thinks a response is active”
    let responseInFlight = false;

    // we only set this on committed, and the pump decides when to actually call response.create
    let pendingResponse = false;

    // keep some timing to avoid race conditions
    let lastResponseDoneAt = 0;
    let lastResponseCreateAt = 0;

    // ignore early VAD commits (noise/silence at call start)
    const callStartAt = Date.now();
    const IGNORE_COMMITTED_MS = 1500;

    // IMPORTANT: this is the real “anti-race” delay after response.done
    const SAFE_GAP_AFTER_DONE_MS = 900;

    // throttle: never create responses too fast
    const MIN_GAP_BETWEEN_CREATE_MS = 700;

    // greeting control
    let greetingQueued = false;

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
      const payload = {
        type: "session.update",
        session: {
          instructions: SYSTEM_MESSAGE,
          temperature: TEMPERATURE,
          voice: VOICE,
          turn_detection: {
            type: "server_vad",
            // reduce spam commits a bit
            silence_duration_ms: 650,
            prefix_padding_ms: 200,
          },
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
        },
      };

      console.log("Sending session.update to OpenAI");
      openAiWs.send(JSON.stringify(payload));
    };

    const queueGreeting = () => {
      if (greetingQueued) return;
      greetingQueued = true;

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
                `Pentru ce proprietate sunați? Dacă aveți codul anunțului sau un link, spuneți-mi.`,
            },
          ],
        },
      };

      openAiWs.send(JSON.stringify(item));
      pendingResponse = true; // pump will create the response when safe
    };

    const tryCreateResponse = (reason) => {
      const now = Date.now();

      if (!openAiReady) return;
      if (!sessionUpdated) return;
      if (!streamSid) return;

      if (responseInFlight) return;

      // wait after last done to avoid server-side race
      if (now - lastResponseDoneAt < SAFE_GAP_AFTER_DONE_MS) return;

      // throttle
      if (now - lastResponseCreateAt < MIN_GAP_BETWEEN_CREATE_MS) return;

      lastResponseCreateAt = now;
      responseInFlight = true; // optimistic: prevents local double-sends
      pendingResponse = false;

      console.log(`Sending response.create (${reason})`);

      openAiWs.send(
        JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            temperature: TEMPERATURE,
            voice: VOICE,
          },
        })
      );
    };

    // Pump: one place that is allowed to call response.create
    const pump = setInterval(() => {
      if (pendingResponse) {
        tryCreateResponse("pump_pending");
      }
    }, 200);

    const maybeStart = () => {
      if (!openAiReady) return;
      if (!streamSid) return;

      // session update once
      if (!sessionUpdated) {
        sendSessionUpdate();
      }
    };

    // --- OpenAI handlers ---
    openAiWs.on("open", () => {
      console.log("Connected to OpenAI Realtime WS");
      openAiReady = true;
      maybeStart();
    });

    openAiWs.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
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

      if (msg.type === "session.updated") {
        sessionUpdated = true;
        // only now queue greeting
        queueGreeting();
        return;
      }

      if (msg.type === "response.created") {
        // server accepted response
        responseInFlight = true;
        return;
      }

      if (msg.type === "response.output_audio.delta" && msg.delta && streamSid) {
        // if you NEVER see this, OpenAI isn't producing audio
        console.log("AUDIO_DELTA");
        connection.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: msg.delta },
          })
        );
        return;
      }

      if (msg.type === "response.done") {
        lastResponseDoneAt = Date.now();
        responseInFlight = false;

        if (msg.response?.status === "failed") {
          console.error(
            "OPENAI RESPONSE FAILED:",
            JSON.stringify(msg.response?.status_details, null, 2)
          );
        }
        return;
      }

      if (msg.type === "input_audio_buffer.committed") {
        // ignore early noise commits
        if (Date.now() - callStartAt < IGNORE_COMMITTED_MS) return;

        // DO NOT create response here; only set pending
        pendingResponse = true;
        return;
      }

      if (msg.type === "error") {
        console.error("OPENAI ERROR:", JSON.stringify(msg, null, 2));

        // Important: if server says active_response, treat it as still in flight
        if (msg?.error?.code === "conversation_already_has_active_response") {
          responseInFlight = true;
          pendingResponse = true; // keep pending; pump will retry after a future response.done
        } else {
          responseInFlight = false;
        }
        return;
      }
    });

    openAiWs.on("close", () => {
      console.log("Disconnected from OpenAI Realtime WS");
      openAiReady = false;
      responseInFlight = false;
      pendingResponse = false;
      sessionUpdated = false;
    });

    openAiWs.on("error", (err) => {
      console.error("OpenAI WS error:", err);
    });

    // --- Twilio handlers ---
    connection.on("message", (message) => {
      let data;
      try {
        data = JSON.parse(message.toString());
      } catch {
        return;
      }

      switch (data.event) {
        case "start":
          streamSid = data.start.streamSid;
          console.log("Incoming stream started:", streamSid);
          maybeStart();
          break;

        case "media":
          if (openAiWs.readyState === WebSocket.OPEN) {
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
      clearInterval(pump);
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
