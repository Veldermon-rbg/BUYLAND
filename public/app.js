// Single frontend file for all pages.
// Minimal UI + Leaflet map + "avoid ocean" checks via OSM Nominatim reverse geocoding.

const STORE_KEY = "rsc_spot_v2";

function $(sel) { return document.querySelector(sel); }
function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }
function fmt6(n){ return Number(n).toFixed(6); }

function setStatus(text, kind="") {
  const el = $("#status");
  if (!el) return;
  el.textContent = text || "";
  el.dataset.kind = kind || "";
  el.style.display = text ? "block" : "none";
}

function saveSpot(spot){ localStorage.setItem(STORE_KEY, JSON.stringify(spot)); }
function loadSpot(){
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || "null"); }
  catch { return null; }
}

// --- RNG / rolling ----------------------------------------------------------

function hashStrToSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i=0;i<str.length;i++){
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed){
  let t = seed >>> 0;
  return function(){
    t += 0x6D2B79F5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const COUNTRY_BOUNDS = {
  NZ: { name:"New Zealand", latMin:-47.5, latMax:-34.0, lonMin:166.0, lonMax:179.8 },
  AU: { name:"Australia",   latMin:-43.8, latMax:-10.0, lonMin:112.0, lonMax:154.0 },
  US: { name:"USA (lower 48)", latMin:24.5, latMax:49.5, lonMin:-125.0, lonMax:-66.5 },
  GB: { name:"United Kingdom", latMin:49.8, latMax:59.0, lonMin:-8.6, lonMax:1.8 },
  JP: { name:"Japan", latMin:30.0, latMax:45.8, lonMin:129.0, lonMax:145.8 }
};

function rollSpot(countryCode, mode, userSeed, rerolls){
  const bounds = COUNTRY_BOUNDS[countryCode] || COUNTRY_BOUNDS.NZ;
  const base = `${countryCode}|${mode}|${userSeed}|${rerolls}`;
  const seed32 = hashStrToSeed(base);
  const rng = mulberry32(seed32);

  const lat = bounds.latMin + rng() * (bounds.latMax - bounds.latMin);
  const lon = bounds.lonMin + rng() * (bounds.lonMax - bounds.lonMin);

  return {
    country: bounds.name,
    countryCode,
    mode,
    lat: Number(lat.toFixed(6)),
    lon: Number(lon.toFixed(6)),
    seed: `${countryCode}-${mode}-${seed32.toString(16)}`,
    rerolls
  };
}

function modeLabel(m){
  if (m === "publicish") return "Publicish (check rules)";
  if (m === "anywhere") return "Anywhere";
  return m || "—";
}

// --- Land / ocean check (best-effort) --------------------------------------
// Nominatim usage notes: keep requests low. We only call it on reroll / init.
// This check is NOT a guarantee of land/ownership/access; it just avoids obvious ocean.

async function reverseCheck(lat, lon) {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("zoom", "10");
  url.searchParams.set("addressdetails", "0");

  const r = await fetch(url.toString(), {
    headers: {
      // Nominatim likes a UA; browsers restrict but Referrer is fine.
      "Accept": "application/json"
    }
  });

  if (!r.ok) throw new Error("Reverse lookup failed");
  const data = await r.json();

  // Heuristics: reject water-like types/categories.
  const type = String(data?.type || "").toLowerCase();
  const category = String(data?.category || "").toLowerCase();

  const waterTypes = new Set([
    "ocean","sea","bay","strait","channel","water","river","lake","reservoir","reef"
  ]);

  const looksWater =
    waterTypes.has(type) ||
    category.includes("water") ||
    category.includes("sea") ||
    type.includes("ocean") ||
    type.includes("sea");

  // Sometimes land returns no useful display_name; treat that as suspicious.
  const display = String(data?.display_name || "").trim();

  const ok = !looksWater && display.length >= 6;

  return {
    ok,
    looksWater,
    place: display || "Unknown",
    rawType: type || "unknown",
    rawCategory: category || "unknown"
  };
}

async function rollUntilLikelyLand({ countryCode, mode, maxAttempts = 8 }) {
  const userSeed = crypto.randomUUID();
  let spot = null;
  let check = null;

  for (let i = 1; i <= maxAttempts; i++) {
    spot = rollSpot(countryCode, mode, userSeed, i);

    try {
      check = await reverseCheck(spot.lat, spot.lon);
      if (mode !== "publicish") break; // in anywhere mode we don't filter hard
      if (check.ok) break;
    } catch {
      // If lookup fails, don’t infinite-loop; accept current after a couple tries.
      if (i >= 3) {
        check = { ok: false, looksWater: false, place: "Lookup unavailable", rawType:"", rawCategory:"" };
        break;
      }
    }
  }

  return { spot, check };
}

// --- Netlify function calls -------------------------------------------------

async function postJSON(url, payload){
  const r = await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify(payload)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || data.message || "Request failed");
  return data;
}
async function getJSON(url){
  const r = await fetch(url);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || data.message || "Request failed");
  return data;
}

