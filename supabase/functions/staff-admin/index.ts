// Admin-only staff logins for the tasks view.
//   POST /staff-admin { action: "add", name, email, password, role, manager_id, branch }
//   POST /staff-admin { action: "remove", user_id }
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { sb } from "../_shared/sync.ts";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-client-info, apikey, content-type" };
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...CORS, "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const caller = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { authorization: req.headers.get("authorization") ?? "" } }, auth: { persistSession: false },
  });
  const { data: isAdmin } = await caller.rpc("is_admin");
  if (!isAdmin) return json({ error: "Faqat adminlar uchun" }, 403);
  const b = await req.json().catch(() => ({}));

  if (b.action === "add") {
    const role = b.role === "branch" ? "branch" : "manager";
    if (!b.name || !b.email || String(b.password ?? "").length < 8) return json({ error: "Ism, email va kamida 8 belgili parol kerak" }, 400);
    if (role === "manager" ? !b.manager_id : !b.branch) return json({ error: role === "manager" ? "Menejerni tanlang" : "Filial nomini kiriting" }, 400);
    const { data, error } = await sb.auth.admin.createUser({ email: b.email, password: b.password, email_confirm: true });
    if (error || !data.user) return json({ error: error?.message ?? "Akkaunt yaratilmadi" }, 400);
    const { error: e2 } = await sb.from("staff").insert({ user_id: data.user.id, email: b.email, name: b.name, role, manager_id: role === "manager" ? b.manager_id : null, branch: role === "branch" ? b.branch : null });
    if (e2) { await sb.auth.admin.deleteUser(data.user.id); return json({ error: e2.message }, 500); }
    return json({ ok: true });
  }

  if (b.action === "remove") {
    // Only staff rows can be removed here, never an admin account.
    const { data: row } = await sb.from("staff").select("user_id").eq("user_id", b.user_id).maybeSingle();
    const { data: admin } = await sb.from("admins").select("user_id").eq("user_id", b.user_id).maybeSingle();
    if (!row || admin) return json({ error: "Bu akkauntni o'chirib bo'lmaydi" }, 400);
    const { error } = await sb.auth.admin.deleteUser(b.user_id);
    return error ? json({ error: error.message }, 500) : json({ ok: true });
  }
  return json({ error: "action?" }, 400);
});
