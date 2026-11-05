// Telegram webhook: registration, courses, payments, homework, support.
// Admin reviews (✅/↩️ buttons, replies) are written to the database; the `api`
// function picks up those changes and notifies students.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// deno-lint-ignore no-explicit-any
type Any = any;
const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const esc = (s: Any) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as Any)[c]);
const money = (n: Any) => Math.round(+n || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " so'm";
const now = () => new Date().toISOString();

async function webhookSecret() {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("wh:" + TOKEN));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}
async function tg(method: string, params: Any = {}) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) });
  const j = await r.json();
  if (!j.ok) console.error(method, j.description);
  return j.result;
}
const send = (chat: Any, text: string, reply_markup?: Any) => tg("sendMessage", { chat_id: chat, text, parse_mode: "HTML", reply_markup, disable_web_page_preview: true });
function sendMedia(chat: Any, type: string, fileId: string, caption: string, reply_markup?: Any) {
  const m = ({ photo: ["sendPhoto", "photo"], document: ["sendDocument", "document"], video: ["sendVideo", "video"] } as Any)[type];
  if (!m) return send(chat, caption, reply_markup);
  return tg(m[0], { chat_id: chat, [m[1]]: fileId, caption: caption.slice(0, 1024), parse_mode: "HTML", reply_markup });
}

const BTN = { courses: "📚 Kurslar", my: "🎓 Kurslarim", hw: "📝 Vazifa yuborish", pay: "💳 To'lov", help: "🆘 Support", site: "🌐 Platforma", phone: "📱 Raqamni yuborish" };
function menu(st: Any) {
  const rows: Any[] = [[{ text: BTN.courses }, { text: BTN.my }], [{ text: BTN.hw }, { text: BTN.pay }], [{ text: BTN.help }, { text: BTN.site }]];
  if (!st?.phone) rows.push([{ text: BTN.phone, request_contact: true }]);
  return { keyboard: rows, resize_keyboard: true };
}
const cancelKb = { inline_keyboard: [[{ text: "❌ Bekor qilish", callback_data: "cancel" }]] };

const ev = (tg_id: number, type: string) => sb.from("bot_events").insert({ tg_id, type });
const lessonsOf = (c: Any) => (c?.modules || []).flatMap((m: Any) => m.lessons || []);
// installments: the first part opens the first half of the lessons
const halfCount = (c: Any) => Math.ceil(lessonsOf(c).length / 2);
const firstPart = (total: number) => Math.ceil(total / 2 / 1000) * 1000;
const PART_LABEL: Any = { 1: " (1-qism)", 2: " (2-qism)" };
async function loadSettings() { const { data } = await sb.from("settings").select("data").eq("id", 1).single(); return data?.data || {}; }
async function loadCourses() { const { data } = await sb.from("courses").select("id,data"); return (data || []).map((r: Any) => ({ ...r.data, id: r.id })); }

async function getStudent(from: Any) {
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || "O'quvchi";
  const { data: st } = await sb.from("students").select("*").eq("tg_id", from.id).maybeSingle();
  if (st) {
    await sb.from("students").update({ last_active: now(), tg_username: from.username || st.tg_username }).eq("id", st.id);
    return st;
  }
  const { data } = await sb.from("students").insert({ tg_id: from.id, tg_username: from.username || null, name }).select().single();
  return data;
}
const setState = (st: Any, state: Any) => sb.from("students").update({ bot_state: state || {} }).eq("id", st.id);

async function platformLink(st: Any, S: Any) {
  if (!S.siteUrl) return null;
  let token = st.login_token;
  if (!token) {
    token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    await sb.from("students").update({ login_token: token }).eq("id", st.id);
    st.login_token = token;
  }
  return String(S.siteUrl).replace(/\/$/, "") + "/?t=" + token;
}
async function sitePrompt(chat: Any, st: Any, S: Any) {
  const url = await platformLink(st, S);
  if (!url) return send(chat, "Platforma manzili hali sozlanmagan. Tez orada ochiladi 🙂", menu(st));
  return send(chat, "🌐 Shaxsiy kabinetingiz: video darslar, vazifalar va sertifikatlar.\n\n<i>Bu havola faqat siz uchun — boshqalarga ulashmang.</i>", { inline_keyboard: [[{ text: "🌐 Platformani ochish", url }]] });
}

