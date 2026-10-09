// api/index.js
// Private OpenSky Network API wrapper
// Creator: Aritra Nath (@its_aritra_nath)

const TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const STATES_URL = "https://opensky-network.org/api/states/all";

const CREATOR = {
  name: "Aritra Nath",
  instagram: "@its_aritra_nath",
  instagram_url: "https://instagram.com/its_aritra_nath",
};

/* ----------------------------------------------------------------
   Helper: Vercel can turn a duplicated query param into an array.
   This grabs the first value safely.
----------------------------------------------------------------- */
function firstVal(v) {
  if (Array.isArray(v)) return v[0];
  return v;
}

/* ----------------------------------------------------------------
   Token cache — survives while the serverless instance stays warm
----------------------------------------------------------------- */
let tokenCache = { value: null, expiresAt: 0 };

async function getAccessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt - 30_000) {
    return tokenCache.value;
  }

  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Server misconfigured: OpenSky credentials missing.");
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    throw new Error(`Token request failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();

  tokenCache = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 1800) * 1000,
  };

  return tokenCache.value;
}

/* ----------------------------------------------------------------
   Convert OpenSky raw state vector array -> readable object
   Index map:
   0 icao24           1 callsign          2 origin_country
   3 time_position    4 last_contact      5 longitude
   6 latitude         7 baro_altitude     8 on_ground
   9 velocity        10 true_track       11 vertical_rate
   12 sensors        13 geo_altitude     14 squawk
   15 spi            16 position_source  17 category
----------------------------------------------------------------- */
function mapState(s) {
  return {
    icao24: s[0],
    callsign: s[1] ? s[1].trim() : null,
    origin_country: s[2],
    time_position: s[3],
    last_contact: s[4],
    longitude: s[5],
    latitude: s[6],
    baro_altitude: s[7],
    on_ground: s[8],
    velocity: s[9],
    true_track: s[10],
    vertical_rate: s[11],
    geo_altitude: s[13],
    squawk: s[14],
    spi: s[15],
    position_source: s[16],
    category: s[17] ?? null,
  };
}

/* ----------------------------------------------------------------
   Main handler
----------------------------------------------------------------- */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed. Use GET.",
      creator: CREATOR,
    });
  }

  /* ---------- private key check ---------- */
  const provided = String(
    firstVal(req.query.key) || req.headers["x-api-key"] || ""
  ).trim();

  const expected = (process.env.API_KEY || "aritra").trim();

  if (!provided || provided !== expected) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized. Invalid or missing API key.",
      hint: "Add ?key=YOUR_KEY to the URL.",
      creator: CREATOR,
    });
  }

  /* ---------- build OpenSky query ---------- */
  const allowed = ["lamin", "lomin", "lamax", "lomax", "icao24", "time"];
  const qs = new URLSearchParams();

  for (const p of allowed) {
    const val = firstVal(req.query[p]);
    if (val !== undefined && val !== "") qs.set(p, String(val));
  }

  const limitRaw = parseInt(firstVal(req.query.limit), 10);
  const limit = Math.min(Number.isFinite(limitRaw) ? limitRaw : 500, 5000);

  /* ---------- fetch from OpenSky ---------- */
  try {
    const token = await getAccessToken();

    const url = qs.toString() ? `${STATES_URL}?${qs.toString()}` : STATES_URL;

    const openskyRes = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!openskyRes.ok) {
      const text = await openskyRes.text();
      return res.status(openskyRes.status).json({
        ok: false,
        error: "OpenSky request failed",
        status: openskyRes.status,
        detail: text.slice(0, 500),
        creator: CREATOR,
      });
    }

    const data = await openskyRes.json();
    const states = data.states || [];
    const aircraft = states.slice(0, limit).map(mapState);

    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=30");

    return res.status(200).json({
      ok: true,
      creator: CREATOR,
      source: "OpenSky Network",
      time: data.time,
      count: aircraft.length,
      total_available: states.length,
      aircraft,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Internal server error",
      detail: String((err && err.message) || err),
      creator: CREATOR,
    });
  }
}