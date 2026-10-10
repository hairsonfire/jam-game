import { useEffect, useState } from "react";
import { spotifyCall } from "./api";
import type { State, SpotifyTrack, Request } from "./types";
type Props = { s: State; refresh: () => Promise<void> };
function Track({ track }: { track: SpotifyTrack }) {
  return <div className="spotify-track">
    {track.image && <img src={track.image} alt={`Pochette de ${track.name}`} width="56" height="56" loading="lazy" />}
    <div><strong>{track.name}</strong><small>{track.artists}</small><a href={track.url} target="_blank" rel="noreferrer">Ouvrir dans Spotify ↗</a></div>
  </div>;
}
export function playbackLabel(request: Request, spotify: State["spotify"]) {
  if (request.played_at) return `Lecture détectée à ${new Date(request.played_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
  if (request.status === "rejected") return "Annulée · jeton rendu";
  const job = spotify?.jobs?.find(j => j.requestId === request.id);
  if (job?.status === "uncertain") return "Envoi à vérifier par le responsable";
  if (request.status === "pending") return "Envoi à Spotify en cours…";
  const snapshot = spotify?.snapshot;
  if (!snapshot || !spotify?.checkedAt || Date.now() - Date.parse(spotify.checkedAt) > 30000 || spotify.issue) return "Ajoutée · suivi momentanément indisponible";
  const index = snapshot.queue.findIndex(t => t.uri === request.spotify_track?.uri);
  if (index < 0) return "Absente de la file visible · lecture non confirmée";
  if (!snapshot.playing) return `${index + 1}e dans la file · lecture en pause`;
  const before = snapshot.queue.slice(0, index).reduce((sum, t) => sum + t.durationMs, 0);
  const wait = Math.max(0, (snapshot.current?.durationMs ?? 0) - snapshot.progressMs) + before;
  return `${index + 1}e dans la file · environ ${Math.max(1, Math.ceil(wait / 60000))} min`;
}
export function NowPlaying({ s }: { s: State }) {
  const current = s.spotify?.snapshot?.current;
  return <section className="panel"><h2>En ce moment · Spotify</h2>
    {current ? <><Track track={current} /><p className="muted">{s.spotify?.snapshot?.playing ? "Lecture en cours" : "En pause"} · {s.spotify?.snapshot?.device}</p></> : <p>Le responsable doit lancer la musique dans Spotify sur l’appareil de la soirée.</p>}
    {s.spotify?.issue && <p role="status" className="notice">{s.spotify.issue}</p>}
    {s.spotify?.checkedAt && <small>Dernière vérification à {new Date(s.spotify.checkedAt).toLocaleTimeString("fr-FR")}</small>}
  </section>;
}
export function SpotifyMusic({ s, act, refresh }: Props & { act: (kind: string, data?: Record<string, unknown>) => Promise<boolean> }) {
  const [query, setQuery] = useState("");
  const [tracks, setTracks] = useState<SpotifyTrack[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false), [searchError, setSearchError] = useState("");
  const [searchVersion, setSearchVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const term = query.trim();
    setTracks([]); setSearched(false); setSearchError("");
    setSearching(term.length >= 2);
    async function search(attempt = 0) {
      try {
        const result = await spotifyCall(s.room.id, "search", { query: term });
        if (cancelled) return;
        // A playback sync may briefly hold the shared Spotify connection.
        if (result.busy && attempt < 2) {
          timer = setTimeout(() => void search(attempt + 1), 1000);
          return;
        }
        if (result.busy) throw new Error("Spotify est occupé. Réessayez dans quelques secondes.");
        setTracks(result.tracks); setSearched(true); setSearching(false);
      } catch (e) {
        if (cancelled) return;
        setSearching(false);
        setSearchError(e instanceof Error ? e.message : "Recherche indisponible.");
      }
    }
    if (term.length >= 2) timer = setTimeout(() => void search(), 450);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, s.room.id, searchVersion]);
  const waiting = s.requests.some(r => r.player_id === s.me.id && r.kind === "song" && r.status === "pending");
  const skip = s.requests.some(r => r.kind === "skip" && r.status === "pending");
  return <>
    <p className="eyebrow">VOTRE TOUR DE CHOISIR</p><h1>La bande-son.</h1><NowPlaying s={s} />
    <section className="panel"><h2>Choisissez votre chanson</h2><p>{s.me.adds} jeton{s.me.adds !== 1 ? "s" : ""} d’ajout · l’envoi à Spotify est automatique.</p>
      <form onSubmit={e => { e.preventDefault(); setSearchVersion(v => v + 1); }}>
        <label className="field">Chercher une chanson ou un artiste<input value={query} onChange={e => setQuery(e.target.value)} maxLength={100} autoComplete="off" aria-describedby="spotify-search-status" /></label>
      </form>
      <div id="spotify-search-status" role="status" aria-live="polite">
        {searching ? <p>Recherche de suggestions…</p> : query.trim().length < 2 ? <p className="muted">Tapez au moins deux caractères pour voir les suggestions.</p> : searched && tracks.length === 0 ? <p>Aucun morceau trouvé. Essayez un autre titre.</p> : null}
      </div>
      {searchError && <p role="alert" className="notice">{searchError} <button className="text-button" onClick={() => setSearchVersion(v => v + 1)}>Réessayer la recherche</button></p>}
      {error && <p role="alert" className="notice">{error}</p>}
      <div aria-label="Suggestions musicales" aria-busy={searching}>
        {tracks.map(track => <div className="spotify-result" key={track.id}><Track track={track} /><button className="primary" disabled={busy || waiting || s.me.adds < 1} onClick={() => void act("spotify_song", { trackId: track.id })}>Ajouter · 1 jeton</button></div>)}
      </div>
      {waiting && <p>Votre demande est en cours d’envoi. Elle libérera votre place dès son ajout à Spotify.</p>}
      {s.me.adds < 1 && <p>Faites valider un défi par votre témoin pour gagner un jeton.</p>}
    </section>
    <section className="panel"><h2>Passer le morceau</h2><p>Ce bouton passe directement au morceau suivant et utilise votre jeton de skip.</p>
      <button className="secondary" disabled={!s.me.skip || skip || !s.spotify?.snapshot?.current} onClick={() => void act("spotify_skip")}>{skip ? "Skip en cours…" : "Passer maintenant · 1 skip"}</button>
      <button className="text-button" disabled={busy} onClick={async () => { setBusy(true); try { await spotifyCall(s.room.id, "sync"); await refresh(); } catch (e) { setError(String(e)); } finally { setBusy(false); } }}>Actualiser Spotify</button>
    </section>
    <h2>Mes chansons</h2><p className="muted">L’attente est estimée à partir de la file visible. Pauses, skips et changements dans Spotify peuvent la modifier. « Lecture détectée » signifie que le morceau a commencé, pas qu’il a été écouté jusqu’au bout.</p>
    {s.requests.filter(r => r.player_id === s.me.id && r.spotify_track).slice().reverse().map(r => <section className="panel" key={r.id}><Track track={r.spotify_track!} /><p>{playbackLabel(r, s.spotify)}</p>{r.reason && <p>{r.reason}</p>}</section>)}
  </>;
}
export function SpotifyHost({ s, refresh }: Props) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [devices, setDevices] = useState<{ id: string; name: string; active: boolean }[]>([]);
  async function run(action: string, data: Record<string, unknown> = {}) {
    setBusy(true); setError("");
    try {
      const result = await spotifyCall(s.room.id, action, data);
      if (result.busy) throw new Error("Une action Spotify est en cours. Réessayez dans quelques secondes.");
      if (action === "connect") { sessionStorage.setItem("jam:spotify-room", s.room.id); location.assign(result.url); return; }
      if (result.devices) setDevices(result.devices);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Spotify indisponible."); }
    finally { setBusy(false); }
  }
  return <section className="panel"><h2>Compte Spotify de la soirée</h2><p>Seul le responsable connecte son compte Premium. Les participants utilisent leurs jetons dans Jam.</p>
    <fieldset disabled={busy}>
      {!s.spotify?.connected ? <><p>Les demandes et skips seront envoyés automatiquement après leur création, sans validation supplémentaire.</p><button className="primary" onClick={() => void run("connect")}>Connecter Spotify</button></> : <>
        <NowPlaying s={s} />
        <div className="actions"><button className="secondary" onClick={() => void run("play")}>Lecture</button><button className="secondary" onClick={() => void run("pause")}>Pause</button><button className="secondary" onClick={() => void run("devices")}>Choisir l’appareil</button></div>
        {devices.map(d => <button key={d.id} className="secondary" onClick={() => void run("transfer", { deviceId: d.id })}>{d.name}{d.active ? " · actif" : ""}</button>)}
        <p className="muted">Si aucun appareil n’apparaît, ouvrez Spotify et démarrez la musique sur celui de la soirée.</p>
        {s.spotify.jobs?.filter(j => j.status === "uncertain").map(j => <div className="notice" key={j.id}><p>{s.requests.find(r => r.id === j.requestId)?.text}</p><p>{j.issue}</p><p>Vérifiez Spotify avant de répondre. La commande ne sera pas renvoyée.</p><button className="secondary" onClick={() => void run("resolve", { jobId: j.id, performed: true })}>Elle a été exécutée</button><button className="secondary" onClick={() => void run("resolve", { jobId: j.id, performed: false })}>Non exécutée · rendre le jeton</button></div>)}
        <button className="text-button" onClick={() => void run("connect")}>Reconnecter Spotify</button>
        <button className="text-button" onClick={() => void run("disconnect")}>Déconnecter Spotify</button>
      </>}
    </fieldset>{error && <p className="notice" role="alert">{error}</p>}
  </section>;
}
