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

fastify.get("/", async () => ({ message: "Twilio Media Stream Server is running!" }));

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

fastify.register(async (f) => {
  f.get("/media-stream", { websocket: true }, (connection) => {
    console.log("Client connected (Twilio WS)");

    let streamSid = null;
    let twilioReady = false;

    let openAiReady = false;
    let sessionConfigured = false;

    // IMPORTANT: prevenim “response.create” concurente
    let openAiResponseActive = false;

    // opțional: dacă vrei ca AI să vorbească primul (greeting)
    let greetingSent = false;
    let greetingDone = false;

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

          // Twilio Media Streams = PCMU (G.711 u-law)
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
        },
      };

      console.log("Sending session.update to OpenAI");
      openAiWs.send(JSON.stringify(sessionUpdate));
    };

    const requestAssistantResponse = () => {
      if (openAiWs.readyState !== WebSocket.OPEN) return;
      if (openAiResponseActive) return; // ✅ FIX: nu cerem dacă deja există un răspuns activ

      openAiWs.send(
        JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            temperature: TEMPERATURE,
          },
        })
      );
      // NOTĂ: openAiResponseActive îl setăm pe response.created (mai corect)
    };

    const sendGreeting = () => {
      if (greetingSent) return;
      greetingSent = true;

      const initialItem = {
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

      openAiWs.send(JSON.stringify(initialItem));
      requestAssistantResponse();
    };

    const maybeKickoff = () => {
      if (!openAiReady || !twilioReady) return;
      if (sessionConfigured) return;

      sessionConfigured = true;
      sendSessionUpdate();

      // Dacă NU vrei ca AI să vorbească primul, comentează linia asta:
      sendGreeting();
    };

    openAiWs.on("open", () => {
      console.log("Connected to OpenAI Realtime WS");
      openAiReady = true;
      maybeKickoff();
    });

    openAiWs.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e) {
        console.error("OpenAI message parse error:", e);
        return;
      }

      // log util
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
        return;
      }

      // ✅ când OpenAI începe un răspuns, îl marcăm activ
      if (msg.type === "response.created") {
        openAiResponseActive = true;
      }

      // ✅ audio delta -> Twilio
      if (msg.type === "response.output_audio.delta" && msg.delta && streamSid) {
        connection.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: msg.delta },
          })
        );
      }

      // ✅ când răspunsul se termină, îl marcăm inactiv
      if (msg.type === "response.done") {
        openAiResponseActive = false;

        // dacă primul răspuns a fost greeting-ul, considerăm greeting “done”
        if (greetingSent && !greetingDone) greetingDone = true;

        if (msg.response?.status === "failed") {
          console.error(
            "OPENAI RESPONSE FAILED:",
            JSON.stringify(msg.response?.status_details, null, 2)
          );
        }
      }

      // ✅ când VAD comite vorbirea userului, cerem răspuns DOAR dacă nu e deja unul activ
      if (msg.type === "input_audio_buffer.committed") {
        // opțional: dacă AI a vorbit primul, nu răspundem la user până nu termină greeting-ul
        if (greetingSent && !greetingDone) return;

        requestAssistantResponse();
      }
    });

    openAiWs.on("close", () => {
      console.log("Disconnected from OpenAI Realtime WS");
      openAiReady = false;
      openAiResponseActive = false;
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
          twilioReady = true;
          console.log("Incoming stream started:", streamSid);
          maybeKickoff();
          break;

        case "media":
          // trimitem audio user către OpenAI
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
          console.log("Received non-media event: stop");
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
