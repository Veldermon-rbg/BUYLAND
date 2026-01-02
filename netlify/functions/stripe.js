const Stripe = require("stripe");

const json = (statusCode, data) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  },
  body: JSON.stringify(data)
});

const asStr = (v, max = 200) => {
  if (typeof v !== "string") return "";
  const s = v.trim();
  return s.length > max ? s.slice(0, max) : s;
};

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
    if (action === "create") {
      if (!STRIPE_PRICE_ID || !SITE_URL) {
        return json(500, { error: "Missing STRIPE_PRICE_ID or SITE_URL" });
      }

      const country = asStr(body.country, 80) || "NZ";
      const mode = asStr(body.mode, 40) || "publicish";
      const seed = asStr(body.seed, 120) || "";
      const lat = asStr(body.lat, 40) || "";
      const lon = asStr(body.lon, 40) || "";

      const latNum = Number(lat);
      const lonNum = Number(lon);

      if (!Number.isFinite(latNum) || !Number.isFinite(lonNum) || Math.abs(latNum) > 90 || Math.abs(lonNum) > 180) {
        return json(400, { error: "Invalid coordinates" });
      }

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
        success_url: `${SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${SITE_URL}/cancel.html`,
        allow_promotion_codes: true,
        payment_method_types: ["card"],
        metadata: {
          country,
          mode,
          seed,
          lat: latNum.toFixed(6),
          lon: lonNum.toFixed(6)
        }
      });

      return json(200, { url: session.url });
    }

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
        metadata: session.metadata || {}
      });
    }

    return json(400, { error: "Unknown action. Use ?action=create or ?action=verify" });
  } catch (err) {
    return json(500, { error: "Server error", detail: String(err?.message || err) });
  }
};
