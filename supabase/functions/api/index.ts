// Platform API:
//   /event            database change events (from triggers) -> Telegram notifications
//   /setup            admin: connect the bot webhook, read bot username, check channel
//   /public           login screen branding
//   /file             proxy for files students sent to the bot
//   /student/state    student cabinet data (login via token from the bot)
//   /student/action   student actions: finish lesson, start free course, notes
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// deno-lint-ignore no-explicit-any
type Any = any;
const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const URL_BASE = Deno.env.get("SUPABASE_URL")!;
const sb = createClient(URL_BASE, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, x-student-token", "access-control-allow-methods": "GET, POST, OPTIONS" };
const json = (d: Any, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...CORS, "content-type": "application/json" } });
const money = (n: Any) => Math.round(+n || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " so'm";
const esc = (s: Any) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as Any)[c]);
const lessonsOf = (c: Any) => (c?.modules || []).flatMap((m: Any) => m.lessons || []);
// one past the furthest finished lesson (a skipped video-only lesson must not block the course)
const halfCount = (c: Any) => Math.ceil(lessonsOf(c).length / 2);
// a private channel is addressed by its numeric id; a public one also by @username
const channelChat = (S: Any) => S.channelId || (S.channel && !String(S.channel).startsWith("+") ? "@" + S.channel : null);
const reachIdx = (c: Any, done: Any[]) => lessonsOf(c).reduce((k: number, l: Any, i: number) => done.includes(l.id) ? i + 1 : k, 0);

async function tg(method: string, params: Any = {}) {
  if (!TOKEN) return null;
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) });
  const j = await r.json();
  if (!j.ok) console.error(method, j.description);
  return j.ok ? j.result : null;
}
const send = (chat: Any, text: string, reply_markup?: Any) => tg("sendMessage", { chat_id: chat, text, parse_mode: "HTML", reply_markup, disable_web_page_preview: true });
function sendMedia(chat: Any, type: string, file: string, caption: string, reply_markup?: Any, parse_mode: string | undefined = "HTML") {
  const m = ({ photo: ["sendPhoto", "photo"], document: ["sendDocument", "document"], video: ["sendVideo", "video"] } as Any)[type] || ["sendPhoto", "photo"];
  return tg(m[0], { chat_id: chat, [m[1]]: file, caption: caption.slice(0, 1024), parse_mode, reply_markup });
}
async function webhookSecret() {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("wh:" + TOKEN));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}
async function settings() { const { data } = await sb.from("settings").select("data").eq("id", 1).single(); return data?.data || {}; }
async function courseById(id: Any) { const { data } = await sb.from("courses").select("id,data").eq("id", id).maybeSingle(); return data ? { ...data.data, id: data.id } : null; }
async function platformButton(st: Any, S: Any, label = "🌐 Platformani ochish") {
  if (!S.siteUrl) return undefined;
  let token = st.login_token;
  if (!token) {
    token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    await sb.from("students").update({ login_token: token }).eq("id", st.id);
  }
  return { inline_keyboard: [[{ text: label, url: String(S.siteUrl).replace(/\/$/, "") + "/?t=" + token }]] };
}

async function requireAdmin(req: Request) {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return adminFromJwt(jwt);
}
async function adminFromJwt(jwt: string) {
  if (!jwt) return null;
  const { data } = await sb.auth.getUser(jwt);
  if (!data?.user) return null;
  const { data: a } = await sb.from("admins").select("user_id").eq("user_id", data.user.id).maybeSingle();
  return a ? data.user : null;
}
async function studentFromToken(token: string | null) {
  if (!token || token.length < 32) return null;
  const { data } = await sb.from("students").select("*").eq("login_token", token).maybeSingle();
  return data;
}

