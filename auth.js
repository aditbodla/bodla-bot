const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { createClient: createSupabaseClient } = require("@supabase/supabase-js");
const ws = require("ws");

const supabase = createSupabaseClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { realtime: { transport: ws } }
);

const JWT_SECRET = process.env.JWT_SECRET || "bodlabot-secret-2026";

// ─── Login ────────────────────────────────────────────────────────────────────
async function login(username, password) {
  const { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("username", username)
    .eq("is_active", true)
    .single();

  if (!user) throw new Error("Invalid username or password");

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) throw new Error("Invalid username or password");

  await supabase
    .from("users")
    .update({ last_login: new Date().toISOString() })
    .eq("id", user.id);

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, team_id: user.team_id, full_name: user.full_name },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

  return {
    token,
    user: { id: user.id, username: user.username, role: user.role, full_name: user.full_name, team_id: user.team_id }
  };
}

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(roles = []) {
  return (req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const decoded = jwt.verify(auth.split(" ")[1], JWT_SECRET);
      req.user = decoded;
      if (roles.length && !roles.includes(decoded.role)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      next();
    } catch {
      return res.status(401).json({ error: "Invalid token" });
    }
  };
}

// ─── User management ─────────────────────────────────────────────────────────
async function createUser(username, password, fullName, role, teamId = null) {
  const password_hash = await bcrypt.hash(password, 10);
  const { data, error } = await supabase
    .from("users")
    .insert({ username, password_hash, full_name: fullName, role, team_id: teamId })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function getUsers(role = null, teamId = null) {
  let query = supabase.from("users").select("id, username, full_name, role, team_id, is_active, last_login, created_at");
  if (role) query = query.eq("role", role);
  if (teamId) query = query.eq("team_id", teamId);
  const { data } = await query.order("created_at", { ascending: true });
  return data || [];
}

async function getTeams() {
  const { data } = await supabase
    .from("teams")
    .select("*, manager:manager_id(id, full_name, username)")
    .order("created_at", { ascending: true });
  return data || [];
}

async function createTeam(name, managerId) {
  const { data, error } = await supabase
    .from("teams")
    .insert({ name, manager_id: managerId })
    .select()
    .single();
  if (error) throw new Error(error.message);
  if (managerId) {
    await supabase.from("users").update({ team_id: data.id }).eq("id", managerId);
  }
  return data;
}

module.exports = { login, requireAuth, createUser, getUsers, getTeams, createTeam };