async function showCourses(chat: Any, st: Any, courses: Any[]) {
  const list = courses.filter((c) => c.status === "published");
  if (!list.length) return send(chat, "Hozircha kurslar yo'q. E'lonlarni kuting 🔔", menu(st));
  for (const c of list) {
    const a = st.access?.[c.id], has = a?.open, half = has && a.half;
    const price = c.type === "free" ? "🎁 Bepul" : "💰 " + money(c.price) + (c.oldPrice ? ` <s>${money(c.oldPrice)}</s>` : "") + (c.installments ? `\n🧩 yoki 2 qismda: ${money(firstPart(c.price))} + ${money(c.price - firstPart(c.price))}` : "");
    const text = `🖋 <b>${esc(c.title)}</b>\n${esc(c.subtitle || "")}\n\n📚 ${lessonsOf(c).length} ta dars${c.level ? " · " + esc(c.level) : ""}\n${price}\n${half ? "🧩 1-qism to'langan — darslarning yarmi ochiq" : has ? "✅ Siz bu kursdasiz" : c.enrollment === "open" ? "🟢 Qabul ochiq" : "⏳ Qabul yopiq"}`;
    let kb: Any;
    if (half) kb = [[{ text: "▶️ Davom etish", callback_data: "site" }], [{ text: "💳 2-qismni to'lash", callback_data: "buy:" + c.id }]];
    else if (has) kb = [[{ text: "▶️ Davom etish", callback_data: "site" }]];
    else if (c.enrollment === "open") kb = [[c.type === "free" ? { text: "🎁 Bepul boshlash", callback_data: "free:" + c.id } : { text: "💳 Sotib olish", callback_data: "buy:" + c.id }]];
    const markup = kb ? { inline_keyboard: kb } : undefined;
    if (c.coverImage) await tg("sendPhoto", { chat_id: chat, photo: c.coverImage, caption: text.slice(0, 1024), parse_mode: "HTML", reply_markup: markup });
    else await send(chat, text, markup);
  }
}

