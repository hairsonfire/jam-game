// Test-only HTTP adapter to run the *real SQL migrations* through the Supabase client.
// It is never imported by the application or deployed. It is not a replacement auth server.
import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
const db = new PGlite();
await db.waitReady;
await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
for (const name of readdirSync("supabase/migrations").filter(n => n.endsWith(".sql")).sort())
  await db.exec(readFileSync("supabase/migrations/" + name, "utf8"));
let queue = Promise.resolve();
const users = new Map();
function session(id = randomUUID()) {
  const user = {
    id,
    aud: "authenticated",
    role: "authenticated",
    is_anonymous: true,
    app_metadata: { provider: "anonymous" },
    user_metadata: {},
    created_at: new Date().toISOString(),
  };
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token =
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
      "base64url",
    ) +
    "." +
    Buffer.from(
      JSON.stringify({ sub: id, exp, role: "authenticated" }),
    ).toString("base64url") +
    ".test";
  users.set(token, user);
  return {
    access_token: token,
    refresh_token: id,
    expires_in: 3600,
    expires_at: exp,
    token_type: "bearer",
    user,
  };
}
const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Content-Type", "application/json");
  const send = (status, body) => {
    res.statusCode = status;
    res.end(JSON.stringify(body));
  };
  if (req.method === "OPTIONS") return send(200, {});
  if (req.url === "/health") return send(200, { ready: true });
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return send(400, {});
  }
  if (req.url === "/auth/v1/signup") return send(200, session());
  if (req.url?.startsWith("/auth/v1/token"))
    return send(200, session(body.refresh_token));
  const user = users.get(req.headers.authorization?.replace("Bearer ", ""));
  if (!user) return send(401, { message: "Unauthorized", code: "401" });
  if (req.url === "/auth/v1/user") return send(200, user);
  if (req.url?.startsWith("/auth/v1/logout")) return send(200, {});
  if (req.url?.startsWith("/functions/"))
    return send(503, {
      error: "Push delivery is not simulated by browser tests.",
    });
  // Serialize the session configuration on the one embedded PostgreSQL connection.
  const work = async () => {
    try {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
        user.id,
      ]);
      await db.exec("set role authenticated");
      let result;
      if (req.url === "/rest/v1/rpc/game_command")
        result = await db.query(
          "select public.game_command($1,$2,$3::jsonb) result",
          [body.action_id, body.kind, JSON.stringify(body.payload)],
        );
      else if (req.url === "/rest/v1/rpc/game_state")
        result = await db.query("select public.game_state($1) result", [
          body.room_id,
        ]);
      else return send(404, {});
      send(200, result.rows[0].result);
    } catch (e) {
      send(400, {
        message: e.message,
        code: e.code ?? "P0001",
        details: null,
        hint: null,
      });
    } finally {
      await db.exec("reset role");
    }
  };
  queue = queue.then(work, work);
});
server.listen(8787, "127.0.0.1", () =>
  console.log("SQL test server listening on 8787"),
);
