import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";

dotenv.config();

const { OPENAI_API_KEY, PUBLIC_URL, AGENCY_NAME } = process.env;

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

const PORT = Number(process.env.PORT || 8080);
const VOICE = "alloy";
const TEMPERATURE = 0.7;

const AGENCY = AGENCY_NAME || "Agentia X";

const SYSTEM_MESSAGE = `
Ești un agent virtual telefonic pentru o agenție imobiliară din România: ${AGENCY}.
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

const fastify = Fastify({ logger: false });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

fastify.addHook("onRequest", async (req) => {
  console.log(`[HTTP] ${req.method} ${req.url}`);
});

fastify.get("/", async () => ({ ok: true }));
fastify.get("/health", async (_req, reply) => reply.code(200).send("ok"));

// Twilio webhook: fără mesaj inițial (fără <Say>)
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

fastify.register(async (f) => {
  f.get("/media-stream", { websocket: true }, (connection) => {
    console.log("Client connected (Twilio WS)");

    let streamSid = null;
    let gotFirstMedia = false;

    // OpenAI WS + state
    let openAiWs = null;
    let openAiReady = false;
    let sessionUpdated = false;

    // Response control (single-flight + queue)
    let responseActive = false;      // set true on response.created, false on response.done
    let pendingResponse = false;     // if we need to create after current ends
    let cooldownUntil = 0;           // small delay after response.done to avoid race
    let greetingSent = false;

    const now = () => Date.now();

    const twilioClear = () => {
      if (!streamSid) return;
      connection.send(JSON.stringify({ event: "clear", streamSid }));
    };

    const openAiSend = (obj) => {
      if (!openAiWs || openAiWs.readyState !== WebSocket.OPEN) return;
      openAiWs.send(JSON.stringify(obj));
    };

    const connectOpenAI = () => {
      if (openAiWs) return;

      openAiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=gpt-realtime`, {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      openAiWs.on("open", () => {
        console.log("Connected to OpenAI Realtime WS");
        openAiReady = true;

        // session.update (schema care ți-a mers deja în logs)
        const sessionUpdate = {
          type: "session.update",
          session: {
            model: "gpt-realtime",
            temperature: TEMPERATURE,
            instructions: SYSTEM_MESSAGE,
            output_modalities: ["audio"],
            audio: {
              input: {
                format: { type: "audio/pcmu" },
                turn_detection: { type: "server_vad" },
              },
              output: {
                format: { type: "audio/pcmu" },
                voice: VOICE,
              },
            },
          },
        };

        console.log("Sending session.update to OpenAI");
        openAiSend(sessionUpdate);
      });

      openAiWs.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        // log minimal util
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
          console.error("OPENAI ERROR FULL:", JSON.stringify(msg, null, 2));

          // dacă ne zice că deja e un response activ, nu mai trimitem acum; îl punem pending
          if (msg?.error?.code === "conversation_already_has_active_response") {
            responseActive = true;
            pendingResponse = true;
          }
          return;
        }

        if (msg.type === "session.updated") {
          sessionUpdated = true;

          // trimite greeting o singură dată (AI vorbește primul)
          if (!greetingSent && streamSid) {
            greetingSent = true;

            openAiSend({
              type: "conversation.item.create",
              item: {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text:
                      `Bună! Sunt agentul virtual de la ${AGENCY}. ` +
                      `Pentru ce proprietate sunați? Dacă aveți codul anunțului sau un link, spuneți-mi.`,
                  },
                ],
              },
            });

            triggerResponse("greeting");
          }
          return;
        }

        if (msg.type === "response.created") {
          responseActive = true;
          return;
        }

        // IMPORTANT: audio streaming către Twilio
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

        // Barge-in: user a început să vorbească -> oprim botul
        if (msg.type === "input_audio_buffer.speech_started") {
          if (responseActive) {
            // oprește răspunsul curent la OpenAI + oprește playback la Twilio
            openAiSend({ type: "response.cancel" });
            twilioClear();
            pendingResponse = true; // vrem răspuns după ce user termină
          }
          return;
        }

        if (msg.type === "input_audio_buffer.committed") {
          // user a terminat de vorbit (VAD) -> cerem răspuns (dar fără overlap)
          pendingResponse = true;
          triggerResponse("vad_committed");
          return;
        }

        if (msg.type === "response.done") {
          responseActive = false;

          // mic cooldown (evită race cu “active response”)
          cooldownUntil = now() + 150;

          // dacă aveam ceva pending (de la committed / barge-in), pornește după cooldown
          if (pendingResponse) {
            setTimeout(() => triggerResponse("pending_after_done"), 170);
          }
          return;
        }
      });

      openAiWs.on("close", () => {
        console.log("Disconnected from OpenAI Realtime WS");
        openAiReady = false;
        sessionUpdated = false;
        responseActive = false;
        pendingResponse = false;
        greetingSent = false;
        openAiWs = null;
      });

      openAiWs.on("error", (err) => {
        console.error("OpenAI WS error:", err);
      });
    };

    const triggerResponse = (reason) => {
      if (!openAiReady || !sessionUpdated || !streamSid) return;

      // dacă încă e activ sau suntem în cooldown -> lasă pending, nu trimite acum
      if (responseActive || now() < cooldownUntil) {
        pendingResponse = true;
        return;
      }

      pendingResponse = false;

      console.log(`Sending response.create (${reason})`);

      // IMPORTANT: nu trimitem modalities aici; folosim setarea din session.update (audio)
      openAiSend({ type: "response.create" });
    };

    // Twilio inbound
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
          // folosim primul frame ca semnal că stream-ul e “real”
          if (!gotFirstMedia) {
            gotFirstMedia = true;
            console.log("First Twilio media frame received. Kickoff OpenAI now.");
            connectOpenAI();
          }

          // trimitem audio către OpenAI imediat (ca să permită barge-in)
          if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
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
        if (openAiWs && openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
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
