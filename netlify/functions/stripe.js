// netlify/functions/stripe.js
// Actions:
//  - create   : create Stripe Checkout Session
//  - verify   : verify session paid + return metadata
//  - deliver  : email the PDF certificate (Gmail SMTP) if opted-in
//  - subscribe: footer mailing list subscribe (emails you + confirmation email)
//
// Env vars required:
//  STRIPE_SECRET_KEY
//  STRIPE_PRICE_ID
//  SITE_URL
//  GMAIL_USER
//  GMAIL_APP_PASSWORD

const Stripe = require("stripe");
const nodemailer = require("nodemailer");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

const json = (statusCode, data) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  },
  body: JSON.stringify(data),
});

const asStr = (v, max = 200) => {
  if (typeof v !== "string") return "";
  const s = v.trim();
  return s.length > max ? s.slice(0, max) : s;
};

const safeNum = (n, fallback) => {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
};

function looksLikeEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function makeGmailTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user) throw new Error("Missing GMAIL_USER");
  if (!pass) throw new Error("Missing GMAIL_APP_PASSWORD");

  return nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
}

// Generate a simple A4 landscape certificate PDF on the server (so we can attach it to email)
async function generateCertificatePDFBuffer(meta) {
  // A4 landscape points ~ 842 x 595
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([842, 595]);
  const { width, height } = page.getSize();

  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const courier = await pdfDoc.embedFont(StandardFonts.Courier);
  const courierBold = await pdfDoc.embedFont(StandardFonts.CourierBold);

  // Background
  page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(0.06, 0.07, 0.09) });

  // Frame
  page.drawRectangle({
    x: 24,
    y: 24,
    width: width - 48,
    height: height - 48,
    borderColor: rgb(0.9, 0.9, 0.9),
    borderWidth: 2,
  });

  const BRAND = "RANDOM SPOT CERTIFICATE";
  const country = meta.country || "?";
  const mode = meta.mode || "?";
  const seed = meta.seed || "?";
  const lat = meta.lat || "?";
  const lon = meta.lon || "?";
  const tileM = safeNum(meta.tile_m, 1);
  const areaM2 = (tileM * tileM).toFixed(2);
  const issued = new Date().toISOString().slice(0, 10);

  // Title
  page.drawText(BRAND, {
    x: 48,
    y: height - 86,
    size: 28,
    font: helvBold,
    color: rgb(1, 1, 1),
  });

  // Subtitle
  page.drawText(`${country} • ${mode}`, {
    x: 48,
    y: height - 118,
    size: 13,
    font: helv,
    color: rgb(0.8, 0.82, 0.85),
  });

  // Coordinates
  page.drawText(`${lat}, ${lon}`, {
    x: 48,
    y: height - 180,
    size: 22,
    font: courierBold,
    color: rgb(1, 1, 1),
  });

  // Tile
  page.drawText(`Tile: ${tileM} m × ${tileM} m (${areaM2} m²)`, {
    x: 48,
    y: height - 214,
    size: 14,
    font: helv,
    color: rgb(0.9, 0.9, 0.95),
  });

  // Seed
  page.drawText(`Seed: ${seed}`, {
    x: 48,
    y: height - 242,
    size: 11,
    font: courier,
    color: rgb(0.75, 0.78, 0.82),
  });

  // Legal chunk
  const legalLines = [
    "This is a novelty certificate referencing a randomly generated geographic area tile.",
    "No ownership, property rights, access rights, or permissions are granted.",
    "The location may be private, restricted, closed, unsafe, or inaccessible.",
    "If you visit, follow local rules and obtain permission where required.",
    "See the website Terms page for full details.",
  ];

  let y = height - 300;
  for (const line of legalLines) {
    page.drawText(line, {
      x: 48,
      y,
      size: 11,
      font: helv,
      color: rgb(0.7, 0.72, 0.76),
    });
    y -= 18;
  }

  // Footer
  page.drawText(`Issued: ${issued}`, {
    x: 48,
    y: 44,
    size: 10,
    font: helv,
    color: rgb(0.6, 0.62, 0.65),
  });

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID;
  const SITE_URL = process.env.SITE_URL;

  if (!STRIPE_SECRET_KEY) return json(500, { error: "Missing STRIPE_SECRET_KEY" });

  const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

  const q = event.queryStringParameters || {};
  let body = {};
  if (event.httpMethod === "POST") {
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }
  }

  const action = asStr(q.action || body.action, 20);

  try {
    // ---------- CREATE ----------
    if (action === "create") {
      if (!STRIPE_PRICE_ID || !SITE_URL) {
        return json(500, { error: "Missing STRIPE_PRICE_ID or SITE_URL" });
      }

      const country = asStr(body.country, 80) || "NZ";
      const mode = asStr(body.mode, 40) || "publicish";
      const seed = asStr(body.seed, 120) || "";
      const lat = asStr(body.lat, 40) || "";
      const lon = asStr(body.lon, 40) || "";
      const tile_m = asStr(body.tile_m, 12) || "1";

      const email = asStr(body.email || "", 120);
      const email_consent =
        asStr(body.email_consent || "no", 10).toLowerCase() === "yes" ? "yes" : "no";

      const latNum = Number(lat);
      const lonNum = Number(lon);
      const tileNum = Number(tile_m);

      if (
        !Number.isFinite(latNum) ||
        !Number.isFinite(lonNum) ||
        Math.abs(latNum) > 90 ||
        Math.abs(lonNum) > 180
      ) {
        return json(400, { error: "Invalid coordinates" });
      }

      if (!Number.isFinite(tileNum) || tileNum <= 0 || tileNum > 1000) {
        return json(400, { error: "Invalid tile_m" });
      }

      if (email_consent === "yes" && (!email || !looksLikeEmail(email))) {
        return json(400, { error: "Email consent is yes but email is missing/invalid" });
      }

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
        success_url: `${SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${SITE_URL}/cancel.html`,
        allow_promotion_codes: true,
        payment_method_types: ["card"],

        // If opted-in, let Stripe also send the receipt email
        ...(email_consent === "yes" ? { customer_email: email } : {}),

        metadata: {
          country,
          mode,
          seed,
          lat: latNum.toFixed(6),
          lon: lonNum.toFixed(6),
          tile_m: String(tileNum),
          email: email_consent === "yes" ? email : "",
          email_consent,
        },
      });

      return json(200, { url: session.url });
    }

    // ---------- VERIFY ----------
    if (action === "verify") {
      const session_id = asStr(q.session_id || body.session_id, 200);
      if (!session_id || !session_id.startsWith("cs_")) {
        return json(400, { error: "Missing/invalid session_id" });
      }

      const session = await stripe.checkout.sessions.retrieve(session_id);
      const paid = session.payment_status === "paid";
      if (!paid) return json(200, { paid: false, status: session.payment_status });

      return json(200, {
        paid: true,
        status: session.payment_status,
        created: session.created,
        amount_total: session.amount_total,
        currency: session.currency,
        metadata: session.metadata || {},
      });
    }

    // ---------- DELIVER (email the PDF certificate) ----------
    if (action === "deliver") {
      const session_id = asStr(q.session_id || body.session_id, 200);
      if (!session_id || !session_id.startsWith("cs_")) {
        return json(400, { error: "Missing/invalid session_id" });
      }

      // Expand payment_intent so we can set metadata to prevent duplicates
      const session = await stripe.checkout.sessions.retrieve(session_id, {
        expand: ["payment_intent"],
      });

      if (session.payment_status !== "paid") {
        return json(200, { ok: false, delivered: false, message: "Payment not confirmed." });
      }

      const meta = session.metadata || {};
      const consentYes = (meta.email_consent || "").toLowerCase() === "yes";
      const to = asStr(meta.email || "", 120);

      if (!consentYes) {
        return json(200, { ok: true, delivered: false, message: "Email delivery not opted in." });
      }
      if (!to || !looksLikeEmail(to)) {
        return json(200, { ok: false, delivered: false, message: "Missing/invalid email in metadata." });
      }

      const pi = session.payment_intent;
      if (!pi || typeof pi !== "object" || !pi.id) {
        return json(500, { ok: false, delivered: false, message: "Missing payment_intent." });
      }

      const piMeta = pi.metadata || {};
      if ((piMeta.certificate_emailed || "").toLowerCase() === "yes") {
        return json(200, { ok: true, delivered: true, to, message: "Already emailed (idempotent)." });
      }

      const pdfBuf = await generateCertificatePDFBuffer(meta);
      const filename = `certificate-${String(meta.country || "XX").replace(/\s+/g, "_")}-${String(
        meta.seed || "seed"
      ).slice(0, 10)}.pdf`;

      const subject = "Your Random Spot Certificate (PDF)";
      const html = `
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.5">
          <h2 style="margin:0 0 8px">Your certificate is attached</h2>
          <p style="margin:0 0 12px;color:#444">
            Attached is your PDF certificate. Below is the key info + legal notes.
          </p>

          <div style="padding:12px;border:1px solid #eee;border-radius:10px;margin:0 0 12px">
            <div><b>Country:</b> ${meta.country || "?"}</div>
            <div><b>Mode:</b> ${meta.mode || "?"}</div>
            <div><b>Center:</b> ${meta.lat || "?"}, ${meta.lon || "?"}</div>
            <div><b>Tile:</b> ${meta.tile_m || "1"} m × ${meta.tile_m || "1"} m</div>
            <div><b>Seed:</b> ${meta.seed || "?"}</div>
          </div>

          <h3 style="margin:18px 0 6px">Legal info (quick)</h3>
          <ul style="margin:0 0 12px;color:#444">
            <li>This is a novelty certificate referencing a randomly generated geographic area tile.</li>
            <li>No ownership, property rights, access rights, or permissions are granted.</li>
            <li>The location may be private, restricted, closed, unsafe, or inaccessible.</li>
            <li>If you visit, follow local rules and obtain permission where required.</li>
          </ul>

          <p style="margin:0;color:#444">Full terms are on the site’s Terms page.</p>
        </div>
      `;

      const transporter = makeGmailTransporter();
      const fromUser = process.env.GMAIL_USER;

      await transporter.sendMail({
        from: `Random Spot Certificate <${fromUser}>`,
        to,
        subject,
        html,
        attachments: [{ filename, content: pdfBuf, contentType: "application/pdf" }],
      });

      // Mark as sent (prevents re-sends)
      await stripe.paymentIntents.update(pi.id, {
        metadata: {
          ...piMeta,
          certificate_emailed: "yes",
          certificate_emailed_at: new Date().toISOString(),
          certificate_email_to: to,
        },
      });

      return json(200, { ok: true, delivered: true, to });
    }

    // ---------- SUBSCRIBE (footer mailing list) ----------
    if (action === "subscribe") {
      const email = asStr(body.email || "", 120);
      if (!email || !looksLikeEmail(email)) return json(400, { error: "Invalid email" });

      // light anti-bot: if they use obvious temp mail, pretend success so bots don't learn
      const lower = email.toLowerCase();
      const bad = ["mailinator", "tempmail", "guerrillamail", "10minutemail", "yopmail"];
      if (bad.some((w) => lower.includes(w))) {
        return json(200, { ok: true, message: "Subscribed ✅ Check your inbox." });
      }

      const transporter = makeGmailTransporter();
      const fromUser = process.env.GMAIL_USER;

      // 1) Notify you
      await transporter.sendMail({
        from: `Random Spot Certificate <${fromUser}>`,
        to: fromUser,
        subject: `New subscriber: ${email}`,
        text: `New mailing list subscriber:\n\n${email}\n\n(Collected via site footer)\n`,
      });

      // 2) Confirm to subscriber
      await transporter.sendMail({
        from: `Random Spot Certificate <${fromUser}>`,
        to: email,
        subject: "You’re subscribed ✅",
        html: `
          <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.5">
            <h2 style="margin:0 0 8px">You’re in</h2>
            <p style="margin:0 0 12px;color:#444">
              You’ll get occasional updates from Random Spot Certificate.
              No spam — just drops / changes / new ideas.
            </p>
            <p style="margin:0 0 12px;color:#444">
              Unsubscribe: reply to this email with <b>UNSUBSCRIBE</b>.
            </p>
            <p style="margin:0;color:#666;font-size:12px">
              You’re receiving this because you entered your email on the site.
            </p>
          </div>
        `,
      });

      return json(200, { ok: true, message: "Subscribed ✅ Check your inbox." });
    }

    return json(400, { error: "Unknown action. Use ?action=create | verify | deliver | subscribe" });
  } catch (err) {
    return json(500, { error: "Server error", detail: String(err?.message || err) });
  }
};
