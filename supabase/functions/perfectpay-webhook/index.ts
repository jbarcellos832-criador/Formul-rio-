// Supabase Edge Function: receives Perfect Pay's purchase webhook,
// creates (or reuses) a Supabase Auth account for the buyer with a random
// password, and e-mails the credentials via Resend.
//
// Deploy:
//   supabase functions deploy perfectpay-webhook --no-verify-jwt
//
// Required secrets (set with `supabase secrets set NAME=value`):
//   SUPABASE_URL              - filled automatically by Supabase
//   SUPABASE_SERVICE_ROLE_KEY - Project Settings > API > service_role key
//   RESEND_API_KEY            - from resend.com
//   PERFECTPAY_WEBHOOK_TOKEN  - a secret string you invent; Perfect Pay must
//                                send it back so we know the request is real
//   MAIL_FROM                 - e.g. "Split <contato@splitia.space>"
//   APP_LOGIN_URL              - e.g. "https://splitia.space/"

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const WEBHOOK_TOKEN = Deno.env.get("PERFECTPAY_WEBHOOK_TOKEN")!;
const MAIL_FROM = Deno.env.get("MAIL_FROM") ?? "Split <onboarding@resend.dev>";
const APP_LOGIN_URL = Deno.env.get("APP_LOGIN_URL") ?? "https://splitia.space/";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Statuses from Perfect Pay that should grant access. Adjust to match
// exactly what your Perfect Pay panel sends (check a real payload under
// Integrações > Webhook in Perfect Pay before going live).
const APPROVED_STATUSES = new Set([
  "approved",
  "paid",
  "completed",
  "aprovada",
  "aprovado",
  "pago",
  "paga",
  "venda aprovada",
  "compra aprovada",
]);

function randomPassword(length = 12): string {
  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

function welcomeEmailHtml(name: string, email: string, password: string) {
  return `
  <div style="font-family:Manrope,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#f7f8fa;">
    <div style="background:#111214;border-radius:16px;padding:28px;text-align:center;margin-bottom:24px;">
      <div style="color:#fff;font-weight:800;font-size:22px;letter-spacing:-0.02em;">Split</div>
    </div>
    <div style="background:#fff;border-radius:16px;padding:28px;">
      <h1 style="font-size:19px;margin:0 0 12px;">Bem-vindo(a), ${name || "afiliado"}! 🎉</h1>
      <p style="font-size:14.5px;color:#333;line-height:1.6;margin:0 0 20px;">
        Sua compra foi aprovada e seu acesso ao painel Split já está liberado.
        Use os dados abaixo para entrar:
      </p>
      <div style="background:#f5f6f8;border-radius:12px;padding:16px 18px;margin-bottom:20px;">
        <div style="font-size:12.5px;color:#777;margin-bottom:4px;">E-mail de acesso</div>
        <div style="font-size:15px;font-weight:700;margin-bottom:14px;">${email}</div>
        <div style="font-size:12.5px;color:#777;margin-bottom:4px;">Senha provisória</div>
        <div style="font-size:15px;font-weight:700;">${password}</div>
      </div>
      <a href="${APP_LOGIN_URL}" style="display:inline-block;background:#16c784;color:#06341f;font-weight:800;text-decoration:none;padding:13px 22px;border-radius:10px;font-size:14px;">
        Acessar o painel →
      </a>
      <p style="font-size:12.5px;color:#999;line-height:1.6;margin-top:22px;">
        Por segurança, recomendamos trocar essa senha assim que entrar pela primeira vez.
      </p>
    </div>
  </div>`;
}

async function sendWelcomeEmail(to: string, name: string, password: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to,
      subject: "Seu acesso ao Split está liberado 🚀",
      html: welcomeEmailHtml(name, to, password),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend error ${res.status}: ${body}`);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Perfect Pay must be configured to send this token back (as a query
  // param, e.g. ?token=xxx, or you can switch this to check a header
  // instead, depending on what Perfect Pay supports).
  const url = new URL(req.url);
  if (url.searchParams.get("token") !== WEBHOOK_TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // TODO: confirm these field names against a real Perfect Pay payload.
  // Perfect Pay's field names vary by product/integration version, so this
  // reads a few common shapes defensively.
  // Perfect Pay's own postback format uses these field names (in Portuguese);
  // the English names are kept as a fallback for other gateways/formats.
  const status = String(
    payload.statusPagamento ??
      payload.sale_status_enum_key ??
      payload.status ??
      payload.event ??
      "",
  ).toLowerCase();
  const email = String(
    payload.clienteEmail ??
      (payload.customer as Record<string, unknown> | undefined)?.email ??
      payload.customer_email ??
      payload.email ??
      "",
  ).trim().toLowerCase();
  const name = String(
    payload.clienteNome ??
      (payload.customer as Record<string, unknown> | undefined)?.full_name ??
      payload.customer_name ??
      payload.name ??
      "",
  ).trim();
  const orderId = String(
    payload.transacao ??
      payload.sale_code ??
      payload.order_id ??
      payload.id ??
      crypto.randomUUID(),
  );
  const plan = String(
    payload.produto ?? payload.product_name ?? payload.plan ?? "",
  );

  if (!email) {
    return new Response("Missing customer email", { status: 400 });
  }
  if (!APPROVED_STATUSES.has(status)) {
    // Not an approved-sale event (e.g. a refund or pending notification) —
    // acknowledge it but do nothing.
    return new Response("Ignored (status not approved)", { status: 200 });
  }

  // Idempotency: if we've already processed this exact order, stop here.
  const { data: existing } = await supabase
    .from("purchases")
    .select("id")
    .eq("perfectpay_order_id", orderId)
    .maybeSingle();
  if (existing) {
    return new Response("Already processed", { status: 200 });
  }

  const password = randomPassword();

  // Create the Supabase Auth user (or, if the e-mail already has an
  // account from a previous purchase, just reuse it — no new password is
  // sent in that case, only a purchase record is logged).
  const { data: userList } = await supabase.auth.admin.listUsers();
  const alreadyExists = userList?.users?.some((u) => u.email === email);

  if (!alreadyExists) {
    const { error: createError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: name, plan },
    });
    if (createError) {
      return new Response(`Failed to create user: ${createError.message}`, {
        status: 500,
      });
    }
    await sendWelcomeEmail(email, name, password);
  }

  await supabase.from("purchases").insert({
    perfectpay_order_id: orderId,
    customer_email: email,
    customer_name: name,
    plan,
    status,
  });

  return new Response("OK", { status: 200 });
});
