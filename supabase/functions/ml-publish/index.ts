// Supabase Edge Function: publishes one catalog product as a real listing
// on the buyer's own Mercado Livre account, using the access/refresh token
// stored by ml-callback.
//
// Deploy:
//   supabase functions deploy ml-publish
//   (keep JWT verification ON — this must only run for the logged-in buyer)
//
// Required secrets (same project as ml-callback):
//   SUPABASE_URL, SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
//   ML_CLIENT_ID, ML_CLIENT_SECRET
//
// Called from the painel as:
//   await supabaseClient.functions.invoke('ml-publish', {
//     body: { title, price, quantity, description, imageBase64 }
//   });
// (imageBase64 is a data URL, e.g. "data:image/jpeg;base64,...")

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const ML_CLIENT_ID = Deno.env.get("ML_CLIENT_ID")!;
const ML_CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET")!;

const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function getUserFromAuthHeader(req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) return null;

  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data, error } = await anonClient.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

async function getValidAccessToken(userId: string) {
  const { data: conn, error } = await adminClient
    .from("ml_connections")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !conn) {
    throw new Error("not_connected");
  }

  const expiresAt = new Date(conn.expires_at).getTime();
  const now = Date.now();

  // Refresh if it's already expired or expiring in under 2 minutes.
  if (expiresAt - now > 2 * 60 * 1000) {
    return conn.access_token as string;
  }

  const refreshRes = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      refresh_token: conn.refresh_token,
    }),
  });

  if (!refreshRes.ok) {
    const errBody = await refreshRes.text();
    console.log("ML token refresh failed:", errBody);
    throw new Error("refresh_failed");
  }

  const refreshed = await refreshRes.json();
  const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();

  await adminClient
    .from("ml_connections")
    .update({
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_at: newExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  return refreshed.access_token as string;
}

async function predictCategory(title: string, accessToken: string) {
  const res = await fetch(
    `https://api.mercadolibre.com/sites/MLB/domain_discovery/search?q=${encodeURIComponent(title)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) throw new Error("category_lookup_failed");
  const results = await res.json();
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error("category_not_found");
  }
  return results[0].category_id as string;
}

function dataUrlToBlob(dataUrl: string) {
  const [header, base64] = dataUrl.split(",");
  const mimeMatch = header.match(/data:(.*);base64/);
  const mime = mimeMatch ? mimeMatch[1] : "image/jpeg";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function uploadPicture(imageBase64: string, accessToken: string) {
  const blob = dataUrlToBlob(imageBase64);
  const form = new FormData();
  form.append("file", blob, "product.jpg");

  const res = await fetch("https://api.mercadolibre.com/pictures/items/upload", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.log("ML picture upload failed:", errBody);
    throw new Error("picture_upload_failed");
  }

  const pic = await res.json();
  return pic.id as string;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }

  const user = await getUserFromAuthHeader(req);
  if (!user) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  let payload: {
    title?: string;
    price?: number;
    quantity?: number;
    description?: string;
    imageBase64?: string;
  };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "invalid_json" }, 400);
  }

  const { title, price, quantity, description, imageBase64 } = payload;
  if (!title || !price || !quantity || !imageBase64) {
    return jsonResponse({ ok: false, error: "missing_fields" }, 400);
  }

  try {
    const accessToken = await getValidAccessToken(user.id);
    const categoryId = await predictCategory(title, accessToken);
    const pictureId = await uploadPicture(imageBase64, accessToken);

    const itemRes = await fetch("https://api.mercadolibre.com/items", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title,
        category_id: categoryId,
        price,
        currency_id: "BRL",
        available_quantity: quantity,
        buying_mode: "buy_it_now",
        listing_type_id: "gold_special",
        condition: "new",
        pictures: [{ id: pictureId }],
      }),
    });

    if (!itemRes.ok) {
      const errBody = await itemRes.text();
      console.log("ML item creation failed:", errBody);
      return jsonResponse({ ok: false, error: "item_creation_failed", detail: errBody }, 502);
    }

    const item = await itemRes.json();

    if (description) {
      await fetch(`https://api.mercadolibre.com/items/${item.id}/description`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ plain_text: description }),
      });
    }

    return jsonResponse({ ok: true, id: item.id, permalink: item.permalink });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    console.log("ml-publish error:", message);
    return jsonResponse({ ok: false, error: message }, 502);
  }
});