async function findPromo(code: string, c: Any) {
  const { data } = await sb.from("promos").select("*").eq("code", code.toUpperCase().trim()).maybeSingle();
  if (!data || !data.active || data.used >= data.lim || (data.course_id && data.course_id !== c.id)) return null;
  return data;
}
// mode: "full" | 1 | 2; left empty, an installment course first asks how to pay
async function startBuy(chat: Any, st: Any, c: Any, S: Any, promoCode?: string, mode?: Any) {
  const a = st.access?.[c?.id];
  if (a?.open && a.half) mode = 2;
  if (!c || c.status !== "published" || c.type === "free" || (c.enrollment !== "open" && mode !== 2)) return send(chat, "Bu kursga hozir yozilib bo'lmaydi.", menu(st));
  if (a?.open && !a.half) return send(chat, "Siz allaqachon bu kursdasiz ✅", menu(st));
  if (c.installments && !mode)
    return send(chat, `<b>${esc(c.title)}</b>\nQanday to'laysiz?\n\n🧩 2 qismda to'lasangiz, 1-qismdan keyin darslarning yarmi (${halfCount(c)} ta) ochiladi, 2-qismdan keyin hammasi.`,
      { inline_keyboard: [[{ text: `💰 To'liq — ${money(c.price)}`, callback_data: "buyf:" + c.id }], [{ text: `🧩 2 qismda — ${money(firstPart(c.price))} dan`, callback_data: "buyp:" + c.id }]] });
  let p: Any = promoCode ? await findPromo(promoCode, c) : null, amount: number;
  if (mode === 2) {
    // second part: same promo as the first part, the rest of the total
    const { data: first } = await sb.from("payments").select("amount,promo").eq("student_id", st.id).eq("course_id", c.id).eq("part", 1).eq("status", "confirmed").order("created_at", { ascending: false }).limit(1);
    const prev = first?.[0];
    if (prev?.promo) p = (await sb.from("promos").select("*").eq("code", prev.promo).maybeSingle()).data;
    const total = p ? Math.round(c.price * (1 - p.percent / 100)) : c.price;
    amount = Math.max(0, total - (prev?.amount ?? firstPart(total)));
  } else {
    const total = p ? Math.round(c.price * (1 - p.percent / 100)) : c.price;
    amount = mode === 1 ? firstPart(total) : total;
  }
  const part = mode === 1 || mode === 2 ? mode : null;
  await setState(st, { mode: "pay", cid: c.id, promo: p?.code || null, amount, part });
  const card = S.cardNumber ? `\n\n💳 Karta: <code>${esc(S.cardNumber)}</code>${S.cardHolder ? "\n👤 " + esc(S.cardHolder) : ""}` : "\n\n⚠️ To'lov rekvizitlari hali kiritilmagan — «🆘 Support» orqali so'rang.";
  return send(chat, `<b>${esc(c.title)}</b>${PART_LABEL[part] || ""}\n💰 To'lov summasi: <b>${money(amount)}</b>${p ? ` (promo ${esc(p.code)}: -${p.percent}%)` : ""}${card}\n\nTo'lovni qiling va <b>chek rasmini</b> shu yerga yuboring 👇${p || part === 2 ? "" : "\nPromo-kodingiz bo'lsa, avval uni yozing."}`, cancelKb);
}
async function payChoice(chat: Any, st: Any, courses: Any[]) {
  const half = (c: Any) => st.access?.[c.id]?.open && st.access[c.id].half;
  const list = courses.filter((c) => c.status === "published" && c.type === "paid" && (half(c) || (c.enrollment === "open" && !st.access?.[c.id]?.open)));
  if (!list.length) return send(chat, "Hozircha qabul ochiq pullik kurs yo'q. E'lonlarni kuting 🔔", menu(st));
  return send(chat, "Qaysi kurs uchun to'lov qilasiz?", { inline_keyboard: list.map((c) => [{ text: half(c) ? `${c.title} — 2-qism` : `${c.title} — ${money(c.price)}`, callback_data: "buy:" + c.id }]) });
}

async function startHw(chat: Any, st: Any, courses: Any[], cid?: number, lid?: number) {
  const mine = courses.filter((c) => st.access?.[c.id]?.open);
  if (!mine.length) return send(chat, "Sizda hali ochiq kurs yo'q. «📚 Kurslar» bo'limidan boshlang.", menu(st));
  let c = cid ? mine.find((x) => x.id == cid) : lid ? mine.find((x) => lessonsOf(x).some((l: Any) => l.id == lid)) : null;
  if (!c && mine.length > 1) return send(chat, "Qaysi kurs bo'yicha vazifa yuborasiz?", { inline_keyboard: mine.map((x) => [{ text: x.title, callback_data: "hwc:" + x.id }]) });
  c = c || mine[0];
  const ls = lessonsOf(c), done = st.access[c.id].done || [], limit = st.access[c.id].half ? halfCount(c) : ls.length;
  const l = lid ? ls.find((x: Any) => x.id == lid) : ls.find((x: Any, i: number) => i < limit && !done.includes(x.id) && x.homework);
  if (!l || !l.homework) return send(chat, st.access[c.id].half ? "Ochiq darslardagi vazifalar tugadi 👍 Davom etish uchun «💳 To'lov» orqali 2-qismni to'lang." : "Bu kursda hozircha topshiriladigan vazifa yo'q 👍", menu(st));
  if (ls.indexOf(l) >= limit) return send(chat, "Bu dars 2-qism to'lovidan keyin ochiladi.", menu(st));
  const { data: pend } = await sb.from("homework").select("id").eq("student_id", st.id).eq("lesson_id", l.id).eq("status", "pending").limit(1);
  if (pend?.length) return send(chat, `«${esc(l.title)}» vazifangiz tekshirilmoqda ⏳ Natija shu yerga keladi.`, menu(st));
  await setState(st, { mode: "hw", cid: c.id, lid: l.id });
  return send(chat, `📝 <b>${esc(c.title)}</b> · ${ls.indexOf(l) + 1}-dars: <b>${esc(l.title)}</b>\n\nTopshiriq: ${esc(l.homework)}\n\nIshingizni <b>rasm</b> qilib yuboring (izoh qo'shishingiz mumkin) 👇`, cancelKb);
}

