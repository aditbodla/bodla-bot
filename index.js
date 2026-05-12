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
- Adapt naturally to the client's chat style. Formal client = professional tone. Casual or Roman Urdu client = friendly casual tone. Never be robotic.
- Be warm, helpful, conversational. This is WhatsApp — keep replies short and natural.
- Use common Pakistani real estate terms naturally (plot, marla, kanal, file, possession, etc).

YOUR JOB — FOLLOW THIS CONVERSATION FLOW:
STAGE 1 — INFORMATION: Answer ALL questions about projects, plots, amenities, locations, payment plans, company background. Give full helpful answers. Do NOT escalate here.
STAGE 2 — UNDERSTANDING: Ask follow-up questions to understand what the client needs. What size? Which area? Investment or personal use? Budget range?
STAGE 3 — ESCALATE ONLY WHEN: Client clearly says they want to book, buy, make a deal, finalize, visit the office, speak to someone, get a call, or asks for EXACT current price/rate to make a decision. ONLY then escalate.

WHAT IS NOT AN ESCALATION TRIGGER (keep answering normally):
- Asking about any project details
- Asking about plot sizes or general price ranges
- Asking about amenities, location, nearby facilities
- Asking about payment plans in general
- Asking "what plots do you have"
- Asking about investment potential
- Any general information question — ALWAYS answer these fully

WHAT IS AN ESCALATION TRIGGER (only these):
- "book karna hai" / "I want to book"
- "buy karna hai" / "lena hai" / "purchase"
- "agent se baat karni hai" / "call chahiye" / "meeting chahiye"
- "exact rate batao abhi" / "final price kya hai"
- "deal finalize karna hai"
- "visit karna chahta hoon office"
- Client has asked 5+ detailed questions showing serious intent AND then asks about next step

COMPANY KNOWLEDGE:
${knowledge}

RULES:
- Never give specific current plot prices — say "exact current rates hamare sales agent provide karenge" but still explain general info.
- Never promise returns on investment.
- Keep replies short — 3 to 5 lines max on WhatsApp.
- When escalating: say "Zaroor! Hamara sales agent aap se jald contact karega is number par. Jazakallah! 🙏" then on a NEW LINE write exactly: [ESCALATE]
- If you are not 100% sure the client wants human contact — DO NOT escalate. Keep the conversation going.`;
}

// ─── Check if AI wants to escalate ──────────────────────────────────────────
function shouldEscalate(aiReply) {
  return aiReply.includes("[ESCALATE]");
}

function cleanReply(text) {
  return text.replace("[ESCALATE]", "").trim();
}

// ─── Send message to sales agent (handles long chats by splitting) ───────────
async function notifyAgent(clientPhone, clientName, chatHistory) {
  const agentPhone = process.env.SALES_AGENT_WHATSAPP;
  const from = `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;

  const header =
    `🔔 *New Lead — Bodla Bot*\n` +
    `*Client:* ${clientName || "Unknown"}\n` +
    `*Phone:* ${clientPhone}\n` +
    `*Agent Action Required* — Please follow up.`;

  // Send header first
  await twilioClient.messages.create({
    from,
    to: `whatsapp:${agentPhone}`,
    body: header,
  });

  // Build chat lines and chunk them under 1400 chars each
  const lines = chatHistory.map(
    (m) => `${m.role === "user" ? clientName || "Client" : "Bot"}: ${m.content}`
  );

  const LIMIT = 1400;
  let chunk = "*Chat Log:*\n";
  let chunkNum = 1;

  for (const line of lines) {
    if ((chunk + "\n" + line).length > LIMIT) {
      await twilioClient.messages.create({
        from,
        to: `whatsapp:${agentPhone}`,
        body: chunk,
      });
      chunkNum++;
      chunk = `*Chat Log (cont.):*\n${line}`;
    } else {
      chunk += "\n" + line;
    }
  }

  // Send remaining chunk
  if (chunk.trim()) {
    await twilioClient.messages.create({
      from,
      to: `whatsapp:${agentPhone}`,
      body: chunk,
    });
  }
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

    // 3. If already escalated and no agent assigned yet — send holding reply
    console.log("Client status:", { phone: clientPhone, escalated: client?.escalated, assigned_to: client?.assigned_to });
    // Only hold if client explicitly requested agent contact (not just AI-detected escalation)
    if (client.escalated && client.agent_requested && !client.assigned_to) {
      const holdingReplies = [
        "Jazakallah for your patience! Hamara sales agent aap se jald contact karega. Agar koi aur sawaal hai to zaroor poochein! 😊",
        "Shukriya! Hamara agent aap ki request dekh raha hai aur jald hi aap se rabta karega. Thoda sa intezaar farmayein! 🙏",
        "Aapki request hamare team tak pohanch gayi hai. Sales agent jald hi aap se contact karega. Jazakallah! ✨",
      ];
      const reply = holdingReplies[Math.floor(Math.random() * holdingReplies.length)];
      await db.saveMessage(clientPhone, "assistant", reply);
      twiml.message(reply);
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    // 4. Load full chat history for context
    const history = await db.getChatHistory(clientPhone);

    // 5. Build messages array for OpenAI
    const messages = [
      { role: "system", content: buildSystemPrompt() },
      ...history.map((m) => ({ role: m.role, content: m.content })),
    ];

    // 6. Call OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      max_tokens: 500,
      temperature: 0.7,
    });

    const rawReply = completion.choices[0].message.content;
    const escalate = shouldEscalate(rawReply);
    const botReply = cleanReply(rawReply);

    // 7. Save bot reply
    await db.saveMessage(clientPhone, "assistant", botReply);

    // 8. If escalation needed, notify agent and mark conversation
    if (escalate) {
      try {
        const fullHistory = await db.getChatHistory(clientPhone);
        await notifyAgent(clientPhone, client.name, fullHistory);
        await db.markEscalated(clientPhone, true);
        console.log("Agent notified for:", clientPhone);
      } catch (agentErr) {
        console.error("Agent notification failed (will retry manually):", agentErr.message);
        await db.markEscalated(clientPhone, true);
      }
    }

    // 9. Reply to client
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
  try {
    const clients = await db.getAllClients();
    const data = await Promise.all(
      clients.map(async (c) => ({
        ...c,
        messages: await db.getChatHistory(c.phone),
      }))
    );
    res.json(data);
  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(500).json([]);
  }
});

