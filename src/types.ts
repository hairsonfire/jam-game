export type Player = {
  id: string;
  name: string;
  adds: number;
  skip: boolean;
  cooldown_until: string | null;
};
export type Challenge = {
  id: string;
  text: string;
  duration: number | null;
  active: boolean;
};
export type Assignment = {
  id: string;
  player_id: string;
  kind: "challenge" | "sacrifice";
  text: string;
  duration: number | null;
  status: "assigned" | "invited" | "running" | "failed";
  attempt_id: string | null;
  witness_id: string | null;
  started_at: string | null;
};
export type Request = {
  spotify_track?: SpotifyTrack | null;
  played_at?: string | null;
  id: string;
  player_id: string;
  kind: "song" | "skip";
  text: string;
  status: "pending" | "queued" | "started" | "done" | "rejected";
  reason: string | null;
  created_at: string;
  resolved_at: string | null;
};
export type GameEvent = {
  id: string;
  kind: string;
  body: string;
  created_at: string;
};
export type State = {
  spotify?: {
    connected: boolean;
    checkedAt?: string;
    issue?: string | null;
    snapshot?: { current: SpotifyTrack | null; queue: SpotifyTrack[]; progressMs: number; playing: boolean; device: string | null; observedAt: string };
    jobs?: { id: string; requestId: string; status: string; issue: string | null }[];
  };
  serverTime: string;
  room: {
    id: string;
    name: string;
    code: string;
    admin_id: string;
    music_id: string;
    bonus: number;
    sacrifice: string;
  };
  me: Player;
  players: Pick<Player, "id" | "name">[];
  challenges: Challenge[];
  assignments: Assignment[];
  requests: Request[];
  events: GameEvent[];
  ledger: {
    id: string;
    operation: string;
    adds: number;
    skip: number;
    created_at: string;
  }[];
};
export type CommandResult = {
  deleted?: boolean;
  roomId?: string;
  playerId?: string;
  code?: string;
  error?: string;
};
export type SpotifyTrack = { id: string; uri: string; name: string; artists: string; image: string | null; durationMs: number; url: string };
