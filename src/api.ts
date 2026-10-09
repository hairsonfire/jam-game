import { isMobileDevice, desktopNotificationsMessage } from "./feedback";
import { createClient } from "@supabase/supabase-js";
import type { CommandResult, State } from "./types";

export const configured = Boolean(
  import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY,
);
export const supabase = configured
  ? createClient(
      import.meta.env.VITE_SUPABASE_URL,
      import.meta.env.VITE_SUPABASE_ANON_KEY,
    )
  : null;
export const storage = {
  get(key: string) {
    try {
      return localStorage.getItem("jam:" + key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    localStorage.setItem("jam:" + key, value);
  },
  remove(key: string) {
    localStorage.removeItem("jam:" + key);
  },
};

export async function identity() {
  if (!supabase) throw new Error("L’hébergement n’est pas encore configuré.");
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!data.session) {
    const response = await supabase.auth.signInAnonymously();
    if (response.error) throw response.error;
  }
}

type Pending = {
  action: string;
  kind: string;
  payload: Record<string, unknown>;
};
export function pendingCommand(): Pending | null {
  const raw = storage.get("pending");
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
export async function command(
  kind: string,
  payload: Record<string, unknown>,
): Promise<CommandResult> {
  if (!navigator.onLine)
    throw new Error("Vous êtes hors connexion. Vos données sont conservées.");
  await identity();
  const pending = pendingCommand();
  const serialized = JSON.stringify(payload);
  if (
    pending &&
    (pending.kind !== kind || JSON.stringify(pending.payload) !== serialized)
  ) {
    throw new Error(
      "Une action attend confirmation. Utilisez « Vérifier la dernière action ».",
    );
  }
  const action = pending ?? { action: crypto.randomUUID(), kind, payload };
  storage.set("pending", JSON.stringify(action));
  const { data, error } = await supabase!
    .rpc("game_command", { action_id: action.action, kind, payload })
    .abortSignal(AbortSignal.timeout(15000));
  if (error) {
    // Postgres exceptions roll back the transaction. Network/gateway failures may hide a committed action.
    if (
      error.code &&
      /^[0-9A-Z]{5}$/.test(error.code) &&
      !error.code.startsWith("08")
    )
      storage.remove("pending");
    throw new Error(
      error.message || "Connexion interrompue. Vérifiez la dernière action.",
    );
  }
  storage.remove("pending");
  if (data.error) throw new Error(data.error);
  // Best effort, durable queue + cron will retry even if this request never arrives.
  void supabase!.functions
    .invoke("push-dispatch", {
      body: { roomId: payload.roomId ?? data.roomId },
    })
    .catch(() => {});
  return data;
}
export class SessionUnavailable extends Error {}
export async function spotifyCall(roomId: string, action: string, data: Record<string, unknown> = {}): Promise<any> {
  if (!navigator.onLine) throw new Error("Vous êtes hors connexion.");
  await identity();
  const response = await supabase!.functions.invoke("spotify", { body: { roomId, action, ...data } });
  if (response.error) {
    let message = "Spotify est indisponible. Vérifiez la connexion ou la configuration depuis la régie.";
    try { message = (await response.error.context.json()).error ?? message; } catch { /* No structured response. */ }
    throw new Error(message);
  }
  if (response.data?.error) throw new Error(response.data.error);
  return response.data;
}
export async function readState(roomId: string): Promise<State> {
  await identity();
  const { data, error } = await supabase!
    .rpc("game_state", { room_id: roomId })
    .abortSignal(AbortSignal.timeout(15000));
  if (error) throw error.code === "JAM01" ? new SessionUnavailable(error.message) : new Error(error.message);
  return data;
}
export async function recoveryHash(secret: string) {
  const normalized = secret.replace(/[\s-]/g, "").toLowerCase();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized),
  );
  return Array.from(new Uint8Array(digest), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}
export function newRecovery() {
  return Array.from(crypto.getRandomValues(new Uint8Array(20)), (n) =>
    n.toString(16).padStart(2, "0"),
  )
    .join("")
    .match(/.{1,5}/g)!
    .join("-");
}
export async function enablePush(roomId: string) {
  if (!isMobileDevice()) throw new Error(desktopNotificationsMessage);
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  )
    throw new Error(
      "Ajoutez Jam à l’écran d’accueil, puis ouvrez son icône. Votre téléphone et votre navigateur doivent prendre en charge les notifications.",
    );
  const key = import.meta.env.VITE_VAPID_PUBLIC_KEY;
  if (!key)
    throw new Error(
      "Les notifications doivent être configurées sur le serveur.",
    );
  const permission = await Notification.requestPermission();
  if (permission !== "granted")
    throw new Error(
      "Notifications non autorisées. Vous pouvez continuer avec les listes de l’application.",
    );
  const registration = await navigator.serviceWorker.ready;
  const bytes = Uint8Array.from(
    atob(
      key
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(key.length / 4) * 4, "="),
    ),
    (c) => c.charCodeAt(0),
  );
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: bytes,
    }));
  const json = subscription.toJSON();
  await command("subscribe", {
    roomId,
    endpoint: json.endpoint,
    p256dh: json.keys?.p256dh,
    auth: json.keys?.auth,
  });
}
