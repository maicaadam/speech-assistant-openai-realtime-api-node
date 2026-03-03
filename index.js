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

// Twilio webhook: fara mesaj <Say>
fastify.all("/incoming-call", async (request, reply) => {
  const wsBase = (PUBLIC_URL ? PUBLIC_URL : `https://${request.headers.host}`)
    .replace(/^http:\/\//, "ws://")
    .replace(/^https:\/\//, "wss://");

  // OPTIONAL: un mic Pause (silent) ajuta uneori la stabilizarea stream-ului.
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
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

    // Twilio readiness: NU pornim OpenAI greeting pana nu vedem primul frame media
    let twilioMediaSeen = false;

    // OpenAI state
    let openAiReady = false;
    let sessionUpdated = false;

    // Response control
    let responseInFlight = false;
    let pendingResponse = false;

    // barge-in / greeting gating
    let greetingSent = false;
    let allowUserAudioToOpenAI = false;

    // debug audio
    let audioDeltaCount = 0;

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
      // IMPORTANT: folosim schema care ți-a fost acceptată (session.updated apare în logs)
      const payload = {
        type: "session.update",
        session: {
          instructions: SYSTEM_MESSAGE,
          temperature: TEMPERATURE,
          voice: VOICE,
          turn_detection: { type: "server_vad" },

          // Twilio Media Streams = G.711 u-law (8k)
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
        },
      };

      console.log("Sending session.update to OpenAI");
      openAiWs.send(JSON.stringify(payload));
    };

    const createResponse = (reason) => {
      if (!openAiReady || !sessionUpdated || !streamSid) return;
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
            modalities: ["audio", "text"], // audio-only NU e acceptat la tine
            temperature: TEMPERATURE,
          },
        })
      );
    };

    const sendGreeting = () => {
      if (greetingSent) return;
      if (!twilioMediaSeen) return; // ✅ cheia: așteptăm primul frame de la Twilio
      greetingSent = true;

      // în timpul greeting-ului, NU trimitem audio user la OpenAI (altfel se anulează cu turn_detected)
      allowUserAudioToOpenAI = false;

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

    const maybeKickoff = () => {
      // pornim doar când avem: OpenAI WS open + streamSid + primul media frame
      if (!openAiReady || !streamSid || !twilioMediaSeen) return;

      if (!sessionUpdated) {
        sendSessionUpdate();
        return;
      }

      // dacă sesiunea e deja updated, trimitem greeting
      sendGreeting();
    };

    // --- OpenAI events ---
    openAiWs.on("open", () => {
      console.log("Connected to OpenAI Realtime WS");
      openAiReady = true;
      maybeKickoff();
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
        msg.type === "input_audio_buffer.speech_started" ||
        msg.type === "error"
      ) {
        console.log(`Received event: ${msg.type}`);
      }

      if (msg.type === "error") {
        console.error("OPENAI ERROR FULL:", JSON.stringify(msg, null, 2));

        // dacă e active response, nu mai spama response.create
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
        // acum putem trimite greeting (dar tot așteptăm twilioMediaSeen)
        maybeKickoff();
        return;
      }

      if (msg.type === "response.created") {
        responseInFlight = true;
        return;
      }

      // ✅ BARGE-IN: dacă user începe să vorbească peste bot, anulăm răspunsul curent
      if (msg.type === "input_audio_buffer.speech_started") {
        if (responseInFlight) {
          console.log("BARGE-IN: cancelling current response");
          openAiWs.send(JSON.stringify({ type: "response.cancel" }));
        }
        return;
      }

      // audio delta -> Twilio
      if (msg.type === "response.output_audio.delta" && msg.delta && streamSid) {
        audioDeltaCount += 1;
        if (audioDeltaCount <= 3) {
          console.log(`AUDIO_DELTA #${audioDeltaCount} bytes(base64): ${msg.delta.length}`);
        }

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
        responseInFlight = false;

        // dacă greeting-ul a terminat (sau a fost întrerupt), permitem audio user către OpenAI
        if (greetingSent && !allowUserAudioToOpenAI) {
          allowUserAudioToOpenAI = true;
          console.log("Greeting finished. User audio is now enabled.");
        }

        if (msg.response?.status === "failed") {
          console.error(
            "OPENAI FAILED DETAILS:",
            JSON.stringify(msg.response?.status_details, null, 2)
          );
        }

        if (pendingResponse) {
          // trimitem după ce răspunsul curent s-a închis
          createResponse("pending_after_done");
        }
        return;
      }

      if (msg.type === "input_audio_buffer.committed") {
        if (!allowUserAudioToOpenAI) return;
        pendingResponse = true;
        createResponse("vad_committed");
        return;
      }
    });

    openAiWs.on("close", () => {
      console.log("Disconnected from OpenAI Realtime WS");
      openAiReady = false;
      sessionUpdated = false;
      responseInFlight = false;
      pendingResponse = false;
      allowUserAudioToOpenAI = false;
      greetingSent = false;
      audioDeltaCount = 0;
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
          // NU kickoff aici; așteptăm primul media frame
          break;

        case "media":
          // ✅ cheia: primul media frame => acum e “audio-ready”
          if (!twilioMediaSeen) {
            twilioMediaSeen = true;
            console.log("First Twilio media frame received. Kickoff OpenAI now.");
            maybeKickoff();
          }

          // în timpul greeting-ului, ignorăm audio user ca să nu anuleze turnul
          if (!allowUserAudioToOpenAI) return;

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
