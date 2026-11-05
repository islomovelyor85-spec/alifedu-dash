// Meta naming parser.
// Spec convention:
//   Campaign COURSE_GOAL       e.g. SMM_CONV, IELTS_KIDS_LEAD (goal = last token)
//   Adset    BRANCH_AUDIENCE   e.g. CHILONZOR_BROAD          (branch = first token)
//   Ad       CR##_TYPE_OFFER_V# e.g. CR14_VIDEO_PAIN_V2
// Robbit's own names are also understood: "3 Farg'ona - Parents (All) - 02.04.26", "Namangan - ad-3 - 02.04.26"
// → branch from the first " - " segment when it is a known branch.

const parts = (name: string) => name.trim().toUpperCase().split("_").filter(Boolean);
const TOKEN = /^[A-Z0-9]+$/;

const BRANCHES = ["Toshkent", "Xadra", "Chilonzor", "Farg'ona", "Namangan", "Andijon", "Samarqand", "Navoiy", "Qarshi", "Termiz",
  "Urganch", "Xorazm", "Nukus", "Chimboy", "Sirdaryo", "Buxoro", "Jizzax", "Qo'qon", "Vodiy"];
const norm = (s: string) => s.toLowerCase().replace(/[‘’ʻʼ`´]/g, "'").replace(/[^a-z']/g, "");
const BRANCH_BY_KEY = new Map(BRANCHES.map((b) => [norm(b), b.toUpperCase()]));

// "3 Farg'ona - Parents …" / "Namangan - ad-3 - …" → "FARG'ONA" / "NAMANGAN".
export function branchFromName(name: string | null | undefined) {
  const first = String(name ?? "").split(/\s+[-–—|]\s+/)[0].replace(/^\s*\d+[.)]?\s*/, "");
  return BRANCH_BY_KEY.get(norm(first)) ?? null;
}

export function parseCampaign(name: string) {
  const p = parts(name);
  if (p.length < 2 || !p.every((t) => TOKEN.test(t))) return { course: null, goal: null, naming_error: true };
  return { course: p.slice(0, -1).join("_"), goal: p[p.length - 1], naming_error: false };
}

export function parseAdset(name: string) {
  const b = branchFromName(name);
  if (b) return { branch: b, audience: name.split(/\s+[-–—|]\s+/)[1]?.trim() ?? null, naming_error: false };
  const p = parts(name);
  if (p.length < 2 || !p.every((t) => TOKEN.test(t))) return { branch: null, audience: null, naming_error: true };
  return { branch: p[0], audience: p.slice(1).join("_"), naming_error: false };
}

const AD = /^CR(\d+)_(IMG|VIDEO|CAROUSEL)_(PAIN|PRICE|OTHER)_V(\d+)$/;

// Ads following Robbit's own naming (branch in the ad or adset name) are not flagged as errors.
export function parseAd(name: string, adsetName?: string) {
  const m = name.trim().toUpperCase().match(AD);
  if (m) return { creative_no: +m[1], type: m[2], offer: m[3], version: +m[4], naming_error: false };
  const known = !!(branchFromName(name) || branchFromName(adsetName));
  return { creative_no: null, type: null, offer: null, version: null, naming_error: !known };
}
