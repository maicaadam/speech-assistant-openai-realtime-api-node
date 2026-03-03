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

const PORT = Number(process.env.PORT || 8080);

const SYSTEM_MESSAGE = `
E�ti agentul virtual al companiei imobiliare Union Group din România.
Vorbești DOAR în limba română, politicos, cald și profesionist.

SALUT OBLIGATORIU la început:
"Bună ziua, sunt agentul virtual al companiei imobiliare Union Group. Vă rog să îmi spuneți pentru ce proprietate ați sunat și îi voi transmite agentului responsabil."

Scopul tău este:
1) Află proprietatea pentru care sună clientul (cod anunț / adresă / cartier / tip).
2) Dacă clientul întreabă detalii despre o proprietate (ex: are centrală?, câte camere?, preț?), caută pe site-ul https://www.uniongroup.ro/vanzari și oferă informațiile găsite. Dacă nu găsești, spune sincer că vei transmite întrebarea agentului.
3) Preia numele clientului.
4) Întreabă când ar dori vizionarea și dacă are cerințe speciale.
5) Încheie cu: "Mulțumesc! Agentul asignat vă va suna cât mai rapid. O zi frumoasă!"

Reguli:
- O întrebare o dată, nu îngrămădi.
- Nu inventa informații despre proprietăți.
- Fii scurt și natural, ca un om.
- La finalul apelului, înainte de a închide, generează un REZUMAT și afișează-l cu prefixul exact [REZUMAT APEL] astfel:
  [REZUMAT APEL]
  Proprietate: ...
  Client: ...
  Cerințe/Întrebări: ...
  Disponibilitate vizionare: ...
`.trim();

const VOICE = "alloy";
const TEMPERATURE = 0.7;

fastify.addHook("onRequest", async (req) => {
  console.log(`[HTTP] ${req.method} ${req.url}`);
});

fastify.get("/", async () => ({ ok: true }));
fastify.get("/health", async (_req, reply) => reply.code(200).send("ok"));

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
    let openAiReady = false;
    let sessionUpdated = false;
    let responseInFlight = false;

    // Buffer pentru transcript - ca sa putem loga rezumatul
    let fullTranscript = "";

    const openAiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview`,
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
          modalities: ["audio", "text"],
          voice: VOICE,
          instructions: SYSTEM_MESSAGE,
          temperature: TEMPERATURE,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          // Activam transcriptul pentru input audio
          input_audio_transcription: { model: "whisper-1" },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
            create_response: true,
          },
        },
      };

      console.log("Sending session.update to OpenAI");
      openAiWs.send(JSON.stringify(payload));
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
                text: "Saluta clientul conform instructiunilor.",
              },
            ],
          },
        })
      );

      openAiWs.send(
        JSON.stringify({
          type: "response.create",
          response: { temperature: TEMPERATURE },
        })
      );
    };

    const bargeIn = () => {
      if (streamSid) {
        connection.send(JSON.stringify({ event: "clear", streamSid }));
      }
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

      console.log(`[OAI EVENT] ${msg.type}`);

      if (msg.type === "error") {
        console.error("OPENAI ERROR:", JSON.stringify(msg, null, 2));
        responseInFlight = false;
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

      // Audio -> Twilio
      if (msg.type === "response.audio.delta" && msg.delta && streamSid) {
        connection.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: msg.delta },
          })
        );
        return;
      }

      // Colectam transcriptul botului
      if (msg.type === "response.audio_transcript.delta" && msg.delta) {
        fullTranscript += msg.delta;
        return;
      }

      // Colectam transcriptul userului
      if (
        msg.type === "conversation.item.input_audio_transcription.completed" &&
        msg.transcript
      ) {
        console.log(`[USER] ${msg.transcript}`);
        fullTranscript += `\nClient: ${msg.transcript}\n`;
        return;
      }

      // La sfarsitul fiecarui raspuns al botului, adaugam linie noua
      if (msg.type === "response.audio_transcript.done" && msg.transcript) {
        console.log(`[BOT] ${msg.transcript}`);

        // Daca transcriptul contine rezumatul, il logam special
        if (msg.transcript.includes("[REZUMAT APEL]")) {
          console.log("\n=============================");
          console.log(msg.transcript);
          console.log("=============================\n");
        }
        return;
      }

      if (msg.type === "input_audio_buffer.speech_started") {
        bargeIn();
        return;
      }

      if (msg.type === "response.audio.done") {
        responseInFlight = false;
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
        return;
      }
    });

    openAiWs.on("close", () => {
      console.log("Disconnected from OpenAI Realtime WS");
      // La inchiderea conexiunii, logam tot transcriptul
      if (fullTranscript) {
        console.log("\n===== TRANSCRIPT COMPLET =====");
        console.log(fullTranscript);
        console.log("==============================\n");
      }
      openAiReady = false;
      sessionUpdated = false;
      responseInFlight = false;
    });

    openAiWs.on("error", (err) => {
      console.error("OpenAI WS error:", err);
    });

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