function fileOf(m: Any) {
  if (m.photo) return { id: m.photo[m.photo.length - 1].file_id, type: "photo" };
  if (m.document) return { id: m.document.file_id, type: "document" };
  if (m.video) return { id: m.video.file_id, type: "video" };
  return null;
}
const adminOn = (S: Any) => S.adminChatId && S.tgReview !== false;

// Channels: a private channel has no @username, so we remember its numeric id. It is picked up
// when the bot is made an admin there, or when the admin forwards any post from the channel.
async function linkChannel(chat: Any, S: Any) {
  const me = await tg("getMe");
  const cm = me && await tg("getChatMember", { chat_id: chat.id, user_id: me.id });
  const ok = !!cm && (cm.status === "creator" || (cm.status === "administrator" && cm.can_post_messages !== false));
  const fresh = await loadSettings();
  await sb.from("settings").update({ data: { ...fresh, channelId: chat.id, channelTitle: chat.title || "", channel: chat.username || "", channelAdmin: ok }, updated_at: now() }).eq("id", 1);
  if (S.adminChatId) await send(S.adminChatId, ok
    ? `✅ «${esc(chat.title)}» kanali ulandi. Endi platformadan e'lonlar shu kanalga ham joylanadi.`
    : `⚠️ «${esc(chat.title)}» kanali topildi, lekin bot u yerda post joylay olmaydi. Kanal → Administratorlar → botda «Xabar joylash» huquqini yoqing.`);
  return ok;
}
async function onChatMember(u: Any, S: Any) {
  if (u.chat?.type !== "channel") return;
  const status = u.new_chat_member?.status;
  if (status === "administrator" || status === "creator") return linkChannel(u.chat, S);
  if (String(S.channelId) === String(u.chat.id)) {
    await sb.from("settings").update({ data: { ...(await loadSettings()), channelAdmin: false }, updated_at: now() }).eq("id", 1);
    if (S.adminChatId) await send(S.adminChatId, `⚠️ Bot «${esc(u.chat.title)}» kanalidan chiqarildi yoki admin huquqi olindi. E'lonlar kanalga bormaydi.`);
  }
}

