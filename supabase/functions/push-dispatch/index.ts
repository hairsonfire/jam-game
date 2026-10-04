import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const url = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const service = createClient(url, serviceKey, {
  auth: { persistSession: false },
});
const origin = Deno.env.get("APP_ORIGIN") ?? "";
const cors = {
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  Vary: "Origin",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (request) => {
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return reply(405, { error: "POST required" });
  const bearer =
    request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
  const schedulerKey = Deno.env.get("PUSH_CRON_SECRET");
  if (!bearer) return reply(401, { error: "Unauthorized" });
  if (bearer !== schedulerKey) {
    const { data, error } = await service.auth.getUser(bearer);
    if (error || !data.user) return reply(401, { error: "Unauthorized" });
    let roomId: string;
    try {
      roomId = (await request.json()).roomId;
    } catch {
      return reply(400, { error: "Invalid JSON" });
    }
    const client = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: `Bearer ${bearer}` } },
      auth: { persistSession: false },
    });
    // Membership check and persisted rate limit; no unauthenticated queue draining.
    const { data: permitted, error: denied } = await client.rpc(
      "push_permission",
      { room_id: roomId },
    );
    if (denied || !permitted)
      return reply(429, { error: "Not permitted or rate limited" });
  }
  const pub = Deno.env.get("VAPID_PUBLIC_KEY");
  const priv = Deno.env.get("VAPID_PRIVATE_KEY");
  const subject = Deno.env.get("VAPID_SUBJECT");
  if (!pub || !priv || !subject)
    return reply(503, { error: "Web Push is not configured" });
  webpush.setVapidDetails(subject, pub, priv);
  const { data: batch, error } = await service.rpc("push_claim", {
    batch_size: 25,
  });
  if (error) return reply(500, { error: "Queue unavailable" });
  const results = await Promise.allSettled(
    batch.map(
      async (item: {
        id: string;
        lease: string;
        endpoint: string;
        p256dh: string;
        auth: string;
        eventId: string;
        body: string;
      }) => {
        let outcome = "sent";
        try {
          // Validate again at the outbound boundary. Never follow arbitrary user-provided endpoints.
          const endpoint = new URL(item.endpoint);
          if (
            endpoint.protocol !== "https:" ||
            endpoint.port ||
            endpoint.username ||
            endpoint.password ||
            ![
              "push.apple.com",
              "fcm.googleapis.com",
              "push.services.mozilla.com",
              "notify.windows.com",
            ].some(
              (domain) =>
                endpoint.hostname === domain ||
                endpoint.hostname.endsWith("." + domain),
            )
          )
            throw new Error("Invalid push endpoint");
          await webpush.sendNotification(
            {
              endpoint: item.endpoint,
              keys: { p256dh: item.p256dh, auth: item.auth },
            },
            JSON.stringify({
              title: "Jam · Votre soirée",
              body: item.body,
              id: item.eventId,
            }),
            { TTL: 3600, urgency: "high", timeout: 10000 },
          );
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          outcome =
            status === 404 || status === 410
              ? "gone"
              : `Push failed (${status ?? "network"})`;
        }
        const { error: finishError } = await service.rpc("push_finish", {
          delivery_id: item.id,
          lease_id: item.lease,
          outcome,
        });
        if (finishError) throw finishError;
      },
    ),
  );
  return reply(200, {
    claimed: batch.length,
    recorded: results.filter((r) => r.status === "fulfilled").length,
  });
});
