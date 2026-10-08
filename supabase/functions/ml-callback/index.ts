// Supabase Edge Function: receives Mercado Livre's OAuth redirect after a
// buyer authorizes the "Split" app on their own Mercado Livre seller
// account, exchanges the authorization code for tokens, and stores them.
//
// Deploy:
//   supabase functions deploy ml-callback --no-verify-jwt
//
// Required secrets (set with `supabase secrets set NAME=value`):
//   SUPABASE_URL          - filled automatically by Supabase
//   SERVICE_ROLE_KEY      - Project Settings > API > service_role key
//   ML_CLIENT_ID          - from developers.mercadolivre.com.br > Minhas aplicações
//   ML_CLIENT_SECRET      - same place, "Secret Key"
//   ML_REDIRECT_URI       - must match EXACTLY the URI registered on the ML app,
//                            e.g. https://<SEU-PROJETO>.supabase.co/functions/v1/ml-callback
//   APP_PANEL_URL         - e.g. https://splitia.space/painel/ (where we send the
//                            buyer back to after connecting, success or not)
//
// How the "Conectar Mercado Livre" button must call this flow:
//   It redirects the browser to:
//     https://auth.mercadolivre.com.br/authorization
//       ?response_type=code
//       &client_id=<ML_CLIENT_ID>
//       &redirect_uri=<ML_REDIRECT_URI>   (URL-encoded, must match exactly)
//       &state=<the buyer's own Supabase auth user id>
//   Mercado Livre then redirects back here with ?code=...&state=<user_id>.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
const ML_CLIENT_ID = Deno.env.get("ML_CLIENT_ID")!;
const ML_CLIENT_SECRET = Deno.env.get("ML_CLIENT_SECRET")!;
const ML_REDIRECT_URI = Deno.env.get("ML_REDIRECT_URI")!;
const APP_PANEL_URL = Deno.env.get("APP_PANEL_URL") ?? "https://splitia.space/painel/";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function redirectTo(url: string) {
  return new Response(null, { status: 302, headers: { Location: url } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const userId = url.searchParams.get("state");
  const mlError = url.searchParams.get("error");

  if (mlError) {
    return redirectTo(`${APP_PANEL_URL}?ml=error&reason=${encodeURIComponent(mlError)}`);
  }
  if (!code || !userId) {
    return redirectTo(`${APP_PANEL_URL}?ml=error&reason=missing_code_or_state`);
  }

  // Exchange the authorization code for an access + refresh token.
  const tokenRes = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      code,
      redirect_uri: ML_REDIRECT_URI,
    }),
  });

  if (!tokenRes.ok) {
    const errBody = await tokenRes.text();
    console.log("ML token exchange failed:", errBody);
    return redirectTo(`${APP_PANEL_URL}?ml=error&reason=token_exchange_failed`);
  }

  const tokenData = await tokenRes.json();
  const { access_token, refresh_token, user_id: mlUserId, expires_in } = tokenData;

  // Fetch the seller's nickname for a nicer "Conectado como ..." label.
  let mlNickname: string | null = null;
  try {
    const meRes = await fetch("https://api.mercadolibre.com/users/me", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (meRes.ok) {
      const me = await meRes.json();
      mlNickname = me.nickname ?? null;
    }
  } catch {
    // Not critical — the connection still works without the nickname.
  }

  const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

  const { error: dbError } = await supabase
    .from("ml_connections")
    .upsert({
      user_id: userId,
      ml_user_id: String(mlUserId),
      ml_nickname: mlNickname,
      access_token,
      refresh_token,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });

  if (dbError) {
    console.log("Failed to store ML connection:", dbError.message);
    return redirectTo(`${APP_PANEL_URL}?ml=error&reason=db_write_failed`);
  }

  return redirectTo(`${APP_PANEL_URL}?ml=connected`);
});
