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
const PORT = Number(process.env.PORT || 8080);

const SYSTEM_MESSAGE = `
Ești un agent virtual telefonic pentru o agenție imobiliară din România: ${AGENCY_NAME}.
Vorbești DOAR în limba română, politicos, clar, concis.

Scopul tău este:
1) să afli pentru ce proprietate sună clientul (cod anunț / link / adresă / cartier / tip proprietate),
2) să preiei date de contact (nume + număr de telefon dacă e diferit de cel de apel),
3) să întrebi 2-3 detalii utile (buget, când ar vrea vizionare, cerințe),
4) să anunți că un agent uman va reveni în maxim o oră.

Reguli:
- Nu promite lucruri sigure despre proprietate dacă nu știi.
- Dacă clientul nu știe codul anunțului, întreabă: oraș, zonă/cartier, tip, nr camere, buget.
- Fii scurt: 1 întrebare o dată.
- La final, confirmă informațiile și încheie politicos.
`.trim();

const VOICE = "alloy";
const TEMPERATURE = 0.7;

// ---- basic routes ----
fastify.addHook("onRequest", async (req) => {
  console.log(`[HTTP] ${req.method} ${req.url}`);
});

fastify.get("/", async () => ({ ok: true }));
fastify.get("/health", async (_req, reply) => reply.code(200).send("ok"));

// Twilio webhook: fara Say (fara mesaj Twilio)
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

// ---- Media Stream WS ----
fastify.register(async (f) => {
  f.get("/media-stream", { websocket: true }, (connection) => {
    console.log("Client connected (Twilio WS)");

    let streamSid = null;

    // OpenAI state
    let openAiReady = false;
    let sessionUpdated = false;

    // response control (no overlap)
    let responseInFlight = false;
    let pendingResponse = false;

    let lastDoneAt = 0;
    let lastCreateAt = 0;

    // ignore early VAD commits
    const callStartAt = Date.now();
    const IGNORE_COMMITTED_MS = 1200;

    const SAFE_GAP_AFTER_DONE_MS = 900;
    const MIN_GAP_BETWEEN_CREATE_MS = 700;

    // Greeting
    let greetingSent = false;

    const openAiWs = new WebSocket(
      // IMPORTANT: daca model-ul asta nu iti da audio, aici e primul loc unde schimbi
      `wss://api.openai.com/v1/realtime?model=gpt-realtime`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    const sendSessionUpdate = () => {
      // folosim schema acceptata de tine (ai session.updated OK)
      const payload = {
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
      openAiWs.send(JSON.stringify(payload));
    };

    const sendGreeting = () => {
      if (greetingSent) return;
      greetingSent = true;

      openAiWs.send(
        JSON.stringify({
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
        })
      );

      pendingResponse = true; // pump will create response safely
    };

    const tryCreateResponse = (reason) => {
      const now = Date.now();

      if (!openAiReady || !sessionUpdated || !streamSid) return;
      if (responseInFlight) return;

      if (now - lastDoneAt < SAFE_GAP_AFTER_DONE_MS) return;
      if (now - lastCreateAt < MIN_GAP_BETWEEN_CREATE_MS) return;

      lastCreateAt = now;
      responseInFlight = true; // optimistic guard
      pendingResponse = false;

      console.log(`Sending response.create (${reason})`);

      // IMPORTANT: nu trimitem campuri extra (sa nu rupa schema)
      openAiWs.send(
        JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            temperature: TEMPERATURE,
          },
        })
      );
    };

    // Pump: singurul loc care trimite response.create
    const pump = setInterval(() => {
      if (pendingResponse) tryCreateResponse("pump_pending");
    }, 200);

    // --- OpenAI events ---
    openAiWs.on("open", () => {
      console.log("Connected to OpenAI Realtime WS");
      openAiReady = true;
      if (streamSid) sendSessionUpdate();
    });

    openAiWs.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Log minim dar util
      if (
        msg.type === "session.created" ||
        msg.type === "session.updated" ||
        msg.type === "response.created" ||
        msg.type === "response.done" ||
        msg.type === "input_audio_buffer.committed" ||
        msg.type === "response.output_text.delta" ||
        msg.type === "response.output_text.done" ||
        msg.type === "error"
      ) {
        console.log(`Received event: ${msg.type}`);
      }

      if (msg.type === "session.updated") {
        sessionUpdated = true;
        // dupa ce sesiunea e confirmata, trimitem greeting
        sendGreeting();
        return;
      }

      if (msg.type === "response.created") {
        responseInFlight = true;
        return;
      }

      if (msg.type === "response.output_audio.delta" && msg.delta && streamSid) {
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

      if (msg.type === "response.output_text.delta" && msg.delta) {
        // vezi daca macar text vine
        process.stdout.write(msg.delta);
        return;
      }

      if (msg.type === "response.output_text.done") {
        process.stdout.write("\n");
        return;
      }

      if (msg.type === "response.done") {
        lastDoneAt = Date.now();
        responseInFlight = false;

        // log FULL ca sa vezi status/output
        console.log("RESPONSE.DONE FULL:", JSON.stringify(msg, null, 2));

        return;
      }

      if (msg.type === "input_audio_buffer.committed") {
        if (Date.now() - callStartAt < IGNORE_COMMITTED_MS) return;
        pendingResponse = true;
        return;
      }

      if (msg.type === "error") {
        console.error("OPENAI ERROR FULL:", JSON.stringify(msg, null, 2));

        // daca server zice ca e deja active response, NU mai spama; asteapta done
        if (msg?.error?.code === "conversation_already_has_active_response") {
          responseInFlight = true;
          pendingResponse = true;
        } else {
          responseInFlight = false;
        }
        return;
      }
    });

    openAiWs.on("close", () => {
      console.log("Disconnected from OpenAI Realtime WS");
      openAiReady = false;
      sessionUpdated = false;
      responseInFlight = false;
      pendingResponse = false;
    });

    openAiWs.on("error", (err) => {
      console.error("OpenAI WS error:", err);
    });

    // --- Twilio events ---
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
          if (openAiReady) sendSessionUpdate();
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

fastify.listen({ port: PORT, host: "0.0.0.0" }).then(
  () => console.log(`Server is listening on port ${PORT}`),
  (err) => {
    console.error("Fastify listen error:", err);
    process.exit(1);
  }
);

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