// ---------- database events -> Telegram ----------
async function onEvent(e: Any) {
  const S = await settings(), n = e.new, o = e.old;

  if (e.table === "homework" && e.op === "UPDATE") {
    const { data: st } = await sb.from("students").select("*").eq("id", n.student_id).single();
    if (!st?.tg_id) return;
    const c = await courseById(n.course_id), l = lessonsOf(c).find((x: Any) => x.id == n.lesson_id);
    const title = l ? `«${esc(l.title)}»` : "Vazifangiz";
    if (o.status === n.status) {
      if (n.fix_image && n.status !== "pending") await sendMedia(st.tg_id, "photo", n.fix_image, `🖋 Ustoz ${title} bo'yicha xatolarni belgilab yubordi.`);
      return;
    }
    let text = "";
    if (n.status === "accepted") text = `✅ ${title} vazifangiz qabul qilindi!\n⭐ Baho: <b>${n.score ?? "—"}</b>${n.comment ? "\n💬 Ustoz: " + esc(n.comment) : ""}\n\nKeyingi dars ochildi — davom eting! 🚀`;
    else if (n.status === "rejected") text = `↩️ ${title} vazifangizni qayta topshiring.${n.comment ? "\n💬 Ustoz: " + esc(n.comment) : ""}\n\nTayyor bo'lgach «📝 Vazifa yuborish» tugmasini bosing.`;
    if (!text) return;
    const kb = n.status === "accepted" ? await platformButton(st, S, "▶️ Keyingi darsni ochish") : undefined;
    if (n.fix_image) await sendMedia(st.tg_id, "photo", n.fix_image, text, kb);
    else await send(st.tg_id, text, kb);
    if (n.via !== "telegram" && n.admin_msg_id && S.adminChatId)
      await tg("editMessageReplyMarkup", { chat_id: S.adminChatId, message_id: n.admin_msg_id, reply_markup: { inline_keyboard: [[{ text: n.status === "accepted" ? `✅ ${n.score} ball (platformada)` : "↩️ Qaytarilgan (platformada)", callback_data: "noop" }]] } });
    return;
  }

  if (e.table === "payments" && e.op === "UPDATE") {
    const { data: st } = await sb.from("students").select("*").eq("id", n.student_id).single();
    if (!st?.tg_id) return;
    const c = await courseById(n.course_id);
    if (n.status === "confirmed") await send(st.tg_id, n.part === 1
      ? `✅ 1-qism to'lovingiz tasdiqlandi (${money(n.amount)}).\n🎓 «${esc(c?.title)}» kursining birinchi yarmi (${halfCount(c)} ta dars) ochildi.\n\nQolgan darslar uchun keyinroq «💳 To'lov» orqali 2-qismni to'laysiz.`
      : `✅ ${n.part === 2 ? "2-qism to'lovingiz" : "To'lovingiz"} tasdiqlandi (${money(n.amount)}).\n🎓 «${esc(c?.title)}» kursi ${n.part === 2 ? "to'liq " : ""}ochildi — omad!`, await platformButton(st, S, "▶️ Darslarni boshlash"));
    else if (n.status === "rejected") await send(st.tg_id, `❌ «${esc(c?.title)}» uchun to'lovingiz tasdiqlanmadi.\nSavollar bo'lsa «🆘 Support» orqali yozing.`);
    if (n.via !== "telegram" && n.admin_msg_id && S.adminChatId)
      await tg("editMessageReplyMarkup", { chat_id: S.adminChatId, message_id: n.admin_msg_id, reply_markup: { inline_keyboard: [[{ text: n.status === "confirmed" ? "✅ Tasdiqlangan (platformada)" : "❌ Rad etilgan (platformada)", callback_data: "noop" }]] } });
    return;
  }

  if (e.table === "messages" && e.op === "INSERT") {
    const { data: t } = await sb.from("tickets").select("student_id").eq("id", n.ticket_id).single();
    const { data: st } = await sb.from("students").select("tg_id").eq("id", t?.student_id).single();
    if (!st?.tg_id) return;
    const cap = n.text ? `💬 <b>Ustoz:</b> ${esc(n.text)}` : "💬 <b>Ustoz</b>";
    if (n.image) await sendMedia(st.tg_id, "photo", n.image, cap);
    else if (n.file_id) await sendMedia(st.tg_id, n.file_type, n.file_id, cap);
    else await send(st.tg_id, cap);
    return;
  }

  if (e.table === "students" && e.op === "UPDATE") {
    if (!n.tg_id) return;
    const oa = o.access || {}, na = n.access || {};
    for (const cid of Object.keys(na)) {
      const was = !!oa[cid]?.open, is = !!na[cid]?.open;
      if (was === is) continue;
      if (is) {
        // a just-confirmed payment already told the student
        const since = new Date(Date.now() - 5 * 60e3).toISOString();
        const { data: p } = await sb.from("payments").select("id").eq("student_id", n.id).eq("course_id", cid).neq("status", "rejected").or(`reviewed_at.is.null,reviewed_at.gt.${since}`).limit(1);
        if (p?.length) continue;
      }
      const c = await courseById(cid);
      if (is) await send(n.tg_id, `🔓 «${esc(c?.title)}» kursiga kirish ochildi!`, await platformButton(n, S, "▶️ Darslarni boshlash"));
      else await send(n.tg_id, `🔒 «${esc(c?.title)}» kursiga kirish yopildi. Savollar bo'lsa «🆘 Support» orqali yozing.`);
    }
    return;
  }

  if (e.table === "announcements" && e.op === "INSERT") {
    const c = n.course_id ? await courseById(n.course_id) : null;
    const { data: all } = await sb.from("students").select("id,tg_id,access,login_token").not("tg_id", "is", null);
    const list = (all || []).filter((s: Any) => n.audience === "students" ? s.access?.[n.course_id]?.open : n.audience === "leads" ? !s.access?.[n.course_id] : true);
    const bot = S.bot;
    const cta = c && bot ? { inline_keyboard: [[{ text: c.type === "free" ? "🎁 Bepul boshlash" : "📚 Kursga yozilish", url: `https://t.me/${bot}?start=${c.type === "free" ? "free" : "buy"}_${c.id}` }]] } : undefined;
    const image = n.image || c?.coverImage;
    const deliver = async (chat: Any, kb: Any) => {
      const long = (n.text || "").length > 1024;
      if (image) {
        const r = await sendMedia(chat, "photo", image, long ? "" : n.text || "", long ? undefined : kb, undefined);
        if (long && r) return tg("sendMessage", { chat_id: chat, text: n.text, reply_markup: kb, disable_web_page_preview: true });
        return r;
      }
      return tg("sendMessage", { chat_id: chat, text: n.text || "", reply_markup: kb, disable_web_page_preview: true });
    };
    let reach = 0;
    for (const s of list) {
      const kb = n.audience === "students" ? await platformButton(s, S) : cta;
      if (await deliver(s.tg_id, kb)) reach++;
      await new Promise((r) => setTimeout(r, 40));
    }
    let channelOk = null;
    if ((n.channels || []).includes("channel") && channelChat(S)) channelOk = !!(await deliver(channelChat(S), cta));
    await sb.from("announcements").update({ reach, status: channelOk === false ? "channel_failed" : "sent" }).eq("id", n.id);
  }
}

