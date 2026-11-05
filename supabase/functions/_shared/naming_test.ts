import { assertEquals } from "jsr:@std/assert@1";
import { parseAd, parseAdset, parseCampaign } from "./naming.ts";

Deno.test("parses valid names", () => {
  assertEquals(parseCampaign("SMM_CONV"), { course: "SMM", goal: "CONV", naming_error: false });
  assertEquals(parseAdset("chilonzor_broad"), { branch: "CHILONZOR", audience: "BROAD", naming_error: false });
  assertEquals(parseAd("CR14_VIDEO_PAIN_V2"), { creative_no: 14, type: "VIDEO", offer: "PAIN", version: 2, naming_error: false });
});

Deno.test("flags bad names", () => {
  assertEquals(parseCampaign("Yangi kampaniya").naming_error, true);
  assertEquals(parseAd("CR14_REELS_PAIN_V2").naming_error, true);
});