// --- Minimal CSS (injected) -------------------------------------------------

function injectCSS(){
  if (document.head.querySelector("style[data-min='1']")) return;

  const style = document.createElement("style");
  style.setAttribute("data-min","1");
  style.textContent = `
    :root{
      --bg:#0b0c10;
      --card:#111318;
      --line:rgba(255,255,255,.08);
      --txt:rgba(255,255,255,.92);
      --muted:rgba(255,255,255,.65);
      --accent:#7c5cff;
      --good:#22c55e;
      --bad:#ef4444;
    }
    *{box-sizing:border-box}
    html,body{margin:0;padding:0;background:var(--bg);color:var(--txt);
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
    }
    a{color:inherit;text-decoration:none}
    .wrap{max-width:980px;margin:0 auto;padding:22px 16px 48px}
    .nav{display:flex;align-items:center;justify-content:space-between;
      padding:10px 12px;border:1px solid var(--line);border-radius:14px;background:rgba(255,255,255,.02);
      position:sticky;top:12px;backdrop-filter: blur(10px);
    }
    .brand{font-weight:900;letter-spacing:.2px;display:flex;gap:10px;align-items:center}
    .badge{font-size:12px;color:var(--muted);border:1px solid var(--line);padding:3px 8px;border-radius:999px}
    .navlinks{display:flex;gap:10px;align-items:center}
    .pill{border:1px solid var(--line);padding:8px 10px;border-radius:12px;color:var(--txt);background:rgba(255,255,255,.03)}
    .pill:hover{border-color:rgba(255,255,255,.14);background:rgba(255,255,255,.05)}
    h1{margin:10px 0 6px;font-size:34px;letter-spacing:-.4px}
    .sub{margin:0;color:var(--muted);line-height:1.5}
    .hero{margin:14px 0 14px}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .grid.single{grid-template-columns:1fr}
    @media(max-width:900px){.grid{grid-template-columns:1fr}}
    .card{border:1px solid var(--line);border-radius:16px;background:var(--card);padding:14px}
    .sectionTitle{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.18em;margin-bottom:10px}
    .field{display:flex;flex-direction:column;gap:6px;margin-top:10px}
    label{font-size:12px;color:var(--muted)}
    select,input{
      background:rgba(255,255,255,.03);
      border:1px solid var(--line);
      color:var(--txt);
      padding:10px 12px;
      border-radius:12px;
      outline:none;
    }
    select:focus,input:focus{border-color:rgba(124,92,255,.35)}
    .hint{margin-top:6px;font-size:12px;color:var(--muted)}
    .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px}
    .btn{border:1px solid var(--line);background:rgba(255,255,255,.03);color:var(--txt);
      padding:10px 12px;border-radius:12px;cursor:pointer;transition:background .15s ease,border-color .15s ease,transform .05s ease
    }
    .btn:hover{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.13)}
    .btn:active{transform:translateY(1px)}
    .btn.primary{border-color:rgba(124,92,255,.35);background:rgba(124,92,255,.14)}
    .btn.good{border-color:rgba(34,197,94,.35);background:rgba(34,197,94,.10)}
    .btn:disabled{opacity:.55;cursor:not-allowed}
    .status{margin-top:12px;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.02);color:var(--muted);display:none}
    .status[data-kind="good"]{border-color:rgba(34,197,94,.35);color:rgba(210,255,226,.92)}
    .status[data-kind="bad"]{border-color:rgba(239,68,68,.35);color:rgba(255,209,218,.92)}
    .mini{margin-top:12px}
    .kv{display:grid;grid-template-columns:90px 1fr;gap:8px 10px}
    .k{font-size:12px;color:var(--muted)}
    .v{font-size:12px;color:rgba(255,255,255,.88);font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;}
    .note{margin-top:12px;color:var(--muted);font-size:12px;line-height:1.5}
    .footer{margin-top:18px;display:flex;gap:10px;align-items:center;color:var(--muted);font-size:12px}
    .dot{opacity:.5}
    .mapCard{padding-bottom:10px}
    #map, #mapSuccess{
      height: 420px;
      border-radius: 14px;
      border: 1px solid var(--line);
      overflow:hidden;
    }
    canvas{
      width:100%;
      height:auto;
      border-radius:14px;
      border:1px solid var(--line);
      background:rgba(0,0,0,.25);
      margin-top:10px;
    }
    .mapFoot{margin-top:8px;color:var(--muted);font-size:12px}
  `;
  document.head.appendChild(style);
}

