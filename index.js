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

// Twilio webhook: fara mesaj (fara <Say>)
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

    // Twilio state
    let streamSid = null;

    // OpenAI state
    let openAiReady = false;
    let sessionUpdated = false;

    // Response control (NU permite responses suprapuse)
    let responseInFlight = false;
    let pendingResponse = false;

    // pentru barge-in
    let lastResponseId = null;

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
      // IMPORTANT:
      // - output_modalities in SESSION (nu in response)
      // - turn_detection.create_response=false => ca sa NU mai creeze OpenAI responses automat
      // - noi dam response.create doar la committed
      const payload = {
        type: "session.update",
        session: {
          type: "realtime",
          model: "gpt-realtime",

          output_modalities: ["audio", "text"],

          audio: {
            input: {
              format: { type: "audio/pcmu" }, // Twilio Media Streams = PCMU (G.711 u-law)
              turn_detection: {
                type: "server_vad",
                create_response: false,     // ✅ nu mai auto-răspunde
                interrupt_response: true,   // ✅ permite barge-in
              },
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

    const sendGreeting = () => {
      // AI vorbește primul (poți comenta dacă vrei să nu vorbească primul)
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
      createResponse("greeting");
    };

    const createResponse = (reason) => {
      if (!openAiReady || !sessionUpdated) return;

      if (responseInFlight) {
        // nu spamăm response.create; doar marcăm că e pending
        pendingResponse = true;
        return;
      }

      responseInFlight = true;
      pendingResponse = false;

      console.log(`Sending response.create (${reason})`);
      openAiWs.send(
        JSON.stringify({
          type: "response.create",
          // IMPORTANT: nu mai trimitem aici output_modalities;
          // modalitățile sunt deja setate în session.update.
          response: {
            temperature: TEMPERATURE,
          },
        })
      );
    };

    const bargeIn = () => {
      if (!responseInFlight) return;

      // 1) oprim generarea curentă
      openAiWs.send(JSON.stringify({ type: "response.cancel" }));

      // 2) aruncăm audio ne-redat din buffer
      openAiWs.send(JSON.stringify({ type: "output_audio_buffer.clear" }));

      // 3) spunem Twilio să șteargă playback-ul curent imediat
      if (streamSid) {
        connection.send(
          JSON.stringify({
            event: "clear",
            streamSid,
          })
        );
      }
    };

    // --- OpenAI events ---
    openAiWs.on("open", () => {
      console.log("Connected to OpenAI Realtime WS");
      openAiReady = true;

      // Trimitem session.update imediat (nu depinde de audio)
      sendSessionUpdate();
    });

    openAiWs.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // LOG minimal util
      if (
        msg.type === "session.created" ||
        msg.type === "session.updated" ||
        msg.type === "response.created" ||
        msg.type === "response.done" ||
        msg.type === "input_audio_buffer.committed" ||
        msg.type === "input_audio_buffer.speech_started" ||
        msg.type === "error"
      ) {
        console.log(`Received event: ${msg.type}`);
      }

      if (msg.type === "error") {
        console.error("OPENAI ERROR:", JSON.stringify(msg, null, 2));
        // dacă apare din nou overlap, înseamnă că undeva creezi încă un response în paralel
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

        // greeting după ce sesiunea e configurată
        // (poți comenta dacă nu vrei să vorbească AI primul)
        sendGreeting();
        return;
      }

      if (msg.type === "response.created") {
        responseInFlight = true;
        lastResponseId = msg.response?.id || lastResponseId;
        return;
      }

      // ✅ OpenAI audio -> Twilio
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

      // ✅ barge-in: dacă user începe să vorbească și AI încă vorbește, îl oprim
      if (msg.type === "input_audio_buffer.speech_started") {
        bargeIn();
        return;
      }

      // ✅ după ce VAD comite vorbirea userului, cerem răspuns (manual)
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

        // dacă între timp userul a vorbit (pending), pornim următorul response acum
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
      lastResponseId = null;
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
          break;

        case "media":
          // trimitem audio user către OpenAI mereu (barge-in funcționează)
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
