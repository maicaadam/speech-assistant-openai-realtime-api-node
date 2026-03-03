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

// Twilio webhook: fara <Say>
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

    // Prevent overlapping responses
    let responseInFlight = false;
    let pendingResponse = false;

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
      // ✅ schema “sigură” (fără session.type / session.model / input_audio_format etc.)
      const payload = {
        type: "session.update",
        session: {
          output_modalities: ["audio", "text"],
          audio: {
            input: {
              format: { type: "audio/pcmu" },
              // IMPORTANT: nu auto-crea response (altfel te lovești de active response)
              turn_detection: { type: "server_vad", create_response: false },
            },
            output: {
              format: { type: "audio/pcmu" },
              voice: VOICE,
            },
          },
          instructions: SYSTEM_MESSAGE,
          temperature: TEMPERATURE,
        },
      };

      console.log("Sending session.update to OpenAI");
      openAiWs.send(JSON.stringify(payload));
    };

    const createResponse = (reason) => {
      if (!openAiReady || !sessionUpdated) return;

      if (responseInFlight) {
        pendingResponse = true;
        return;
      }

      responseInFlight = true;
      pendingResponse = false;

      console.log(`Sending response.create (${reason})`);
      openAiWs.send(
        JSON.stringify({
          type: "response.create",
          response: {
            temperature: TEMPERATURE,
          },
        })
      );
    };

    const sendGreeting = () => {
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

      createResponse("greeting");
    };

    const bargeIn = () => {
      if (!responseInFlight) return;

      // Oprim răspunsul în curs
      openAiWs.send(JSON.stringify({ type: "response.cancel" }));
      // Curățăm audio buffer output
      openAiWs.send(JSON.stringify({ type: "output_audio_buffer.clear" }));

      // Oprim playback la Twilio
      if (streamSid) {
        connection.send(JSON.stringify({ event: "clear", streamSid }));
      }

      // eliberăm lock-ul local (altfel rămâne blocat)
      responseInFlight = false;
    };

    openAiWs.on("open", () => {
      console.log("Connected to OpenAI Realtime WS");
      openAiReady = true;
      sendSessionUpdate();
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
        msg.type === "input_audio_buffer.speech_started" ||
        msg.type === "input_audio_buffer.committed" ||
        msg.type === "error"
      ) {
        console.log(`Received event: ${msg.type}`);
      }

      if (msg.type === "error") {
        console.error("OPENAI ERROR:", JSON.stringify(msg, null, 2));
        // dacă cumva tot ajungi la overlap, marchează pending și așteaptă done
        if (msg?.error?.code === "conversation_already_has_active_response") {
          responseInFlight = true;
          pendingResponse = true;
        } else {
          responseInFlight = false;
        }
        return;
      }

      if (msg.type === "session.updated") {
        sessionUpdated = true;
        sendGreeting();
        return;
      }

      if (msg.type === "response.created") {
        responseInFlight = true;
        return;
      }

      // AUDIO -> Twilio
      if (msg.type === "response.output_audio.delta" && msg.delta && streamSid) {
        connection.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: msg.delta },
          })
        );
        return;
      }

      // Barge-in: user începe să vorbească peste AI
      if (msg.type === "input_audio_buffer.speech_started") {
        bargeIn();
        return;
      }

      // După committed, cerem răspuns (manual)
      if (msg.type === "input_audio_buffer.committed") {
        pendingResponse = true;
        createResponse("vad_committed");
        return;
      }

      if (msg.type === "response.done") {
        responseInFlight = false;

        if (msg.response?.status === "failed") {
          console.error(
            "OPENAI FAILED DETAILS:",
            JSON.stringify(msg.response?.status_details, null, 2)
          );
        }

        if (pendingResponse) {
          createResponse("pending_after_done");
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

    // Twilio -> server
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