app.get("/", (req, res) => res.send("Bodla Bot is running."));

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bodla Bot running on port ${PORT}`));

// ─── Load new modules ─────────────────────────────────────────────────────────
const auth = require("./auth");
const assignments = require("./assignments");

// ─── AUTH ROUTES ──────────────────────────────────────────────────────────────
app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });
    const result = await auth.login(username, password);
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.get("/api/me", auth.requireAuth(), (req, res) => {
  res.json(req.user);
});

// ─── ADMIN — USER MANAGEMENT ──────────────────────────────────────────────────
app.get("/api/users", auth.requireAuth(["admin", "manager"]), async (req, res) => {
  try {
    const { role, team_id } = req.query;
    const users = await auth.getUsers(role || null, team_id || null);
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/users", auth.requireAuth(["admin"]), async (req, res) => {
  try {
    const { username, password, full_name, role, team_id } = req.body;
    const user = await auth.createUser(username, password, full_name, role, team_id || null);
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── ADMIN — TEAM MANAGEMENT ──────────────────────────────────────────────────
app.get("/api/teams", auth.requireAuth(["admin", "manager"]), async (req, res) => {
  try {
    const teams = await auth.getTeams();
    res.json(teams);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/teams", auth.requireAuth(["admin"]), async (req, res) => {
  try {
    const { name, manager_id } = req.body;
    const team = await auth.createTeam(name, manager_id || null);
    res.json(team);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── LEADS TABLE ─────────────────────────────────────────────────────────────
app.get("/api/leads", auth.requireAuth(["admin", "manager", "agent"]), async (req, res) => {
  try {
    const leads = await assignments.getLeads(req.user);
    res.json(leads);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ASSIGN CLIENT TO AGENT ───────────────────────────────────────────────────
app.post("/api/leads/assign", auth.requireAuth(["admin", "manager"]), async (req, res) => {
  try {
    const { client_phone, agent_id } = req.body;
    const result = await assignments.assignClient(client_phone, agent_id, req.user.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── TRANSFER CLIENT ──────────────────────────────────────────────────────────
app.post("/api/leads/transfer", auth.requireAuth(["admin", "manager"]), async (req, res) => {
  try {
    const { client_phone, to_agent_id, reason } = req.body;
    const result = await assignments.transferClient(client_phone, to_agent_id, req.user.id, reason || null);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── AGENT — REPLY TO CLIENT VIA WHATSAPP ─────────────────────────────────────
app.post("/api/agent/reply", auth.requireAuth(["admin", "manager", "agent"]), async (req, res) => {
  try {
    const { client_phone, message } = req.body;
    if (!client_phone || !message) return res.status(400).json({ error: "client_phone and message required" });

    await twilioClient.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:${client_phone}`,
      body: message,
    });

    await db.saveMessage(client_phone, "agent", message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PLOT RATES ───────────────────────────────────────────────────────────────
app.get("/api/plot-rates", auth.requireAuth(), async (req, res) => {
  try {
    const rates = await assignments.getPlotRates();
    res.json(rates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/plot-rates", auth.requireAuth(["admin", "manager"]), async (req, res) => {
  try {
    const { sector, plot_type, size, min_price, max_price, notes } = req.body;
    await assignments.upsertPlotRate(sector, plot_type, size, min_price, max_price, notes, req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── BROCHURES ────────────────────────────────────────────────────────────────
app.get("/api/brochures", auth.requireAuth(), async (req, res) => {
  try {
    const brochures = await assignments.getBrochures();
    res.json(brochures);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
app.get("/api/settings", auth.requireAuth(["admin"]), async (req, res) => {
  try {
    const { data } = await require("@supabase/supabase-js")
      .createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
      .from("settings").select("*");
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/settings", auth.requireAuth(["admin"]), async (req, res) => {
  try {
    const { key, value } = req.body;
    await assignments.updateSetting(key, value, req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});