async function onFileOrText(m: Any, st: Any, S: Any, courses: Any[]) {
  const chat = m.chat.id, text = String(m.text || m.caption || "").trim(), file = fileOf(m), state = st.bot_state || {};

  if (state.mode === "pay") {
    const c = courses.find((x) => x.id == state.cid);
    if (!file) {
      if (text && !state.promo && c) {
        const p = await findPromo(text, c);
        if (p) return startBuy(chat, st, c, S, p.code, state.part || "full");
        return send(chat, "Bunday promo-kod topilmadi yoki muddati o'tgan. Chek rasmini yuboring 👇", cancelKb);
      }
      return send(chat, "Iltimos, to'lov <b>chekining rasmini</b> yuboring.", cancelKb);
    }
    await ev(st.tg_id, "payment");
    const { data: p } = await sb.from("payments").insert({ student_id: st.id, course_id: state.cid, amount: state.amount ?? c?.price ?? 0, promo: state.promo, part: state.part || null, method: "Karta (bot)", note: text || null, file_id: file.id, file_type: file.type }).select().single();
    await setState(st, null);
    await send(chat, "✅ Chek qabul qilindi! Tekshirilgach, kurs ochiladi va shu yerda xabar beramiz.", menu(st));
    if (adminOn(S) && p) {
      const msg = await sendMedia(S.adminChatId, file.type, file.id, `💳 <b>Yangi to'lov cheki</b>\n👤 ${esc(st.name)}${st.tg_username ? " (@" + esc(st.tg_username) + ")" : ""}\n📚 ${esc(c?.title)}${PART_LABEL[p.part] || ""}\n💰 ${money(p.amount)}${p.promo ? " · promo " + esc(p.promo) : ""}`,
        { inline_keyboard: [[{ text: "✅ Tasdiqlash", callback_data: "pay_ok:" + p.id }, { text: "❌ Rad etish", callback_data: "pay_no:" + p.id }]] });
      if (msg) await sb.from("payments").update({ admin_msg_id: msg.message_id }).eq("id", p.id);
    }
    return;
  }

  if (state.mode === "hw") {
    if (!file && !text) return;
    if (!file) return send(chat, "Iltimos, ishingizni <b>rasm</b> qilib yuboring (izohni rasm ostiga yozishingiz mumkin).", cancelKb);
    await ev(st.tg_id, "homework");
    const c = courses.find((x) => x.id == state.cid), ls = lessonsOf(c), l = ls.find((x: Any) => x.id == state.lid);
    const { count } = await sb.from("homework").select("id", { count: "exact", head: true }).eq("student_id", st.id).eq("lesson_id", state.lid);
    const { data: h } = await sb.from("homework").insert({ student_id: st.id, course_id: state.cid, lesson_id: state.lid, text: text || null, file_id: file.id, file_type: file.type, attempt: (count || 0) + 1 }).select().single();
    await setState(st, null);
    await send(chat, "✅ Vazifangiz ustozga yuborildi! Baho va izoh shu yerga keladi.", menu(st));
    if (adminOn(S) && h) {
      const msg = await sendMedia(S.adminChatId, file.type, file.id,
        `📝 <b>Yangi vazifa</b>${h.attempt > 1 ? ` (${h.attempt}-urinish)` : ""}\n👤 ${esc(st.name)}${st.tg_username ? " (@" + esc(st.tg_username) + ")" : ""}\n📚 ${esc(c?.title)} · ${ls.indexOf(l) + 1}-dars: ${esc(l?.title)}${h.text ? "\n💬 " + esc(h.text) : ""}\n\n<i>Izoh — shu xabarga matn bilan javob yozing. Tuzatilgan rasm — ustidan chizib, rasmni javob qilib yuboring. Keyin bahoni tanlang.</i>`,
        { inline_keyboard: [[{ text: "✅ 100", callback_data: `hw:${h.id}:100` }, { text: "✅ 90", callback_data: `hw:${h.id}:90` }, { text: "✅ 80", callback_data: `hw:${h.id}:80` }], [{ text: "↩️ Qaytarish", callback_data: `hwr:${h.id}` }]] });
      if (msg) await sb.from("homework").update({ admin_msg_id: msg.message_id }).eq("id", h.id);
    }
    return;
  }

  // everything else goes to support
  if (!text && !file) return;
  await ev(st.tg_id, "support");
  const { data: open } = await sb.from("tickets").select("*").eq("student_id", st.id).eq("status", "open").order("updated_at", { ascending: false }).limit(1);
  let t = open?.[0];
  if (!t) t = (await sb.from("tickets").insert({ student_id: st.id }).select().single()).data;
  else await sb.from("tickets").update({ updated_at: now() }).eq("id", t.id);
  const { data: msgRow } = await sb.from("messages").insert({ ticket_id: t.id, sender: "student", text: text || null, file_id: file?.id || null, file_type: file?.type || null }).select().single();
  if (state.mode !== "support") {
    await setState(st, { mode: "support" });
    await send(chat, "📨 Xabaringiz ustozga yetkazildi. Javobni shu yerda olasiz.", menu(st));
  }
  if (S.adminChatId && msgRow) {
    const cap = `🆘 <b>${esc(st.name)}</b>${st.tg_username ? " (@" + esc(st.tg_username) + ")" : ""}:\n${esc(text)}\n\n<i>Javob berish uchun shu xabarga javob yozing.</i>`;
    const msg = file ? await sendMedia(S.adminChatId, file.type, file.id, cap) : await send(S.adminChatId, cap);
    if (msg) await sb.from("messages").update({ admin_msg_id: msg.message_id }).eq("id", msgRow.id);
  }
}