// ---------- student cabinet ----------
const PUBLIC_KEYS = ["name", "letter", "tagline", "teacher", "teacherBio", "bot", "channel", "accent", "wmName", "wmPhone", "wmOpacity", "dailyGoal", "leaderboard", "siteUrl"];
const pick = (o: Any, keys: string[]) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const shortName = (n: string) => { const [a, b] = String(n || "").split(" "); return b ? `${a} ${b[0]}.` : a || "O'quvchi"; };

async function studentState(st: Any) {
  const S = await settings();
  const { data: rows } = await sb.from("courses").select("id,data");
  const access = st.access || {};
  const courses = (rows || []).map((r: Any) => ({ ...r.data, id: r.id })).filter((c: Any) => c.status === "published" || access[c.id]).map((c: Any) => {
    const a = access[c.id], reach = reachIdx(c, a?.done || []);
    let i = 0;
    return { ...c, modules: (c.modules || []).map((m: Any) => ({ ...m, lessons: (m.lessons || []).map((l: Any) => {
      const idx = i++, open = a?.open && (c.drip === "open" || idx <= reach) && (!a.half || idx < halfCount(c));
      return open || l.preview ? l : { ...l, video: "", resources: [] };
    }) })) };
  });
  const lessonIds = courses.flatMap((c: Any) => lessonsOf(c).map((l: Any) => l.id));
  const [{ data: payments }, { data: mine }, { data: gallery }, { data: act }, { data: notes }, { data: people }] = await Promise.all([
    sb.from("payments").select("*").eq("student_id", st.id),
    sb.from("homework").select("*").eq("student_id", st.id),
    lessonIds.length ? sb.from("homework").select("id,student_id,course_id,lesson_id,status,score,comment,file_id,file_type,created_at,attempt,via").eq("status", "accepted").in("lesson_id", lessonIds).order("created_at", { ascending: false }).limit(300) : Promise.resolve({ data: [] }),
    sb.from("activity").select("day,minutes").eq("student_id", st.id).gte("day", new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)),
    sb.from("notes").select("lesson_id,text").eq("student_id", st.id),
    S.leaderboard !== false ? sb.from("students").select("id,name,access") : Promise.resolve({ data: [] })
  ]);
  const days = Array.from({ length: 7 }, (_, i) => new Date(Date.now() - (6 - i) * 864e5).toISOString().slice(0, 10));
  const activity = days.map((d) => (act || []).find((a: Any) => a.day === d)?.minutes || 0);
  const seen = new Map<number, Any>();
  const homework = [...(mine || []), ...(gallery || []).filter((g: Any) => g.student_id !== st.id)];
  let board: Any[] = [];
  if (S.leaderboard !== false) {
    const { data: acc } = await sb.from("homework").select("student_id,score").eq("status", "accepted");
    const pts = new Map<number, number>();
    for (const h of acc || []) pts.set(h.student_id, (pts.get(h.student_id) || 0) + (h.score || 0));
    board = (people || []).map((p: Any) => ({ id: p.id, name: shortName(p.name), pts: (pts.get(p.id) || 0) + Object.values(p.access || {}).reduce((a: number, v: Any) => a + (v.done || []).length * 10, 0) }))
      .sort((a: Any, b: Any) => b.pts - a.pts).slice(0, 20);
    if (!board.some((b) => b.id === st.id)) board.push({ id: st.id, name: shortName(st.name), pts: 0 });
  }
  for (const p of people || []) seen.set(p.id, p);
  const authorIds = [...new Set(homework.map((h: Any) => h.student_id))];
  const others = authorIds.filter((id) => id !== st.id).map((id) => ({ id, name: shortName(seen.get(id)?.name || ""), phone: "", tg: "", access: {}, joined: st.joined, lastActive: st.joined }));
  await sb.from("students").update({ last_active: new Date().toISOString() }).eq("id", st.id);
  return {
    settings: pick(S, PUBLIC_KEYS), courses, payments, homework, activity, board,
    notes: Object.fromEntries((notes || []).map((n: Any) => [`${st.id}_${n.lesson_id}`, n.text])),
    me: { id: st.id, name: st.name, phone: st.phone || "", tg: st.tg_username || "", joined: st.joined, lastActive: st.last_active, access },
    others
  };
}
async function studentAction(st: Any, b: Any) {
  const access = st.access || {};
  if (b.type === "note") {
    await sb.from("notes").upsert({ student_id: st.id, lesson_id: b.lid, text: String(b.text || "").slice(0, 5000) });
    return { ok: true };
  }
  const c = await courseById(b.cid);
  if (!c) return { error: "Kurs topilmadi" };
  if (b.type === "free") {
    if (c.type !== "free" || c.status !== "published" || c.enrollment !== "open") return { error: "Bu kursga hozir yozilib bo'lmaydi" };
    access[c.id] = { open: true, done: access[c.id]?.done || [] };
    await sb.from("students").update({ access }).eq("id", st.id);
    return { ok: true, access };
  }
  if (b.type === "done") {
    const a = access[c.id], ls = lessonsOf(c), idx = ls.findIndex((l: Any) => l.id == b.lid), l = ls[idx];
    if (!a?.open || !l) return { error: "Kirish yo'q" };
    if (l.homework) return { error: "Bu dars vazifa qabul qilingach yakunlanadi" };
    if (!(c.drip === "open" || idx <= reachIdx(c, a.done || [])) || (a.half && idx >= halfCount(c))) return { error: "Dars hali ochilmagan" };
    if (!a.done.includes(l.id)) a.done.push(l.id);
    await sb.from("students").update({ access }).eq("id", st.id);
    const day = new Date().toISOString().slice(0, 10), mins = parseInt(l.duration) || 10;
    const { data: cur } = await sb.from("activity").select("minutes").eq("student_id", st.id).eq("day", day).maybeSingle();
    await sb.from("activity").upsert({ student_id: st.id, day, minutes: (cur?.minutes || 0) + mins });
    return { ok: true, access };
  }
  return { error: "Noma'lum amal" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url), path = url.pathname.replace(/^.*\/api/, "");
  try {
    if (path === "/event") {
      const { data } = await sb.from("internal_config").select("value").eq("key", "secret").single();
      if (!data || req.headers.get("x-internal") !== data.value) return json({ error: "forbidden" }, 403);
      await onEvent(await req.json());
      return json({ ok: true });
    }

    if (path === "/public") {
      const S = await settings();
      return json(pick(S, ["name", "letter", "tagline", "bot", "accent", "logoImage", "siteUrl"]));
    }

    if (path === "/setup") {
      // Anyone may refresh the webhook (it only points at our own function); settings in the
      // response are for admins only.
      const admin = await requireAdmin(req);
      if (!TOKEN) return json({ error: "TELEGRAM_BOT_TOKEN topilmadi. Supabase → Edge Functions → Secrets bo'limini tekshiring." }, 400);
      const me = await tg("getMe");
      if (!me) return json({ error: "Bot tokeni noto'g'ri. BotFather'dagi tokenni qayta tekshiring." }, 400);
      const hook = await tg("setWebhook", { url: `${URL_BASE}/functions/v1/telegram-bot`, secret_token: await webhookSecret(), allowed_updates: ["message", "callback_query", "my_chat_member"] });
      await tg("setMyCommands", { commands: [{ command: "start", description: "Bosh menyu" }] });
      const S = await settings();
      let channelAdmin = false, channelError = "";
      if (channelChat(S)) {
        const cm = await tg("getChatMember", { chat_id: channelChat(S), user_id: me.id });
        channelAdmin = !!cm && (cm.status === "creator" || (cm.status === "administrator" && cm.can_post_messages !== false));
        if (!cm) channelError = "Kanal topilmadi yoki bot unda yo'q";
      } else if (S.channel) channelError = "Yopiq kanal: botni kanalga admin qiling yoki kanaldan postni botga forward qiling";
      const next = { ...S, bot: me.username, botName: me.first_name, botConnected: !!hook, channelAdmin };
      await sb.from("settings").update({ data: next, updated_at: new Date().toISOString() }).eq("id", 1);
      if (!admin) return json({ ok: true, bot: me.username, webhook: !!hook });
      return json({ ok: true, bot: me.username, webhook: !!hook, channelAdmin, channelError, settings: next });
    }

    if (path === "/file") {
      const auth = url.searchParams.get("auth") || "";
      const ok = (await studentFromToken(auth)) || (await adminFromJwt(auth));
      if (!ok) return new Response("forbidden", { status: 403, headers: CORS });
      const f = await tg("getFile", { file_id: url.searchParams.get("id") });
      if (!f?.file_path) return new Response("not found", { status: 404, headers: CORS });
      const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.file_path}`);
      return new Response(r.body, { headers: { ...CORS, "content-type": r.headers.get("content-type") || "application/octet-stream", "cache-control": "private, max-age=86400" } });
    }

    if (path.startsWith("/student/")) {
      const st = await studentFromToken(req.headers.get("x-student-token"));
      if (!st) return json({ error: "Kirish havolasi eskirgan. Botda «🌐 Platforma» tugmasini qayta bosing." }, 401);
      if (path === "/student/state") return json(await studentState(st));
      if (path === "/student/action") return json(await studentAction(st, await req.json()));
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Any)?.message || e) }, 500);
  }
});
