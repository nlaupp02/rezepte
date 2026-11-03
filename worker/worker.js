// Rezepte-KI: kleiner Server für die Rezepte-App (nlaupp02.github.io/rezepte)
// - hält den Claude-API-Schlüssel geheim (Secret ANTHROPIC_API_KEY)
// - lässt nur angemeldete Nutzer der App rein (Firebase-Anmeldung wird geprüft)
// - optional nur bestimmte E-Mail-Adressen (Variable ALLOWED_EMAILS, mit Komma getrennt)
//
// POST /scan  -> leitet die Anfrage an Claude weiter (nur das erlaubte Modell)
// POST /page  -> lädt eine Rezept-Webseite und gibt den Rezepttext zurück (bei Instagram: Beschreibung + Vorschaubild)
// POST /img   -> lädt ein Bild (z. B. Vorschaubild), damit die App es dauerhaft speichern kann

const PROJECT_ID = "rezepte-d507e";
const ALLOWED_ORIGINS = ["https://nlaupp02.github.io"];
const MODEL = "claude-sonnet-5-5";
const MAX_TOKENS_LIMIT = 8000;
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

let jwksCache = null; // { keys, until, missUntil }

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);
    try { return await handle(request, env, origin, cors); }
    catch (e) { return json({ error: "internal", message: String(e && e.message || e).slice(0, 200) }, 500, cors); }
  }
};

async function handle(request, env, origin, cors) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return json({ ok: true, name: "rezepte-ki", key: !!env.ANTHROPIC_API_KEY }, 200, cors);
    }
    if (request.method !== "POST") return json({ error: "method" }, 405, cors);
    if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "origin" }, 403, cors);

    // Anmeldung prüfen
    let user;
    try { user = await verifyFirebaseToken(request.headers.get("Authorization") || ""); }
    catch (e) { return json({ error: "auth", message: String(e.message || e) }, 401, cors); }
    // Nur die eingetragenen E-Mails – ist die Liste leer, darf niemand rein (lieber zu, als offen)
    const allowed = String(env.ALLOWED_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!allowed.length || !allowed.includes(String(user.email || "").toLowerCase())) {
      return json({ error: "not_allowed", message: "Dieses Konto ist nicht freigeschaltet." }, 403, cors);
    }
    // Die E-Mail muss bestätigt sein (bei Google-Anmeldung immer), sonst könnte sich jemand mit fremder Adresse registrieren
    if (user.email_verified !== true) {
      return json({ error: "not_verified", message: "E-Mail-Adresse noch nicht bestätigt." }, 403, cors);
    }

    if (url.pathname === "/scan") return scan(request, env, cors);
    if (url.pathname === "/page") return page(request, cors);
    if (url.pathname === "/img") return img(request, cors);
    return json({ error: "not_found" }, 404, cors);
}

async function scan(request, env, cors) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "no_key", message: "ANTHROPIC_API_KEY fehlt im Worker." }, 500, cors);
  const body = await request.text();
  if (body.length > 20 * 1024 * 1024) return json({ error: "too_big" }, 413, cors);
  // Günstige Prüfung ohne das (große) JSON zu zerlegen: Modell und max_tokens stehen ganz vorne
  const head = body.slice(0, 80);
  const m = head.match(/^\{"model":"([a-z0-9.-]+)","max_tokens":(\d+),"messages":/);
  if (!m || m[1] !== MODEL || Number(m[2]) > MAX_TOKENS_LIMIT) return json({ error: "bad_request", message: "Modell oder Länge nicht erlaubt." }, 400, cors);
  // Diese Schlüssel dürfen nur einmal vorkommen (in Texten stehen Anführungszeichen immer als \" – das zählt hier nicht mit)
  for (const key of ['"model":', '"max_tokens":', '"messages":', '"system":', '"tools":', '"stream":']) {
    const n = body.split(key).length - 1;
    if (n > (key === '"system":' || key === '"tools":' || key === '"stream":' ? 0 : 1)) return json({ error: "bad_request", message: "Anfrage nicht erlaubt." }, 400, cors);
  }
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body
  });
  return new Response(r.body, { status: r.status, headers: { ...cors, "content-type": "application/json" } });
}