// Admin replies to a forwarded homework / support message
async function onAdminReply(m: Any) {
  const rid = m.reply_to_message.message_id, text = String(m.text || m.caption || "").trim(), file = fileOf(m);
  const { data: h } = await sb.from("homework").select("*").eq("admin_msg_id", rid).maybeSingle();
  if (h) {
    if (file?.type === "photo") {
      await sb.from("homework").update({ fix_image: file.id, ...(text ? { comment: text } : {}) }).eq("id", h.id);
      return send(m.chat.id, h.status === "pending" ? "🖋 Tuzatilgan rasm saqlandi — baho bilan birga o'quvchiga boradi. Endi bahoni tanlang ☝️" : "🖋 Tuzatilgan rasm o'quvchiga yuborildi.");
    }
    if (!text) return send(m.chat.id, "Izohni matn qilib yoki tuzatilgan rasmni javob qilib yuboring.");
    await sb.from("homework").update({ comment: text }).eq("id", h.id);
    return send(m.chat.id, h.status === "pending" ? "✍️ Izoh saqlandi. Endi yuqoridagi xabarda bahoni tanlang ☝️" : "✍️ Izoh yangilandi.");
  }
  const { data: sm } = await sb.from("messages").select("ticket_id").eq("admin_msg_id", rid).maybeSingle();
  if (sm) {
    await sb.from("messages").insert({ ticket_id: sm.ticket_id, sender: "admin", text: text || null, file_id: file?.id || null, file_type: file?.type || null });
    await sb.from("tickets").update({ status: "open", updated_at: now() }).eq("id", sm.ticket_id);
    return send(m.chat.id, "✅ Javob o'quvchiga yuborildi.");
  }
  return null;
}

async function grantDone(studentId: number, cid: number, lid: number) {
  const { data } = await sb.from("students").select("access").eq("id", studentId).single();
  const acc = data?.access || {}, a = acc[cid] || { open: true, done: [] };
  if (!a.done.includes(lid)) a.done.push(lid);
  acc[cid] = a;
  await sb.from("students").update({ access: acc }).eq("id", studentId);
}

