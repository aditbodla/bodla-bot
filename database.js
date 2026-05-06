const { createClient: createSupabaseClient } = require("@supabase/supabase-js");

const supabase = createSupabaseClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function getClient(phone) {
  const { data } = await supabase
    .from("clients")
    .select("*")
    .eq("phone", phone)
    .single();
  return data || null;
}

async function createClient(phone, name) {
  const { data } = await supabase
    .from("clients")
    .upsert(
      { phone, name: name || null, last_seen: new Date().toISOString() },
      { onConflict: "phone" }
    )
    .select()
    .single();
  return data;
}

async function updateClientName(phone, name) {
  await supabase.from("clients").update({ name }).eq("phone", phone);
}

async function markEscalated(phone) {
  await supabase
    .from("clients")
    .update({ escalated: true, last_seen: new Date().toISOString() })
    .eq("phone", phone);
}

async function getAllClients() {
  const { data } = await supabase
    .from("clients")
    .select("*")
    .order("last_seen", { ascending: false });
  return data || [];
}

async function saveMessage(phone, role, content) {
  await supabase.from("messages").insert({ phone, role, content });
  await supabase
    .from("clients")
    .update({ last_seen: new Date().toISOString() })
    .eq("phone", phone);
}

async function getChatHistory(phone) {
  const { data } = await supabase
    .from("messages")
    .select("role, content, created_at")
    .eq("phone", phone)
    .order("created_at", { ascending: true });
  return data || [];
}

module.exports = {
  getClient,
  createClient,
  updateClientName,
  markEscalated,
  getAllClients,
  saveMessage,
  getChatHistory,
};