const MAX_HTML = 1500000;
const MAX_IMG = 6 * 1024 * 1024;
const UA_MOBILE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const UA_DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const UA_PREVIEW = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
function publicWebUrl(u) {
  if (!/^https?:$/.test(u.protocol)) return false;
  if (u.port && u.port !== "80" && u.port !== "443") return false;
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost") || h === "localhost") return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith("[")) return false; // keine IP-Adressen
  if (u.username || u.password) return false;
  return true;
}
async function readLimited(res, max) {
  const reader = res.body && res.body.getReader();
  if (!reader) return await res.text();
  const dec = new TextDecoder();
  let out = "", got = 0;
  while (got < max) {
    const { value, done } = await reader.read();
    if (done) break;
    got += value.length;
    out += dec.decode(value, { stream: true });
  }
  try { reader.cancel(); } catch (e) { /* egal */ }
  return out.slice(0, max);
}
async function readBytesLimited(res, max) {
  const reader = res.body && res.body.getReader();
  if (!reader) { const b = new Uint8Array(await res.arrayBuffer()); return b.length > max ? null : b; }
  const parts = []; let got = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    got += value.length;
    if (got > max) { try { reader.cancel(); } catch (e) { /* egal */ } return null; }
    parts.push(value);
  }
  const out = new Uint8Array(got); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function attr(tag, name) {
  const m = tag.match(new RegExp("\\s" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')", "i"));
  return m ? (m[1] != null ? m[1] : m[2]) : null;
}
function readMeta(html) {
  const want = ["og:title", "og:description", "og:image", "og:site_name", "description"];
  const meta = {};
  const re = /<meta\s[^>]*>/gi;
  const head = html.slice(0, 400000);
  let m;
  while ((m = re.exec(head))) {
    const key = (attr(m[0], "property") || attr(m[0], "name") || "").toLowerCase();
    if (!want.includes(key) || meta[key]) continue;
    const c = attr(m[0], "content");
    if (c) meta[key] = decodeEntities(c).slice(0, 4000);
  }
  return meta;
}
function htmlToText(html) {
  const t = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ").replace(/<(nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|h\d|div|tr)>/gi, "\n").replace(/<[^>]+>/g, " ");
  return decodeEntities(t).replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
async function fetchHtml(url, ua) {
  const res = await fetch(url, {
    headers: { "user-agent": ua, "accept": "text/html,application/xhtml+xml", "accept-language": "de-DE,de;q=0.9,en;q=0.8" },
    redirect: "follow", signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error("Seite antwortet mit " + res.status);
  return await readLimited(res, MAX_HTML);
}

/* ---------- Instagram: Beschreibung und Vorschaubild eines Reels oder Beitrags ---------- */
function instagramCode(u) {
  const h = u.hostname.toLowerCase().replace(/^(www|m)\./, "");
  if (h !== "instagram.com" && h !== "instagr.am") return null;
  const m = u.pathname.match(/^\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([\w-]{5,})/);
  return m ? m[1] : null;
}
async function instagram(code, original, cors) {
  const [emb, pre] = await Promise.allSettled([
    fetchHtml(`https://www.instagram.com/p/${code}/embed/captioned/`, UA_DESKTOP),
    fetchHtml(`https://www.instagram.com/p/${code}/`, UA_PREVIEW)
  ]);
  let caption = "", user = "", image = "";
  if (emb.status === "fulfilled") {
    const h = emb.value;
    const cap = h.match(/<div class="Caption"[^>]*>([\s\S]*?)<div class="CaptionComments"/i) || h.match(/<div class="Caption"[^>]*>([\s\S]*?)<\/div>/i);
    if (cap) {
      const um = cap[1].match(/class="CaptionUsername"[^>]*>([^<]+)</i);
      if (um) user = decodeEntities(um[1]).trim();
      caption = htmlToText(cap[1].replace(/<a[^>]*class="CaptionUsername"[^>]*>[^<]*<\/a>/i, ""));
    }
    if (!caption) {
      const j = h.match(/"edge_media_to_caption":\{"edges":\[\{"node":\{"text":"((?:[^"\\]|\\.)*)"/);
      if (j) { try { caption = JSON.parse('"' + j[1] + '"'); } catch (e) { /* egal */ } }
    }
    const im = h.match(/<img[^>]+class="EmbeddedMediaImage"[^>]*>/i);
    if (im) { const src = attr(im[0], "src"); if (src) image = decodeEntities(src); }
    if (!user) { const u2 = h.match(/class="UsernameText"[^>]*>([^<]+)</i); if (u2) user = decodeEntities(u2[1]).trim(); }
  }
  let desc = "", title = "";
  if (pre.status === "fulfilled") {
    const meta = readMeta(pre.value);
    desc = meta["og:description"] || meta["description"] || "";
    title = meta["og:title"] || "";
    if (!image && meta["og:image"]) image = meta["og:image"];
    if (!user) { const u3 = (title + " \n " + desc).match(/(?:^|- |\n )@?([\w.]{2,30}) (?:on|auf|am|bei) /i); if (u3) user = u3[1]; }
  }
  // Volle Beschreibung aus dem Einbett-Fenster; die Vorschau-Beschreibung nur, wenn die fehlt oder viel länger ist
  const text = [caption, desc && (caption.length < 40 || desc.length > caption.length + 200) ? "Beschreibung laut Instagram: " + desc : ""].filter(Boolean).join("\n\n").slice(0, 20000);
  if (text.replace(/\s/g, "").length < 20) {
    const why = [emb, pre].map(r => r.status === "rejected" ? String(r.reason && r.reason.message || r.reason) : "").filter(Boolean).join(" / ");
    return json({ error: "instagram_blocked", message: why || "Keine Beschreibung gefunden." }, 502, cors);
  }
  const meta = { "og:site_name": "Instagram", "og:title": title || "Instagram", "og:image": /^https:\/\//.test(image) ? image : "" };
  if (user) meta.user = "@" + user.replace(/^@/, "");
  return json({ kind: "instagram", url: original, meta, data: text }, 200, cors);
}

async function img(request, cors) {
  let target;
  try { target = new URL((await request.json()).url); } catch (e) { return json({ error: "bad_url" }, 400, cors); }
  if (!publicWebUrl(target)) return json({ error: "bad_url" }, 400, cors);
  let res;
  try {
    res = await fetch(target.toString(), { headers: { "user-agent": UA_MOBILE, "accept": "image/webp,image/jpeg,image/png,image/*;q=0.8" }, redirect: "follow", signal: AbortSignal.timeout(12000) });
  } catch (e) { return json({ error: "fetch_failed", message: String(e.message || e) }, 502, cors); }
  if (!res.ok) return json({ error: "fetch_failed", message: "Bild antwortet mit " + res.status }, 502, cors);
  const ct = (res.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
  if (!/^image\/(jpeg|jpg|png|webp|gif|avif|heic)$/.test(ct)) return json({ error: "fetch_failed", message: "Das ist kein Bild." }, 502, cors);
  if (Number(res.headers.get("content-length") || 0) > MAX_IMG) return json({ error: "too_big" }, 413, cors);
  const bytes = await readBytesLimited(res, MAX_IMG);
  if (!bytes) return json({ error: "too_big" }, 413, cors);
  return new Response(bytes, { status: 200, headers: { ...cors, "content-type": ct, "cache-control": "no-store" } });
}

async function page(request, cors) {
  let target;
  try { target = new URL((await request.json()).url); } catch (e) { return json({ error: "bad_url" }, 400, cors); }
  if (!publicWebUrl(target)) return json({ error: "bad_url", message: "Das ist keine normale Webadresse." }, 400, cors);
  const ig = instagramCode(target);
  if (ig) return instagram(ig, target.toString(), cors);
  let res;
  try {
    res = await fetch(target.toString(), {
      headers: {
        "user-agent": UA_MOBILE,
        "accept": "text/html,application/xhtml+xml",
        "accept-language": "de-DE,de;q=0.9,en;q=0.8"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000)
    });
  } catch (e) { return json({ error: "fetch_failed", message: String(e.message || e) }, 502, cors); }
  if (!res.ok) return json({ error: "fetch_failed", message: "Seite antwortet mit " + res.status }, 502, cors);
  const ctype = (res.headers.get("content-type") || "").toLowerCase();
  if (ctype && !/html|xml|text\/plain/.test(ctype)) return json({ error: "fetch_failed", message: "Das ist keine Webseite (" + ctype.split(";")[0] + ")." }, 502, cors);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > 8 * MAX_HTML) return json({ error: "fetch_failed", message: "Die Seite ist zu groß." }, 502, cors);
  const html = await readLimited(res, MAX_HTML);

  const meta = readMeta(html);
  // 1. Strukturierte Rezeptdaten (schema.org/Recipe) – die haben fast alle großen Rezeptseiten
  const recipes = [];
  const reLd = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let mm;
  while ((mm = reLd.exec(html)) && recipes.length < 3) {
    if (!/Recipe/.test(mm[1])) continue;
    try { collectRecipes(JSON.parse(mm[1].trim()), recipes); } catch (e) { /* kaputtes JSON überspringen */ }
  }
  if (recipes.length) {
    return json({ kind: "recipe", url: target.toString(), meta, data: JSON.stringify(recipes[0]).slice(0, 60000) }, 200, cors);
  }
  // 2. Sonst der lesbare Text der Seite
  const text = htmlToText(html).slice(0, 40000);
  return json({ kind: "text", url: target.toString(), meta, data: text }, 200, cors);
}

function collectRecipes(node, out) {
  if (!node || out.length >= 3) return;
  if (Array.isArray(node)) { node.forEach(n => collectRecipes(n, out)); return; }
  if (typeof node !== "object") return;
  const t = node["@type"];
  if (t === "Recipe" || (Array.isArray(t) && t.includes("Recipe"))) {
    const keep = {};
    for (const k of ["name", "description", "recipeYield", "prepTime", "cookTime", "totalTime", "recipeIngredient", "recipeInstructions", "recipeCategory", "recipeCuisine", "author", "image"]) {
      if (node[k] != null) keep[k] = node[k];
    }
    out.push(keep);
    return;
  }
  if (node["@graph"]) collectRecipes(node["@graph"], out);
}

function decodeEntities(s) {
  return s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => cp(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => cp(parseInt(n, 16)));
}
function cp(n) {
  return n > 0 && n <= 0x10FFFF && !(n >= 0xD800 && n <= 0xDFFF) ? String.fromCodePoint(n) : "";
}

/* ---------- Firebase-Anmeldung prüfen (ID-Token, RS256) ---------- */
async function verifyFirebaseToken(authHeader) {
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("kein Token");
  const header = JSON.parse(b64urlText(parts[0]));
  const payload = JSON.parse(b64urlText(parts[1]));
  if (header.alg !== "RS256" || !header.kid) throw new Error("falscher Token-Typ");
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== PROJECT_ID) throw new Error("falsches Projekt");
  if (payload.iss !== "https://securetoken.google.com/" + PROJECT_ID) throw new Error("falscher Aussteller");
  if (!payload.sub || typeof payload.sub !== "string") throw new Error("kein Nutzer");
  if (!(payload.exp > now - 60)) throw new Error("Token abgelaufen");
  if (payload.iat > now + 300) throw new Error("Token aus der Zukunft");
  const key = await getKey(header.kid);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) throw new Error("Signatur ungültig");
  return payload;
}
async function getKey(kid) {
  const now = Date.now();
  if (!jwksCache || jwksCache.until < now || (!jwksCache.keys.some(k => k.kid === kid) && !(jwksCache.missUntil > now))) {
    const r = await fetch(JWKS_URL);
    if (!r.ok) throw new Error("Schlüssel nicht ladbar");
    const data = await r.json();
    const maxAge = Number((r.headers.get("cache-control") || "").match(/max-age=(\d+)/)?.[1] || 3600);
    jwksCache = { keys: data.keys || [], until: now + maxAge * 1000, missUntil: 0 };
  }
  const jwk = jwksCache.keys.find(k => k.kid === kid);
  if (!jwk) { jwksCache.missUntil = now + 60000; throw new Error("unbekannter Schlüssel"); }
  return crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}
function b64urlBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlText(s) { return new TextDecoder().decode(b64urlBytes(s)); }

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, "content-type": "application/json" } });
}