async function onCallback(q: Any, S: Any, courses: Any[]) {
  const chat = q.message?.chat?.id ?? q.from.id;
  const [act, a1, a2] = String(q.data || "").split(":");
  const answer = (text?: string) => tg("answerCallbackQuery", { callback_query_id: q.id, text });
  const isAdmin = S.adminChatId && String(q.from.id) === String(S.adminChatId);
  const markDone = (label: string) => tg("editMessageReplyMarkup", { chat_id: chat, message_id: q.message.message_id, reply_markup: { inline_keyboard: [[{ text: label, callback_data: "noop" }]] } });

  if (act === "noop") return answer();
  if (["hw", "hwr", "pay_ok", "pay_no"].includes(act)) {
    if (!isAdmin) return answer("Faqat admin uchun");
    if (act === "hw" || act === "hwr") {
      const { data: h } = await sb.from("homework").select("*").eq("id", a1).single();
      if (!h || h.status !== "pending") { await answer("Bu vazifa allaqachon baholangan"); return markDone(h?.status === "accepted" ? `✅ ${h.score} ball` : "↩️ Qaytarilgan"); }
      if (act === "hw") {
        const score = +a2;
        await sb.from("homework").update({ status: "accepted", score, comment: h.comment || (score >= 100 ? "A'lo!" : "Yaxshi ish!"), via: "telegram", reviewed_at: now() }).eq("id", h.id);
        await grantDone(h.student_id, h.course_id, h.lesson_id);
        await answer(`✅ ${score} ball qo'yildi`);
        return markDone(`✅ ${score} ball qo'yildi`);
      }
      await sb.from("homework").update({ status: "rejected", comment: h.comment || "Qayta yozib yuboring.", via: "telegram", reviewed_at: now() }).eq("id", h.id);
      await answer("↩️ Qaytarildi");
      return markDone("↩️ Qaytarildi");
    }
    const { data: p } = await sb.from("payments").select("*").eq("id", a1).single();
    if (!p || p.status !== "pending") { await answer("Bu to'lov allaqachon ko'rib chiqilgan"); return markDone(p?.status === "confirmed" ? "✅ Tasdiqlangan" : "❌ Rad etilgan"); }
    const ok = act === "pay_ok";
    if (ok) {
      const { data: s } = await sb.from("students").select("access").eq("id", p.student_id).single();
      const acc = s?.access || {};
      acc[p.course_id] = { open: true, done: acc[p.course_id]?.done || [], ...(p.part === 1 ? { half: true } : {}) };
      await sb.from("payments").update({ status: "confirmed", via: "telegram", reviewed_at: now() }).eq("id", p.id);
      await sb.from("students").update({ access: acc }).eq("id", p.student_id);
      if (p.promo) { const { data: pr } = await sb.from("promos").select("id,used").eq("code", p.promo).maybeSingle(); if (pr) await sb.from("promos").update({ used: pr.used + 1 }).eq("id", pr.id); }
    } else await sb.from("payments").update({ status: "rejected", via: "telegram", reviewed_at: now() }).eq("id", p.id);
    await answer(ok ? "✅ Tasdiqlandi" : "❌ Rad etildi");
    return markDone(ok ? "✅ Tasdiqlandi — kurs ochildi" : "❌ Rad etildi");
  }

  await answer();
  const st = await getStudent(q.from);
  if (act === "cancel") { await setState(st, null); return send(chat, "Bekor qilindi.", menu(st)); }
  if (act === "site") return sitePrompt(chat, st, S);
  if (act === "buy") return startBuy(chat, st, courses.find((c) => c.id == a1), S);
  if (act === "buyf" || act === "buyp") return startBuy(chat, st, courses.find((c) => c.id == a1), S, undefined, act === "buyp" ? 1 : "full");
  if (act === "hwc") return startHw(chat, st, courses, +a1);
  if (act === "free") {
    const c = courses.find((x) => x.id == a1);
    if (!c || c.type !== "free" || c.status !== "published" || c.enrollment !== "open") return send(chat, "Bu kurs hozir mavjud emas.", menu(st));
    if (!st.access?.[c.id]?.open) {
      const acc = st.access || {};
      acc[c.id] = { open: true, done: acc[c.id]?.done || [] };
      await sb.from("students").update({ access: acc }).eq("id", st.id);
    } else return sitePrompt(chat, st, S);
  }
}

