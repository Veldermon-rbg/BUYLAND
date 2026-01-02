// One frontend file for ALL pages.

const STORE_KEY = "rsc_spot_v1";

function $(sel) { return document.querySelector(sel); }
function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }

function setStatus(text, kind="") {
  const el = $("#status");
  if (!el) return;
  el.textContent = text;
  el.style.borderColor = kind === "good" ? "rgba(34,197,94,.5)" : kind === "bad" ? "rgba(239,68,68,.5)" : "rgba(255,255,255,.14)";
  el.style.color = kind === "good" ? "rgba(210,255,226,.95)" : kind === "bad" ? "rgba(255,209,218,.95)" : "rgba(255,255,255,.75)";
  el.style.display = text ? "block" : "none";
}

function saveSpot(spot){
  localStorage.setItem(STORE_KEY, JSON.stringify(spot));
}
function loadSpot(){
  try {
    const s = localStorage.getItem(STORE_KEY);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

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
function fmt6(n){ return Number(n).toFixed(6); }

const COUNTRY_BOUNDS = {
  NZ: { name:"New Zealand", latMin:-47.5, latMax:-34.0, lonMin:166.0, lonMax:179.8 },
  AU: { name:"Australia",   latMin:-43.8, latMax:-10.0, lonMin:112.0, lonMax:154.0 },
  US: { name:"USA (lower 48)", latMin:24.5, latMax:49.5, lonMin:-125.0, lonMax:-66.5 },
  GB: { name:"United Kingdom", latMin:49.8, latMax:59.0, lonMin:-8.6, lonMax:1.8 },
  JP: { name:"Japan", latMin:30.0, latMax:45.8, lonMin:129.0, lonMax:145.8 }
};

// “publicish” mode just tries harder to avoid super-ocean-y vibes. Still not a guarantee.
function oceanishHeuristic(lat, lon) {
  const latScore = 1.0 - Math.abs(lat) / 90;
  const lonScore = 1.0 - (Math.abs((lon % 180)) / 180) * 0.2;
  return clamp(latScore * lonScore, 0, 1);
}
function landBiasAccept(lat, lon, rng) {
  const p = oceanishHeuristic(lat, lon);
  return rng() < clamp(p * 1.15, 0.05, 0.95);
}

function rollSpot(countryCode, mode, userSeed, rerolls){
  const bounds = COUNTRY_BOUNDS[countryCode] || COUNTRY_BOUNDS.NZ;
  const base = `${countryCode}|${mode}|${userSeed}|${rerolls}`;
  const seed32 = hashStrToSeed(base);
  const rng = mulberry32(seed32);

  let lat = 0, lon = 0;
  const maxTries = mode === "publicish" ? 120 : 40;

  for (let i=0;i<maxTries;i++){
    lat = bounds.latMin + rng() * (bounds.latMax - bounds.latMin);
    lon = bounds.lonMin + rng() * (bounds.lonMax - bounds.lonMin);
    if (mode !== "publicish") break;
    if (landBiasAccept(lat, lon, rng)) break;
  }

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

async function postJSON(url, payload){
  const r = await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify(payload)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Request failed");
  return data;
}
async function getJSON(url){
  const r = await fetch(url);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Request failed");
  return data;
}

function baseCSS(){
  // injected into each page so we don’t need a separate CSS file
  return `
  <style>
    :root{
      --bg:#0b0f19; --txt:rgba(255,255,255,.92); --muted:rgba(255,255,255,.68);
      --line:rgba(255,255,255,.14); --card:rgba(255,255,255,.07);
      --accent:#7c5cff; --good:#22c55e; --bad:#ef4444;
    }
    *{box-sizing:border-box}
    html,body{margin:0;padding:0;background:
      radial-gradient(1200px 800px at 20% 10%, rgba(124,92,255,.28), transparent 55%),
      radial-gradient(1200px 800px at 90% 40%, rgba(0,229,255,.18), transparent 55%),
      var(--bg); color:var(--txt);
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
    }
    a{color:inherit;text-decoration:none}
    .wrap{max-width:980px;margin:0 auto;padding:26px 16px 56px}
    .nav{display:flex;align-items:center;justify-content:space-between;
      padding:12px 14px;border:1px solid var(--line);border-radius:14px;
      background:rgba(255,255,255,.04); position:sticky; top:12px; backdrop-filter: blur(10px);
    }
    .brand{display:flex;gap:10px;align-items:center;font-weight:900;letter-spacing:.3px}
    .badge{font-size:12px;padding:3px 8px;border:1px solid var(--line);border-radius:999px;color:var(--muted)}
    .navlinks{display:flex;gap:10px}
    .navlinks a{padding:8px 10px;border-radius:10px;border:1px solid transparent;color:var(--muted)}
    .navlinks a:hover{border-color:var(--line);color:var(--txt);background:rgba(255,255,255,.03)}
    h1{margin:18px 0 6px;font-size:34px}
    p{color:var(--muted);line-height:1.55;margin:8px 0 0}
    .grid{display:grid;grid-template-columns:1.1fr .9fr;gap:14px;margin-top:16px}
    @media(max-width:900px){.grid{grid-template-columns:1fr}}
    .card{border:1px solid var(--line);border-radius:16px;padding:14px;background:var(--card)}
    .card h2{margin:0 0 8px;font-size:16px}
    .field{display:flex;flex-direction:column;gap:6px;margin-top:10px}
    label{font-size:12px;color:var(--muted)}
    select,input{background:rgba(0,0,0,.35);border:1px solid var(--line);color:var(--txt);
      border-radius:12px;padding:10px 12px;outline:none
    }
    small{color:var(--muted)}
    .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:12px}
    .btn{appearance:none;border:1px solid var(--line);background:rgba(255,255,255,.06);color:var(--txt);
      border-radius:12px;padding:10px 12px;cursor:pointer;transition:transform .06s ease, background .2s ease, border-color .2s ease
    }
    .btn:hover{background:rgba(255,255,255,.10);border-color:rgba(255,255,255,.18)}
    .btn:active{transform:translateY(1px)}
    .btn.primary{border-color:rgba(124,92,255,.55);background:rgba(124,92,255,.16)}
    .btn.good{border-color:rgba(34,197,94,.55);background:rgba(34,197,94,.12)}
    .btn:disabled{opacity:.55;cursor:not-allowed}
    .notice{margin-top:10px;padding:10px 12px;border-radius:12px;border:1px solid var(--line);
      background:rgba(255,255,255,.04);color:var(--muted)
    }
    .kv{display:grid;grid-template-columns:140px 1fr;gap:8px 10px;margin-top:8px}
    .k{color:var(--muted);font-size:12px}
    .v{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono",monospace;
      font-size:12px;color:rgba(255,255,255,.88)
    }
    hr{border:0;border-top:1px solid var(--line);margin:14px 0}
    #status{display:none}
    canvas{max-width:100%;border-radius:14px;border:1px solid var(--line);background:rgba(0,0,0,.25)}
  </style>`;
}

function injectCSS(){
  if (document.head.querySelector("style[data-injected='1']")) return;
  const tmp = document.createElement("div");
  tmp.innerHTML = baseCSS();
  const style = tmp.querySelector("style");
  style.setAttribute("data-injected","1");
  document.head.appendChild(style);
}

function drawCertificatePNG(meta){
  const c = document.createElement("canvas");
  c.width = 1400; c.height = 820;
  const ctx = c.getContext("2d");

  const W = c.width, H = c.height;

  // bg
  ctx.fillStyle = "#0f1320";
  ctx.fillRect(0,0,W,H);

  // glow
  const g1 = ctx.createRadialGradient(W*0.18,H*0.18,10,W*0.18,H*0.18,720);
  g1.addColorStop(0,"rgba(124,92,255,.32)");
  g1.addColorStop(1,"rgba(124,92,255,0)");
  ctx.fillStyle = g1; ctx.fillRect(0,0,W,H);

  // frame
  ctx.strokeStyle = "rgba(255,255,255,.12)";
  ctx.lineWidth = 4;
  roundRect(ctx, 40, 40, W-80, H-80, 26);
  ctx.stroke();

  ctx.fillStyle = "rgba(233,236,242,.98)";
  ctx.font = "900 54px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText("CERTIFICATE OF LOCATION REFERENCE", 90, 140);

  ctx.fillStyle = "rgba(167,176,192,.92)";
  ctx.font = "700 22px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText(`${meta.country || "?"} • ${modeLabel(meta.mode)}`, 90, 180);

  ctx.fillStyle = "rgba(233,236,242,.98)";
  ctx.font = "900 72px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace";
  ctx.fillText(`${meta.lat || "?"} , ${meta.lon || "?"}`, 90, 300);

  ctx.fillStyle = "rgba(167,176,192,.92)";
  ctx.font = "650 22px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace";
  ctx.fillText(`Seed: ${meta.seed || "—"}`, 90, 352);

  ctx.fillStyle = "rgba(233,236,242,.92)";
  ctx.font = "650 24px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText("Novelty certificate only. No ownership, permissions, or access rights.", 90, 430);

  ctx.fillStyle = "rgba(167,176,192,.86)";
  ctx.font = "500 20px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  wrapText(ctx,
    "Public access varies by location and circumstances. Always check local rules and conditions at time of visit. This product does not grant any rights or guarantees.",
    90, 470, W-180, 26
  );

  // stamp
  ctx.save();
  ctx.translate(W-260, H-210);
  ctx.rotate(-0.10);
  ctx.strokeStyle = "rgba(124,92,255,.60)";
  ctx.lineWidth = 7;
  roundRect(ctx, -170, -85, 340, 170, 22);
  ctx.stroke();
  ctx.fillStyle = "rgba(124,92,255,.16)";
  roundRect(ctx, -170, -85, 340, 170, 22);
  ctx.fill();
  ctx.fillStyle = "rgba(233,236,242,.95)";
  ctx.font = "900 28px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText("ISSUED", -62, 12);
  ctx.restore();

  ctx.fillStyle = "rgba(167,176,192,.65)";
  ctx.font = "500 16px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace";
  ctx.fillText(`Issued: ${new Date().toISOString().slice(0,10)}`, 90, H-110);

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

function modeLabel(m){
  if (m === "publicish") return "May be public / may be accessible (check rules)";
  if (m === "anywhere") return "Anywhere (may be private/restricted)";
  return m || "—";
}

function downloadCanvasPNG(canvas, filename){
  const a = document.createElement("a");
  a.download = filename;
  a.href = canvas.toDataURL("image/png");
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------------- Page controllers ----------------

function pageIndex(){
  const countryEl = $("#country");
  const modeEl = $("#mode");
  const rerollBtn = $("#reroll");
  const lockBtn = $("#lock");

  const pCountry = $("#pCountry");
  const pMode = $("#pMode");
  const pLat = $("#pLat");
  const pLon = $("#pLon");
  const pSeed = $("#pSeed");
  const pRerolls = $("#pRerolls");

  let userSeed = crypto.randomUUID();
  let rerolls = 0;
  let current = null;

  function render(spot){
    pCountry.textContent = spot.country;
    pMode.textContent = modeLabel(spot.mode);
    pLat.textContent = fmt6(spot.lat);
    pLon.textContent = fmt6(spot.lon);
    pSeed.textContent = spot.seed;
    pRerolls.textContent = String(spot.rerolls);
  }

  function roll(){
    rerolls += 1;
    current = rollSpot(countryEl.value, modeEl.value, userSeed, rerolls);
    render(current);
    setStatus("Rolled ✅", "good");
  }

  rerollBtn.addEventListener("click", roll);
  countryEl.addEventListener("change", () => { rerolls = 0; userSeed = crypto.randomUUID(); roll(); });
  modeEl.addEventListener("change", () => { rerolls = 0; userSeed = crypto.randomUUID(); roll(); });

  lockBtn.addEventListener("click", () => {
    if (!current) roll();
    saveSpot(current);
    setStatus("Saved for checkout ✅", "good");
    setTimeout(() => { location.href = "checkout.html"; }, 250);
  });

  // initial
  roll();
}

function pageCheckout(){
  const spot = loadSpot();
  const wrap = $("#summaryWrap");
  const payBtn = $("#payBtn");

  if (!spot) {
    wrap.innerHTML = `<div class="notice"><b>No spot saved.</b> Go back and generate one first.</div>`;
    payBtn.disabled = true;
    setStatus("No saved spot.", "bad");
    return;
  }

  $("#sumCountry").textContent = spot.country;
  $("#sumMode").textContent = modeLabel(spot.mode);
  $("#sumLat").textContent = fmt6(Number(spot.lat));
  $("#sumLon").textContent = fmt6(Number(spot.lon));
  $("#sumSeed").textContent = spot.seed;

  payBtn.addEventListener("click", async () => {
    payBtn.disabled = true;
    payBtn.textContent = "Opening checkout…";
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
      setStatus("Redirecting to Stripe…", "good");
      location.href = data.url;
    } catch (e) {
      setStatus(`Error: ${e.message}`, "bad");
      payBtn.disabled = false;
      payBtn.textContent = "Pay with Stripe";
    }
  });
}

function pageSuccess(){
  const url = new URL(location.href);
  const session_id = url.searchParams.get("session_id") || "";

  const dlBtn = $("#downloadBtn");
  const canvas = $("#certPreview");

  dlBtn.disabled = true;

  if (!session_id) {
    setStatus("Missing session_id. This page only works after Stripe redirects here.", "bad");
    return;
  }

  (async () => {
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
      $("#metaLat").textContent = meta.lat || "?";
      $("#metaLon").textContent = meta.lon || "?";
      $("#metaSeed").textContent = meta.seed || "?";

      // Draw preview
      const cert = drawCertificatePNG(meta);
      const ctx = canvas.getContext("2d");
      canvas.width = cert.width;
      canvas.height = cert.height;
      ctx.drawImage(cert, 0, 0);

      dlBtn.disabled = false;
      dlBtn.addEventListener("click", () => {
        downloadCanvasPNG(canvas, `certificate-${(meta.country||"XX").replace(/\s+/g,"_")}-${(meta.seed||"seed").slice(0,10)}.png`);
      });
    } catch (e) {
      setStatus(`Error: ${e.message}`, "bad");
    }
  })();
}

// ---------------- Boot ----------------
(function boot(){
  injectCSS();
  const page = document.body.getAttribute("data-page") || "";
  if (page === "index") pageIndex();
  else if (page === "checkout") pageCheckout();
  else if (page === "success") pageSuccess();
})();
