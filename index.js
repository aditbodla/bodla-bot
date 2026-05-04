require("dotenv").config();
const path = require("path");
const express = require("express");
const { MessagingResponse } = require("twilio").twiml;
const twilio = require("twilio");
const OpenAI = require("openai");
const db = require("./database");
const fs = require("fs");
const knowledge = fs.readFileSync(path.join(__dirname, "knowledge.txt"), "utf8");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── System prompt for AI ────────────────────────────────────────────────────
function buildSystemPrompt() {
  return `You are a smart, friendly sales assistant for Bodla Group — a leading real estate company in DHA Multan, Pakistan.

YOUR PERSONALITY:
- You adapt naturally to the client's chat style. If they are formal, be professional. If they are casual or use Urdu/English mix (Romanized Urdu), match their tone and be friendly. Never be robotic.
- Be warm, helpful, and genuinely interested in helping the client find what they need.
- Keep responses concise — this is WhatsApp, not an essay. Use short paragraphs.
- You can use common Pakistani real estate terms naturally.

YOUR JOB:
1. Greet new clients warmly and ask how you can help.
2. Answer questions about Bodla Group using the knowledge below.
3. Understand what the client is looking for (investment, plot, home, project info).
4. When the client is ready to get pricing, is serious about buying/booking, wants specific plot availability, wants to negotiate, or asks to speak with someone — tell them a sales agent will contact them shortly and set ESCALATE=true.

COMPANY KNOWLEDGE:
${knowledge}

IMPORTANT RULES:
- Never make up prices or plot availability — say our agent will provide exact current rates.
- Never promise specific returns on investment.
- If asked something you don't know, say you'll have the sales team follow up.
- Always end escalation with: "Our sales agent will contact you shortly on this number. Jazakallah!"
- When you decide to escalate, add this exact tag at the very END of your message on a new line: [ESCALATE]`;
}

// ─── Check if AI wants to escalate ──────────────────────────────────────────
function shouldEscalate(aiReply) {
  return aiReply.includes("[ESCALATE]");
}

function cleanReply(text) {
  return text.replace("[ESCALATE]", "").trim();
}

// ─── Send message to sales agent ────────────────────────────────────────────
async function notifyAgent(clientPhone, clientName, chatHistory) {
  const agentPhone = process.env.SALES_AGENT_WHATSAPP;
  const from = `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;

  const historyText = chatHistory
    .map((m) => `${m.role === "user" ? clientName || "Client" : "Bot"}: ${m.content}`)
    .join("\n");

  const message =
    `🔔 *New Lead — Bodla Bot*\n\n` +
    `*Client:* ${clientName || "Unknown"}\n` +
    `*Phone:* ${clientPhone}\n\n` +
    `*Chat Log:*\n${historyText}\n\n` +
    `Please follow up with this client.`;

  await twilioClient.messages.create({
    from,
    to: `whatsapp:${agentPhone}`,
    body: message,
  });
}

// ─── Main webhook ────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const incomingMsg = req.body.Body?.trim();
  const clientPhone = req.body.From?.replace("whatsapp:", "");
  const profileName = req.body.ProfileName || null;

  if (!incomingMsg || !clientPhone) {
    return res.status(400).send("Bad request");
  }

  const twiml = new MessagingResponse();

  try {
    // 1. Get or create client in DB
    let client = await db.getClient(clientPhone);
    if (!client) {
      client = await db.createClient(clientPhone, profileName);
    } else if (!client.name && profileName) {
      await db.updateClientName(clientPhone, profileName);
      client.name = profileName;
    }

    // 2. Save incoming message
    await db.saveMessage(clientPhone, "user", incomingMsg);

    // 3. Load full chat history for context
    const history = await db.getChatHistory(clientPhone);

    // 4. Build messages array for OpenAI
    const messages = [
      { role: "system", content: buildSystemPrompt() },
      ...history.map((m) => ({ role: m.role, content: m.content })),
    ];

    // 5. Call OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      max_tokens: 500,
      temperature: 0.7,
    });

    const rawReply = completion.choices[0].message.content;
    const escalate = shouldEscalate(rawReply);
    const botReply = cleanReply(rawReply);

    // 6. Save bot reply
    await db.saveMessage(clientPhone, "assistant", botReply);

    // 7. If escalation needed, notify agent and mark conversation
    if (escalate) {
      try {
        const fullHistory = await db.getChatHistory(clientPhone);
        await notifyAgent(clientPhone, client.name, fullHistory);
        await db.markEscalated(clientPhone);
        console.log("Agent notified for:", clientPhone);
      } catch (agentErr) {
        // Log the error but don't crash — client still gets their reply
        console.error("Agent notification failed (will retry manually):", agentErr.message);
        await db.markEscalated(clientPhone); // still mark escalated in DB
      }
    }

    // 8. Reply to client
    twiml.message(botReply);
    res.type("text/xml");
    res.send(twiml.toString());
  } catch (err) {
    console.error("Webhook error:", err);
    twiml.message("Sorry, something went wrong. Please try again in a moment.");
    res.type("text/xml");
    res.send(twiml.toString());
  }
});

// ─── Dashboard HTML ───────────────────────────────────────────────────────────
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

// ─── Dashboard data API ───────────────────────────────────────────────────────
app.get("/api/clients", async (req, res) => {
  const clients = db.getAllClients();
  const data = clients.map((c) => ({
    ...c,
    messages: db.getChatHistory(c.phone),
  }));
  res.json(data);
});

app.get("/", (req, res) => res.send("Bodla Bot is running."));

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bodla Bot running on port ${PORT}`));