async function onMessage(m: Any, S: Any) {
  if (!m.from || m.chat?.type !== "private") return;
  const chat = m.chat.id, text = String(m.text || "").trim();

  const adminCmd = text.match(/^\/admin\s+(\d{6})$/);
  if (adminCmd) {
    if (adminCmd[1] !== String(S.adminCode)) return send(chat, "Kod noto'g'ri.");
    await sb.from("settings").update({ data: { ...S, adminChatId: m.from.id, adminTg: m.from.username || "" }, updated_at: now() }).eq("id", 1);
    return send(chat, "✅ Siz admin sifatida ulandingiz. Yangi vazifa, chek va savollar shu yerga keladi.");
  }
  const fwd = m.forward_origin?.chat || m.forward_from_chat;
  if (fwd?.type === "channel" && S.adminChatId && String(m.from.id) === String(S.adminChatId)) { await linkChannel(fwd, S); return; }
  if (m.reply_to_message && S.adminChatId && String(m.from.id) === String(S.adminChatId)) {
    const done = await onAdminReply(m);
    if (done !== null) return;
  }

  const st = await getStudent(m.from);
  const courses = await loadCourses();

  if (m.contact) {
    if (m.contact.user_id && m.contact.user_id !== m.from.id) return send(chat, "Iltimos, o'zingizning raqamingizni tugma orqali yuboring.", menu(st));
    await ev(st.tg_id, "contact");
    const phone = "+" + String(m.contact.phone_number).replace(/\D/g, "");
    await sb.from("students").update({ phone }).eq("id", st.id);
    st.phone = phone;
    return send(chat, "✅ Raqamingiz saqlandi. Rahmat!", menu(st));
  }

  if (text.startsWith("/start")) {
    await ev(st.tg_id, "start");
    await setState(st, null);
    const payload = text.split(" ")[1] || "";
    if (payload.startsWith("buy_")) { const [, cid, promo] = payload.split("_"); return startBuy(chat, st, courses.find((c) => c.id == cid), S, promo); }
    if (payload.startsWith("free_")) return onCallback({ id: "0", data: "free:" + payload.slice(5), from: m.from, message: { chat: m.chat } }, S, courses);
    if (payload.startsWith("hw_")) return startHw(chat, st, courses, undefined, +payload.slice(3));
    if (payload === "support" || payload.startsWith("ask_")) { await setState(st, { mode: "support" }); return send(chat, "🆘 Savolingizni yozing — ustoz shu yerda javob beradi.", menu(st)); }
    const first = (m.from.first_name || "").trim();
    return send(chat, `Assalomu alaykum${first ? ", " + esc(first) : ""}! «${esc(S.name || "Xattotlik Akademiyasi")}» botiga xush kelibsiz 👋\n\nBu yerda kurslarga yozilasiz, to'lov va vazifalarni yuborasiz, ustozga savol berasiz.${st.phone ? "" : "\n\nBoshlash uchun pastdagi «📱 Raqamni yuborish» tugmasini bosing."}`, menu(st));
  }
  if (text === BTN.courses) { await ev(st.tg_id, "courses"); await setState(st, null); return showCourses(chat, st, courses); }
  if (text === BTN.pay) { await ev(st.tg_id, "pay"); await setState(st, null); return payChoice(chat, st, courses); }
  if (text === BTN.hw) { await ev(st.tg_id, "hw"); await setState(st, null); return startHw(chat, st, courses); }
  if (text === BTN.site) { await ev(st.tg_id, "site"); return sitePrompt(chat, st, S); }
  if (text === BTN.help) { await ev(st.tg_id, "support"); await setState(st, { mode: "support" }); return send(chat, "🆘 Savolingizni yozing — ustoz shu yerda javob beradi.", menu(st)); }
  if (text === BTN.my) {
    await ev(st.tg_id, "my"); await setState(st, null);
    const mine = courses.filter((c) => st.access?.[c.id]);
    if (!mine.length) return send(chat, "Sizda hali kurs yo'q. «📚 Kurslar» bo'limiga qarang.", menu(st));
    const lines = mine.map((c) => { const a = st.access[c.id], n = lessonsOf(c).length, d = (a.done || []).length; return `${a.open ? "✅" : "🔒"} <b>${esc(c.title)}</b> — ${d}/${n} dars (${n ? Math.round(d / n * 100) : 0}%)${a.half ? " · 🧩 1-qism to'langan" : ""}`; });
    const url = await platformLink(st, S);
    return send(chat, "🎓 <b>Kurslarim</b>\n\n" + lines.join("\n"), url ? { inline_keyboard: [[{ text: "🌐 Platformani ochish", url }]] } : menu(st));
  }
  return onFileOrText(m, st, S, courses);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  if (!TOKEN || req.headers.get("x-telegram-bot-api-secret-token") !== await webhookSecret()) return new Response("forbidden", { status: 403 });
  try {
    const u = await req.json(), S = await loadSettings();
    if (u.callback_query) await onCallback(u.callback_query, S, await loadCourses());
    else if (u.my_chat_member) await onChatMember(u.my_chat_member, S);
    else if (u.message) await onMessage(u.message, S);
  } catch (e) {
    console.error(e);
  }
  return new Response("ok");
});