// --- Leaflet map helpers ----------------------------------------------------

function makeMap(divId, lat, lon) {
  if (!window.L) return null;
  const map = L.map(divId, {
    zoomControl: true,
    attributionControl: true
  }).setView([lat, lon], 12);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  const marker = L.marker([lat, lon]).addTo(map);
  return { map, marker };
}

function updateMap(mapObj, lat, lon) {
  if (!mapObj) return;
  mapObj.map.setView([lat, lon], Math.max(mapObj.map.getZoom(), 12));
  mapObj.marker.setLatLng([lat, lon]);
}

// --- Certificate (PNG) ------------------------------------------------------

function drawCertificatePNG(meta){
  const c = document.createElement("canvas");
  c.width = 1400; c.height = 820;
  const ctx = c.getContext("2d");

  const W = c.width, H = c.height;

  ctx.fillStyle = "#0f1116";
  ctx.fillRect(0,0,W,H);

  // subtle gradient
  const g = ctx.createLinearGradient(0,0,W,H);
  g.addColorStop(0, "rgba(124,92,255,.18)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0,0,W,H);

  // frame
  ctx.strokeStyle = "rgba(255,255,255,.10)";
  ctx.lineWidth = 4;
  roundRect(ctx, 44, 44, W-88, H-88, 26);
  ctx.stroke();

  ctx.fillStyle = "rgba(255,255,255,.92)";
  ctx.font = "900 54px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText("LOCATION CERTIFICATE", 96, 140);

  ctx.fillStyle = "rgba(255,255,255,.70)";
  ctx.font = "650 22px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText(`${meta.country || "?"} • ${modeLabel(meta.mode)}`, 96, 182);

  ctx.fillStyle = "rgba(255,255,255,.92)";
  ctx.font = "900 72px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace";
  ctx.fillText(`${meta.lat || "?"} , ${meta.lon || "?"}`, 96, 304);

  ctx.fillStyle = "rgba(255,255,255,.70)";
  ctx.font = "650 22px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace";
  ctx.fillText(`Seed: ${meta.seed || "—"}`, 96, 354);

  ctx.fillStyle = "rgba(255,255,255,.78)";
  ctx.font = "650 24px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText("Novelty certificate only. No ownership or access rights.", 96, 436);

  ctx.fillStyle = "rgba(255,255,255,.62)";
  ctx.font = "500 20px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  wrapText(ctx,
    "Access varies by local rules, closures, and conditions. Always check at the time of visit. This certificate grants no permissions or guarantees.",
    96, 476, W-192, 26
  );

  ctx.fillStyle = "rgba(255,255,255,.52)";
  ctx.font = "500 16px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace";
  ctx.fillText(`Issued: ${new Date().toISOString().slice(0,10)}`, 96, H-110);

  return c;

  function roundRect(ctx,x,y,w,h,r){
    ctx.beginPath();
    ctx.moveTo(x+r,y);
    ctx.arcTo(x+w,y, x+w,y+h, r);
    ctx.arcTo(x+w,y+h, x,y+h, r);
    ctx.arcTo(x,y+h, x,y, r);
    ctx.arcTo(x,y, x+w,y, r);
    ctx.closePath();
  }
  function wrapText(ctx, text, x, y, maxW, lineH){
    const words = String(text).split(" ");
    let line = "", yy = y;
    for (let i=0;i<words.length;i++){
      const test = line + words[i] + " ";
      if (ctx.measureText(test).width > maxW && i>0){
        ctx.fillText(line, x, yy);
        line = words[i] + " ";
        yy += lineH;
      } else line = test;
    }
    ctx.fillText(line, x, yy);
  }
}

