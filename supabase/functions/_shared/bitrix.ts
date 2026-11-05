// Bitrix24 REST via incoming webhook (env BITRIX_WEBHOOK = https://<portal>/rest/<user>/<key>/).
import { Any, sleep } from "./sync.ts";

const BASE = (Deno.env.get("BITRIX_WEBHOOK") ?? "").replace(/\/+$/, "");

export async function bx(method: string, params: Any = {}, tries = 4): Promise<Any> {
  const res = await fetch(`${BASE}/${method}.json`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const body = await res.json().catch(() => ({}));
  // Portal limit is ~2 req/s; back off on QUERY_LIMIT_EXCEEDED / 503.
  if ((body.error === "QUERY_LIMIT_EXCEEDED" || res.status === 503) && tries > 1) {
    await sleep(1500);
    return bx(method, params, tries - 1);
  }
  if (body.error) throw new Error(`bitrix ${method}: ${body.error} ${body.error_description ?? ""}`);
  return body;
}

// Fast list paging (start=-1, ordered by ID with ">ID" filter): no total count, 50 rows per call.
export async function bxPage(method: string, filter: Any, select: string[], afterId: number) {
  const { result } = await bx(method, {
    order: { ID: "ASC" },
    filter: { ...filter, ">ID": afterId },
    select,
    start: -1,
  });
  await sleep(500);
  return (result ?? []) as Any[];
}
