import { createClient } from "npm:@supabase/supabase-js@2";

const origin = Deno.env.get("APP_ORIGIN") ?? "";
const clientId = Deno.env.get("SPOTIFY_CLIENT_ID") ?? "64bead85eb634b2d8734397dc07f2a43";
const redirectUri = `${origin}/?spotify=callback`;
const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const headers = { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", Vary: "Origin", "Content-Type": "application/json" };
type Token = { access_token: string; refresh_token: string; expires: number };
type Track = { id: string; uri: string; name: string; artists: string; durationMs: number; image: string | null; url: string };
type SpotifyTrack = { id?: string; uri?: string; name?: string; artists?: { name: string }[]; album?: { images: { url: string }[] }; duration_ms?: number; is_playable?: boolean; type?: string };
function track(t: SpotifyTrack | null): Track | null {
  if (!t?.id || t.type !== "track" || !/^[a-zA-Z0-9]{22}$/.test(t.id)) return null;
  return { id: t.id, uri: `spotify:track:${t.id}`, name: t.name ?? "Titre inconnu", artists: (t.artists ?? []).map(a => a.name).join(", "), durationMs: t.duration_ms ?? 0, image: t.album?.images?.[0]?.url ?? null, url: `https://open.spotify.com/track/${t.id}` };
}
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const un64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const random = () => b64(crypto.getRandomValues(new Uint8Array(32))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
async function encryptionKey() {
  const raw = Deno.env.get("SPOTIFY_ENCRYPTION_KEY");
  if (!raw) throw new Error("L’intégration Spotify doit encore être configurée sur le serveur.");
  return crypto.subtle.importKey("raw", un64(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(), new TextEncoder().encode(JSON.stringify(value)));
  return b64(iv) + "." + b64(new Uint8Array(cipher));
}
async function unseal<T>(value: string): Promise<T> {
  const [iv, cipher] = value.split(".");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: un64(iv) }, await encryptionKey(), un64(cipher));
  return JSON.parse(new TextDecoder().decode(plain));
}
class SpotifyError extends Error {
  constructor(public status: number, public uncertain = false, public retrySeconds = 60) {
    super(status === 429 ? "Limite Spotify atteinte. Patientez avant de réessayer." : status === 401 ? "Reconnectez Spotify depuis la régie." : status === 403 ? "Spotify refuse cette action. Vérifiez Premium et les utilisateurs autorisés de l’application." : status === 404 ? "Ouvrez Spotify et lancez un morceau sur l’appareil de la soirée." : "Spotify est momentanément indisponible.");
  }
}
async function api(token: string, path: string, method = "GET", body?: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`https://api.spotify.com/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000), redirect: "error" });
  } catch { throw new SpotifyError(0, method !== "GET"); }
  if (!res.ok) throw new SpotifyError(res.status, method !== "GET" && res.status >= 500, Number(res.headers.get("Retry-After")) || 60);
  return res.status === 204 ? null : await res.json();
}
async function exchange(params: Record<string, string>): Promise<Token> {
  const res = await fetch("https://accounts.spotify.com/api/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...params, client_id: clientId }), signal: AbortSignal.timeout(8000), redirect: "error" });
  if (!res.ok) throw new Error("La connexion Spotify a expiré ou a été refusée. Reconnectez le compte.");
  const value = await res.json();
  return { access_token: value.access_token, refresh_token: value.refresh_token ?? params.refresh_token, expires: Date.now() + value.expires_in * 1000 };
}
Deno.serve(async request => {
  const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return reply(405, { error: "Méthode invalide." });
  let lease: string | undefined, roomId: string | undefined, userId: string | undefined;
  async function rpc(op: string, args: Record<string, unknown> = {}) {
    const result = await service.rpc("spotify_service", { op, args: { roomId, userId, lease, ...args } });
    if (result.error) throw new Error(result.error.message);
    return result.data;
  }
  try {
    const jwt = request.headers.get("Authorization")?.replace(/^Bearer /, "");
    if (!jwt) return reply(401, { error: "Veuillez vous reconnecter." });
    const body = await request.json();
    roomId = body.roomId;
    if (!roomId || !/^[a-f0-9-]{36}$/i.test(roomId)) throw new Error("Soirée invalide.");
    if (jwt === Deno.env.get("PUSH_CRON_SECRET")) {
      if (body.action !== "sync") return reply(403, { error: "Action non autorisée." });
      const context = await service.rpc("spotify_scheduler_context", { room_key: roomId });
      if (context.error || !context.data) return reply(200, { idle: true });
      userId = context.data;
    } else {
      const auth = await service.auth.getUser(jwt);
      if (auth.error || !auth.data.user) return reply(401, { error: "Veuillez vous reconnecter." });
      userId = auth.data.user.id;
    }
    const permission = await rpc("access");
    const hostActions = ["connect", "callback", "disconnect", "devices", "play", "pause", "transfer", "resolve"];
    if (hostActions.includes(body.action) && !permission.dj) throw new Error("Seul le responsable musical peut effectuer cette action.");
    if (body.action === "connect") {
      if (!origin.startsWith("https://")) throw new Error("L’adresse de l’application doit être configurée en HTTPS.");
      const verifier = random(), state = random();
      const challenge = b64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      await rpc("oauth_start", { state, verifier: await seal(verifier) });
      const params = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirectUri, state, code_challenge_method: "S256", code_challenge: challenge, scope: "user-read-playback-state user-modify-playback-state user-read-currently-playing user-read-private" });
      return reply(200, { url: `https://accounts.spotify.com/authorize?${params}` });
    }
    if (body.action === "callback") {
      if (typeof body.code !== "string" || typeof body.state !== "string") throw new Error("Retour Spotify invalide.");
      const saved = await rpc("oauth_take", { state: body.state });
      const credentials = await exchange({ grant_type: "authorization_code", code: body.code, redirect_uri: redirectUri, code_verifier: await unseal<string>(saved.verifier) });
      const profile = await api(credentials.access_token, "/me");
      if (profile.product && profile.product !== "premium") throw new Error("Le compte connecté doit disposer de Spotify Premium.");
      await rpc("connect", { accountId: profile.id, credentials: await seal(credentials) });
      return reply(200, { ok: true });
    }
    if (body.action === "disconnect") { await rpc("disconnect"); return reply(200, { ok: true }); }
    if (!["search", "sync", "devices", "play", "pause", "transfer", "resolve"].includes(body.action)) throw new Error("Action Spotify inconnue.");
    const lock = await rpc("lease", { purpose: body.action });
    if (lock.busy) return reply(200, { busy: true });
    lease = lock.lease;
    if (body.action === "resolve") {
      await rpc("resolve", { jobId: body.jobId, performed: body.performed });
      await rpc("release"); lease = undefined;
      return reply(200, { ok: true });
    }
    let credentials = await unseal<Token>(lock.credentials);
    if (credentials.expires < Date.now() + 60000) {
      credentials = await exchange({ grant_type: "refresh_token", refresh_token: credentials.refresh_token });
      await rpc("save_token", { credentials: await seal(credentials) });
    }
    const token = credentials.access_token;
    let result: Record<string, unknown> = { ok: true };
    if (body.action === "search") {
      if (typeof body.query !== "string" || body.query.trim().length < 2 || body.query.length > 100) throw new Error("Saisissez entre 2 et 100 caractères.");
      const found = await api(token, `/search?type=track&limit=10&q=${encodeURIComponent(body.query.trim())}`);
      const tracks = (found.tracks?.items ?? []).filter((t: SpotifyTrack) => t.is_playable !== false).map(track).filter(Boolean);
      await rpc("cache", { tracks });
      result = { tracks };
    } else if (body.action === "devices") {
      const found = await api(token, "/me/player/devices");
      result = { devices: (found.devices ?? []).filter((d: any) => !d.is_restricted).map((d: any) => ({ id: d.id, name: d.name, active: d.is_active })) };
    } else if (body.action === "play" || body.action === "pause") {
      await api(token, `/me/player/${body.action}`, "PUT");
    } else if (body.action === "transfer") {
      if (typeof body.deviceId !== "string" || body.deviceId.length > 200) throw new Error("Appareil invalide.");
      await api(token, "/me/player", "PUT", { device_ids: [body.deviceId], play: true });
    } else {
      // Durable jobs are marked sending before the external write. Never replay an ambiguous write.
      const job = await rpc("claim");
      if (job) {
        let outcome = "ok", issue: string | undefined;
        try {
          if (job.kind === "song") await api(token, `/me/player/queue?uri=${encodeURIComponent(job.target)}`, "POST");
          else {
            const current = await api(token, "/me/player");
            if (current?.item?.uri !== job.target) throw new Error("Le morceau a changé : skip annulé, jeton conservé.");
            await api(token, "/me/player/next", "POST");
          }
        } catch (error) {
          outcome = error instanceof SpotifyError && error.uncertain ? "uncertain" : "failed";
          issue = error instanceof Error ? error.message : "Spotify indisponible.";
        }
        await rpc("finish", { jobId: job.id, outcome, issue });
      }
      const playback = await api(token, "/me/player");
      const queue = playback ? await api(token, "/me/player/queue") : null;
      await rpc("snapshot", { snapshot: {
        current: track(playback?.item ?? null), playing: Boolean(playback?.is_playing), progressMs: playback?.progress_ms ?? 0,
        device: playback?.device?.name ?? null,
        queue: (queue?.queue ?? []).map(track).filter(Boolean), observedAt: new Date().toISOString(),
      } });
    }
    await rpc("release"); lease = undefined;
    return reply(200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connexion Spotify indisponible.";
    if (lease) { try { await rpc("release", { issue: message, retrySeconds: error instanceof SpotifyError && error.status === 429 ? error.retrySeconds : 15 }); } catch { /* Lease expires; sending jobs remain uncertain. */ } }
    return reply(400, { error: message });
  }
});