function downloadCanvasPNG(canvas, filename){
  const a = document.createElement("a");
  a.download = filename;
  a.href = canvas.toDataURL("image/png");
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// --- Page controllers -------------------------------------------------------

async function pageIndex(){
  const countryEl = $("#country");
  const modeEl = $("#mode");
  const rerollBtn = $("#reroll");
  const lockBtn = $("#lock");

  const pCoords = $("#pCoords");
  const pSeed = $("#pSeed");
  const pCheck = $("#pCheck");
  const pPlace = $("#pPlace");

  let current = null;
  let currentCheck = null;
  let mapObj = null;

  function render(spot, check) {
    pCoords.textContent = `${fmt6(spot.lat)}, ${fmt6(spot.lon)}`;
    pSeed.textContent = spot.seed;

    if (!check) {
      pCheck.textContent = "—";
      pPlace.textContent = "—";
      return;
    }

    const okText = check.ok ? "Likely land ✅" : (check.looksWater ? "Looks like water ❌" : "Uncertain ⚠️");
    pCheck.textContent = `${okText} (${check.rawType || "?"})`;
    pPlace.textContent = check.place || "Unknown";
  }

  async function rollAndCheck() {
    rerollBtn.disabled = true;
    lockBtn.disabled = true;
    setStatus("Rolling… checking land…");

    const { spot, check } = await rollUntilLikelyLand({
      countryCode: countryEl.value,
      mode: modeEl.value,
      maxAttempts: modeEl.value === "publicish" ? 10 : 3
    });

    current = spot;
    currentCheck = check;

    render(current, currentCheck);

    if (!mapObj && $("#map")) mapObj = makeMap("map", current.lat, current.lon);
    else updateMap(mapObj, current.lat, current.lon);

    if (modeEl.value === "publicish" && check && !check.ok) {
      setStatus("Couldn’t confidently avoid water this time. You can reroll.", "bad");
    } else {
      setStatus("Ready ✅", "good");
    }

    rerollBtn.disabled = false;
    lockBtn.disabled = false;
  }

  rerollBtn.addEventListener("click", rollAndCheck);
  countryEl.addEventListener("change", rollAndCheck);
  modeEl.addEventListener("change", rollAndCheck);

  lockBtn.addEventListener("click", () => {
    if (!current) return;
    saveSpot({ ...current, check: currentCheck || null });
    setStatus("Locked in ✅", "good");
    setTimeout(() => { location.href = "checkout.html"; }, 250);
  });

  await rollAndCheck();
}

function pageCheckout(){
  const spot = loadSpot();
  const wrap = $("#summaryWrap");
  const payBtn = $("#payBtn");

  if (!spot) {
    wrap.innerHTML = `<div class="note"><b>No spot saved.</b> Go back and generate one first.</div>`;
    payBtn.disabled = true;
    setStatus("No saved spot.", "bad");
    return;
  }

  wrap.innerHTML = `
    <div class="mini">
      <div class="kv">
        <div class="k">Country</div><div class="v">${spot.country}</div>
        <div class="k">Mode</div><div class="v">${modeLabel(spot.mode)}</div>
        <div class="k">Coords</div><div class="v">${fmt6(spot.lat)}, ${fmt6(spot.lon)}</div>
        <div class="k">Seed</div><div class="v">${spot.seed}</div>
        <div class="k">Nearby</div><div class="v">${spot.check?.place ? spot.check.place : "—"}</div>
      </div>
    </div>
  `;

  payBtn.addEventListener("click", async () => {
    payBtn.disabled = true;
    payBtn.textContent = "Opening…";
    setStatus("Creating secure checkout…");

    try {
      const data = await postJSON("/api/stripe?action=create", {
        country: spot.country,
        mode: spot.mode,
        seed: spot.seed,
        lat: String(spot.lat),
        lon: String(spot.lon)
      });

      if (!data.url) throw new Error("No checkout URL returned");
      setStatus("Redirecting…", "good");
      location.href = data.url;
    } catch (e) {
      setStatus(`Error: ${e.message}`, "bad");
      payBtn.disabled = false;
      payBtn.textContent = "Pay with Stripe";
    }
  });
}

async function pageSuccess(){
  const url = new URL(location.href);
  const session_id = url.searchParams.get("session_id") || "";
  const dlBtn = $("#downloadBtn");
  const canvas = $("#certPreview");

  dlBtn.disabled = true;

  if (!session_id) {
    setStatus("Missing session_id. This page only works after Stripe redirects here.", "bad");
    return;
  }

  setStatus("Verifying payment…");

  try {
    const data = await getJSON(`/api/stripe?action=verify&session_id=${encodeURIComponent(session_id)}`);
    if (!data.paid) {
      setStatus("Payment not confirmed yet. Refresh in a few seconds.", "bad");
      return;
    }

    const meta = data.metadata || {};
    setStatus("Payment verified ✅", "good");

    $("#metaCountry").textContent = meta.country || "?";
    $("#metaMode").textContent = modeLabel(meta.mode);
    $("#metaCoords").textContent = `${meta.lat || "?"}, ${meta.lon || "?"}`;
    $("#metaSeed").textContent = meta.seed || "?";

    const lat = Number(meta.lat);
    const lon = Number(meta.lon);

    // Map
    if ($("#mapSuccess") && window.L && Number.isFinite(lat) && Number.isFinite(lon)) {
      const m = makeMap("mapSuccess", lat, lon);
      if (m) updateMap(m, lat, lon);
    }

    // Certificate preview
    const cert = drawCertificatePNG(meta);
    const ctx = canvas.getContext("2d");
    canvas.width = cert.width;
    canvas.height = cert.height;
    ctx.drawImage(cert, 0, 0);

    dlBtn.disabled = false;
    dlBtn.addEventListener("click", () => {
      const fn = `certificate-${(meta.country||"XX").replace(/\s+/g,"_")}-${(meta.seed||"seed").slice(0,10)}.png`;
      downloadCanvasPNG(canvas, fn);
    });

  } catch (e) {
    setStatus(`Error: ${e.message}`, "bad");
  }
}

// --- Boot ------------------------------------------------------------------

(function boot(){
  injectCSS();
  const page = document.body.getAttribute("data-page") || "";
  if (page === "index") pageIndex();
  else if (page === "checkout") pageCheckout();
  else if (page === "success") pageSuccess();
})();
