// Streams a call recording to the dashboard (admins only). Reads Bitrix only (disk.file.get).
//   GET /call-audio?id=<call_id>   (Authorization: the admin's session)
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { sb } from "../_shared/sync.ts";
import { bx } from "../_shared/bitrix.ts";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-client-info, apikey, content-type" };
const fail = (msg: string, status: number) => new Response(JSON.stringify({ error: msg }), { status, headers: { ...CORS, "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { authorization: req.headers.get("authorization") ?? "" } }, auth: { persistSession: false },
    });
    const { data: isAdmin } = await user.rpc("is_admin");
    if (!isAdmin) return fail("Faqat adminlar uchun", 403);

    const id = new URL(req.url).searchParams.get("id") ?? "";
    const { data: row } = await sb.from("call_log").select("record_file_id").eq("call_id", id).maybeSingle();
    const fileId = row?.record_file_id ?? (await sb.from("call_review").select("record_file_id").eq("call_id", id).maybeSingle()).data?.record_file_id;
    if (!fileId) return fail("Yozuv topilmadi", 404);

    const url = (await bx("disk.file.get", { id: fileId })).result?.DOWNLOAD_URL;
    if (!url) return fail("Bitrix yozuv havolasini bermadi", 404);
    const res = await fetch(url);
    if (!res.ok || !res.body) return fail(`Yozuv ${res.status}`, 502);
    const type = res.headers.get("content-type") ?? "";
    return new Response(res.body, {
      headers: { ...CORS, "content-type": type.startsWith("audio/") ? type : "audio/mpeg", "cache-control": "private, max-age=3600" },
    });
  } catch (e) {
    return fail(String(e), 500);
  }
});
