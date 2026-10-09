import { NavIcon } from "./NavIcon";
import { SpotifyHost, SpotifyMusic } from "./Spotify";
import { InstallGuide, QuickStart, useInstallation } from "./GettingStarted";
import { actionFeedback, isMobileDevice, desktopNotificationsMessage } from "./feedback";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  command,
  configured,
  enablePush,
  newRecovery,
  pendingCommand,
  readState,
  SessionUnavailable,
  recoveryHash,
  storage,
  supabase,
  spotifyCall,
} from "./api";
import type { Assignment, Challenge, GameEvent, Request, State } from "./types";

function TaylorNotice({ event, roomId }: { event: GameEvent; roomId: string }) {
  const key = "dismissed-taylor:" + roomId;
  const [dismissed, setDismissed] = useState(() => storage.get(key));
  if (dismissed === event.id) return null;
  return <div className="taylor">
    <button className="taylor-close" aria-label="Fermer l’alerte Taylor Swift" onClick={() => {
      setDismissed(event.id);
      try { storage.set(key, event.id); } catch { /* Keep dismissal for this visit if storage is unavailable. */ }
    }}>×</button>
    {event.body}
    <small>Ajout confirmé à {time(event.created_at)}</small>
  </div>;
}

type Tab = "play" | "witness" | "music" | "dj" | "admin";
type Act = (kind: string, data?: Record<string, unknown>) => Promise<boolean>;
const labels: Record<string, string> = {
  pending: "À traiter",
  queued: "Ajoutée à la file",
  started: "Traitée",
  done: "Skip effectué",
  rejected: "Annulée · jeton restitué",
  assigned: "À vous de jouer",
  invited: "En attente du témoin",
  running: "Épreuve en cours",
  failed: "Épreuve non réussie",
};
const time = (value: string) =>
  new Date(value).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  });
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="empty">
      <span className="small-disc">♫</span>
      <p>{children}</p>
    </div>
  );
}
function normalizeRoomCode(value: string) {
  // Accept a pasted invitation link as well as a visually grouped code.
  try {
    const invitation = new URL(value.trim());
    value = invitation.searchParams.get("soiree") ?? value;
  } catch { /* Plain room code. */ }
  return value.replace(/[\s\-\u2010-\u2015\u2212]/g, "").toUpperCase();
}

function Copy({ text, label = "Copier" }: { text: string; label?: string }) {
  const [message, setMessage] = useState("");
  return (
    <>
      <button
        className="secondary compact"
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setMessage("Copié !");
          } catch {
            setMessage("Copie indisponible : sélectionnez le texte.");
          }
        }}
      >
        {label}
      </button>
      {message && <small role="status">{message}</small>}
    </>
  );
}
function Recovery({ roomId }: { roomId: string }) {
  const secret = storage.get("recovery:" + roomId);
  return (
    <details className="disclosure">
      <summary>Mon code personnel de récupération</summary>
      <p>
        Gardez ce code secret. Il permet de retrouver votre profil, vos jetons
        et vos rôles sur un autre appareil.
      </p>
      {secret ? (
        <>
          <code className="secret">{secret}</code>
          <Copy text={secret} label="Copier mon code" />
        </>
      ) : (
        <p>Utilisez le code sauvegardé lors de votre arrivée.</p>
      )}
    </details>
  );
}
function Access({
  enter,
  busy,
  run,
  showGuide,
}: {
  enter: (id: string) => void;
  busy: boolean;
  run: (work: () => Promise<void>) => Promise<void>;
  showGuide: () => void;
}) {
  const [mode, setMode] = useState<"join" | "create" | "recover">("join");
  const [code, setCode] = useState(
    normalizeRoomCode(new URLSearchParams(location.search).get("soiree") ?? ""),
  );
  const [name, setName] = useState("");
  const [roomName, setRoomName] = useState("");
  const [secret, setSecret] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      if (pendingCommand())
        throw new Error(
          "Vérifiez d’abord la dernière action en attente. Votre code personnel est conservé.",
        );
      const fresh = newRecovery();
      // Keep the secret before sending, including if the response is lost.
      storage.set("joiningSecret", fresh);
      const payload =
        mode === "create"
          ? { name, roomName, recoveryHash: await recoveryHash(fresh) }
          : mode === "recover"
            ? {
                code,
                recoveryHash: await recoveryHash(secret),
                newRecoveryHash: await recoveryHash(fresh),
              }
            : { code, name, recoveryHash: await recoveryHash(fresh) };
      const result = await command(mode, payload);
      if (result.roomId) {
        storage.set("recovery:" + result.roomId, fresh);
        storage.remove("joiningSecret");
        enter(result.roomId);
      }
    });
  }
  return (
    <main className="landing">
      <section className="intro">
        <p className="eyebrow">LES AMIS. LES DÉFIS. LE SON.</p>
        <h1>
          La soirée
          <br />
          se joue <em>ici.</em>
        </h1>
        <p className="intro-copy">
          Un défi dans le salon. Un témoin complice.
          <br />
          Et un jeton pour la prochaine chanson.
        </p>
        <div className="record" aria-hidden="true">
          <div className="record-label">
            <span>JAM</span>
            <small>SIDE A · ENTRE AMIS</small>
          </div>
        </div>
        <div className="intro-foot">
          <span className="dot" /> La musique continue, même sans jouer.
        </div>
      </section>
      <section className="entry panel">
        <div className="welcome-guide">
          <h2>Première soirée sur Jam ?</h2>
          <p>Un défi, un ami pour valider, puis une chanson à proposer.</p>
          <button className="secondary full" onClick={showGuide}>Comment jouer et installer Jam</button>
        </div>
        <div className="tabs access-tabs">
          {(["join", "create", "recover"] as const).map((m) => (
            <button
              key={m}
              className={mode === m ? "active" : ""}
              onClick={() => setMode(m)}
            >
              {m === "join"
                ? "Rejoindre"
                : m === "create"
                  ? "Créer"
                  : "Récupérer"}
            </button>
          ))}
        </div>
        <h2>
          {mode === "join"
            ? "On vous attend."
            : mode === "create"
              ? "À vous de lancer la soirée."
              : "Retrouvez votre place."}
        </h2>
        <p className="muted">
          {mode === "join"
            ? "Entrez le code partagé par votre hôte."
            : mode === "create"
              ? "Vous serez administrateur et responsable musical au départ."
              : "Votre code personnel restaure vos jetons et invalide l’ancien accès."}
        </p>
        {!configured && (
          <div className="notice">
            L’application est prête à être configurée. Connectez le projet à
            son serveur pour créer ou rejoindre une vraie soirée. Les instructions
            sont dans le fichier README.
          </div>
        )}
        <form onSubmit={submit}>
          <fieldset disabled={busy || !configured || !navigator.onLine}>
            {mode !== "create" && (
              <Field label="Code de la soirée">
                <input
                  autoComplete="off"
                  autoCapitalize="characters"
                  value={code}
                  onChange={(e) => setCode(normalizeRoomCode(e.target.value))}
                  placeholder="Le code de votre hôte"
                  required
                />
              </Field>
            )}
            {mode !== "recover" && (
              <Field label="Votre pseudo">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Comment vous appelle-t-on ?"
                  maxLength={30}
                  required
                  autoComplete="nickname"
                />
              </Field>
            )}
            {mode === "create" && (
              <Field label="Nom de la soirée">
                <input
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  placeholder="Samedi chez les copains"
                  maxLength={60}
                />
              </Field>
            )}
            {mode === "recover" && (
              <Field label="Votre code personnel secret">
                <input
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  autoComplete="off"
                  type="password"
                  required
                />
              </Field>
            )}
            <button className="primary full">
              {busy
                ? "Connexion…"
                : mode === "join"
                  ? "Rejoindre la soirée →"
                  : mode === "create"
                    ? "Créer ma soirée →"
                    : "Récupérer mon profil →"}
            </button>
          </fieldset>
        </form>
        <p className="footnote">
          Pas d’application à acheter. Votre musique, votre choix.
          <br />
          Juste vos amis et une connexion Internet.
        </p>
      </section>
    </main>
  );
}

function Countdown({ end, now }: { end: number; now: number }) {
  const seconds = Math.max(0, Math.ceil((end - now) / 1000));
  return (
    <div className={"timer " + (!seconds ? "expired" : "")}>
      <strong>
        {String(Math.floor(seconds / 60)).padStart(2, "0")}
        <span>:</span>
        {String(seconds % 60).padStart(2, "0")}
      </strong>
      <small>
        {seconds ? "TEMPS RESTANT" : "TEMPS ÉCOULÉ · VERDICT DU TÉMOIN ATTENDU"}
      </small>
    </div>
  );
}
function Play({ state: s, act, now }: { state: State; act: Act; now: number }) {
  const a = s.assignments.find((x) => x.player_id === s.me.id);
  const [witness, setWitness] = useState("");
  const cooldown = s.me.cooldown_until
    ? new Date(s.me.cooldown_until).getTime()
    : 0;
  const others = s.players.filter((p) => p.id !== s.me.id);
  const reserved = s.requests.some(
    (r) =>
      r.kind === "skip" && r.status === "pending" && r.player_id === s.me.id,
  );
  return (
    <>
      <div className="section-head">
        <div>
          <p className="eyebrow">LE JEU EST DANS LE SALON</p>
          <h1>À vous, {s.me.name}.</h1>
        </div>
        <span className="pill">{s.players.length} participants</span>
      </div>
      <div className="balances">
        <div>
          <span className="token">♫</span>
          <strong>{s.me.adds}</strong>
          <span>jeton{s.me.adds !== 1 ? "s" : ""} d’ajout</span>
        </div>
        <div>
          <span className="token orange">↠</span>
          <strong>{s.me.skip ? 1 : 0}</strong>
          <span>skip {reserved ? "réservé" : "disponible"}</span>
        </div>
      </div>
      <section className="panel challenge-card">
        <div className="card-top">
          <span className="eyebrow">
            {a?.kind === "sacrifice" ? "SACRIFICE LIQUIDE" : "VOTRE DÉFI"}
          </span>
          <span className="pill">{a ? labels[a.status] : "Prêt ?"}</span>
        </div>
        {!a ? (
          <>
            <h2>
              La prochaine chanson
              <br />
              commence par un défi.
            </h2>
            <p className="muted">
              Réalisez une épreuve, faites-la valider par un ami et gagnez un
              jeton d’ajout.
            </p>
            {cooldown > now ? (
              <>
                <p>Après un abandon, prenez dix minutes.</p>
                <Countdown end={cooldown} now={now} />
              </>
            ) : (
              <button className="primary" onClick={() => void act("draw")}>
                Tirer un défi ↗
              </button>
            )}
          </>
        ) : (
          <>
            <h2>{a.text}</h2>
            {a.duration && !a.started_at && (
              <p className="muted">
                {a.duration} secondes, à partir de l’acceptation du témoin.
              </p>
            )}
            {a.started_at && a.duration && (
              <Countdown
                end={new Date(a.started_at).getTime() + a.duration * 1000}
                now={now}
              />
            )}
            {a.witness_id && (
              <p>
                Témoin :{" "}
                <strong>
                  {s.players.find((p) => p.id === a.witness_id)?.name}
                </strong>
                {a.status === "invited" ? " · en attente de son accord" : ""}
              </p>
            )}
            {a.status === "failed" ? (
              <div className="notice">
                {a.kind === "sacrifice"
                  ? "Le sacrifice a été refusé. Vous pouvez abandonner."
                  : "Le défi n’a pas été réussi. Choisissez le sacrifice ou abandonnez."}
              </div>
            ) : (
              <div className="witness-picker">
                <Field
                  label={
                    a.witness_id ? "Changer de témoin" : "Choisir un témoin"
                  }
                >
                  <select
                    value={witness}
                    onChange={(e) => setWitness(e.target.value)}
                  >
                    <option value="">Sélectionnez un ami</option>
                    {others.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
                {!others.length && (
                  <p className="muted">
                    Invitez un ami à rejoindre la soirée pour commencer.
                  </p>
                )}
                <button
                  className="secondary"
                  disabled={!witness}
                  onClick={() => {
                    if (
                      a.status !== "running" ||
                      confirm(
                        "Le témoin est indisponible ? La tentative actuelle sera annulée et recommencera avec un nouveau témoin.",
                      )
                    )
                      void act("invite", {
                        assignmentId: a.id,
                        witnessId: witness,
                        unavailable: a.status === "running",
                      });
                  }}
                >
                  {a.status === "running"
                    ? "Remplacer le témoin indisponible"
                    : "Demander son accord"}
                </button>
              </div>
            )}
            <div className="actions">
              {a.kind === "challenge" && (
                <button
                  className="secondary"
                  disabled={!s.room.sacrifice.trim()}
                  onClick={() => {
                    if (
                      confirm(
                        "Remplacer ce défi par le sacrifice liquide configuré ? Une nouvelle acceptation sera nécessaire.",
                      )
                    )
                      void act("sacrifice", { assignmentId: a.id });
                  }}
                >
                  Choisir le sacrifice liquide
                </button>
              )}
              <button
                className="text-button danger"
                onClick={() => {
                  if (
                    confirm(
                      "Abandonner cette épreuve ? Vous devrez attendre dix minutes avant le prochain défi.",
                    )
                  )
                    void act("abandon", { assignmentId: a.id });
                }}
              >
                Abandonner
              </button>
            </div>
            {a.kind === "challenge" && !s.room.sacrifice.trim() && (
              <small className="muted">
                Le sacrifice liquide n’a pas encore été configuré.
              </small>
            )}
          </>
        )}
      </section>
      <Recovery roomId={s.room.id} />
    </>
  );
}
function WitnessCard({
  a,
  s,
  act,
  now,
}: {
  a: Assignment;
  s: State;
  act: Act;
  now: number;
}) {
  const [inTime, setInTime] = useState(false);
  return (
    <section className="panel">
      <div className="card-top">
        <span className="eyebrow">
          {s.players.find((p) => p.id === a.player_id)?.name}
        </span>
        <span className="pill">{labels[a.status]}</span>
      </div>
      <h2>{a.text}</h2>
      {a.duration && a.started_at && (
        <Countdown
          end={new Date(a.started_at).getTime() + a.duration * 1000}
          now={now}
        />
      )}
      {a.status === "invited" ? (
        <>
          <p>
            Acceptez seulement lorsque vous êtes prêt à constater l’épreuve.
            {a.duration ? " Votre accord déclenche le chronomètre." : ""}
          </p>
          <div className="actions">
            <button
              className="primary"
              onClick={() =>
                void act("accept", {
                  assignmentId: a.id,
                  attemptId: a.attempt_id,
                })
              }
            >
              Accepter et commencer
            </button>
            <button
              className="secondary"
              onClick={() =>
                void act("decline", {
                  assignmentId: a.id,
                  attemptId: a.attempt_id,
                })
              }
            >
              Décliner
            </button>
          </div>
        </>
      ) : (
        <>
          {a.duration && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={inTime}
                onChange={(e) => setInTime(e.target.checked)}
              />
              J’atteste que la réussite a eu lieu dans le temps imparti, même si
              je valide après.
            </label>
          )}
          <div className="actions">
            <button
              className="primary"
              disabled={Boolean(a.duration) && !inTime}
              onClick={() =>
                void act("verdict", {
                  assignmentId: a.id,
                  attemptId: a.attempt_id,
                  success: true,
                  inTime,
                })
              }
            >
              Valider la réussite
            </button>
            <button
              className="secondary"
              onClick={() => {
                if (
                  confirm(
                    "Confirmer l’échec ? Le joueur ne pourra pas retenter ce défi.",
                  )
                )
                  void act("verdict", {
                    assignmentId: a.id,
                    attemptId: a.attempt_id,
                    success: false,
                  });
              }}
            >
              Refuser la réussite
            </button>
          </div>
        </>
      )}
    </section>
  );
}
function Music({ s, act }: { s: State; act: Act }) {
  const [text, setText] = useState("");
  const waiting = s.requests.find(
    (r) =>
      r.player_id === s.me.id &&
      r.kind === "song" &&
      r.status === "pending",
  );
  const skip = s.requests.find(
    (r) => r.kind === "skip" && r.status === "pending",
  );
  return (
    <>
      <p className="eyebrow">VOTRE TOUR DE CHOISIR</p>
      <h1>La bande-son.</h1>
      <p className="muted">
        Ajoutez une chanson : la personne qui contrôle la musique sera prévenue de votre demande.
      </p>
      <section className="panel">
        <div className="card-top">
          <h2>Proposer une chanson</h2>
          <span className="pill">
            {s.me.adds} jeton{s.me.adds !== 1 ? "s" : ""}
          </span>
        </div>
        {waiting ? (
          <>
            <p className="song-title">{waiting.text}</p>
            <span className="pill">{labels[waiting.status]}</span>
            <p className="muted">
              Vous pourrez proposer une autre chanson dès que celle-ci sera
              ajoutée à la file.
            </p>
          </>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (await act("song", { text })) setText("");
            }}
          >
            <Field label="Chanson et artiste, dans vos mots">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Blinding Lights — The Weeknd"
                required
                maxLength={500}
              />
            </Field>
            <button
              className="primary"
              disabled={s.me.adds < 1 || !text.trim()}
            >
              Proposer · 1 jeton
            </button>
            {s.me.adds < 1 && (
              <p className="muted">
                Faites valider une épreuve pour gagner votre premier jeton.
              </p>
            )}
          </form>
        )}
      </section>
      <section className="panel skip-card">
        <div>
          <p className="eyebrow">ENVIE DE PASSER À LA SUITE ?</p>
          <h2>Demander un skip</h2>
          <p className="muted">
            Passe au prochain morceau de la file, sans donner de priorité à
            votre chanson.
          </p>
        </div>
        <button
          className="secondary"
          disabled={!s.me.skip || Boolean(skip)}
          onClick={() => void act("skip")}
        >
          {skip ? "Un skip est déjà en attente" : "Demander · 1 skip"}
        </button>
      </section>
      <h2 className="subheading">Vos demandes</h2>
      {s.requests.filter((r) => r.player_id === s.me.id).length ? (
        s.requests
          .filter((r) => r.player_id === s.me.id)
          .slice()
          .reverse()
          .map((r) => (
            <div className="list-row" key={r.id}>
              <div>
                <strong>{r.text}</strong>
                <small>
                  {time(r.created_at)}
                  {r.reason && " · " + r.reason}
                </small>
              </div>
              <span className="pill">{labels[r.status]}</span>
            </div>
          ))
      ) : (
        <Empty>Aucune demande pour le moment. La playlist continue.</Empty>
      )}
    </>
  );
}
function RequestCard({ r, s, act }: { r: Request; s: State; act: Act }) {
  const [reject, setReject] = useState(false);
  const [reason, setReason] = useState("");
  const [performed, setPerformed] = useState(false);
  return (
    <section className="panel">
      <div className="card-top">
        <span className="eyebrow">
          {r.kind === "skip" ? "↠ SKIP" : "♫ CHANSON"} ·{" "}
          {s.players.find((p) => p.id === r.player_id)?.name}
        </span>
        <span className="pill">{labels[r.status]}</span>
      </div>
      <h2 className="song-title">{r.text}</h2>
      <p className="muted">Reçue à {time(r.created_at)}</p>
      {r.kind === "song" ? (
        <>
          <Copy text={r.text} label="Copier la demande" />
          <div className="actions">
            {r.status === "pending" && (
              <button
                className="secondary"
                onClick={() => void act("queue", { requestId: r.id })}
              >
                Ajouté à la file
              </button>
            )}

          </div>
        </>
      ) : (
        <>
          <p>
            Vérifiez que le morceau visé n’a pas déjà changé naturellement. Dans
            ce cas, annulez et restituez le jeton.
          </p>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={performed}
              onChange={(e) => setPerformed(e.target.checked)}
            />
            J’ai réellement passé le morceau dans votre application musicale.
          </label>
          <button
            className="primary"
            disabled={!performed}
            onClick={() =>
              void act("skip_done", { requestId: r.id, performed })
            }
          >
            Confirmer le skip
          </button>
        </>
      )}
      <button className="text-button danger" onClick={() => setReject(!reject)}>
        {reject ? "Fermer l’annulation" : "Impossible à traiter / annuler"}
      </button>
      {reject && (
        <form
          className="reject-form"
          onSubmit={async (e) => {
            e.preventDefault();
            await act("reject", { requestId: r.id, reason });
          }}
        >
          <Field label="Motif de l’annulation">
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              maxLength={300}
              placeholder={
                r.kind === "skip"
                  ? "Le morceau a déjà changé naturellement"
                  : "Morceau introuvable"
              }
            />
          </Field>
          <button
            className="secondary"
            disabled={!reason.trim()}
          >
            Annuler et restituer le jeton
          </button>
        </form>
      )}
    </section>
  );
}
function ChallengeEditor({
  challenge,
  act,
}: {
  challenge?: Challenge;
  act: Act;
}) {
  const [text, setText] = useState(challenge?.text ?? "");
  const [duration, setDuration] = useState(
    challenge?.duration?.toString() ?? "",
  );
  const [active, setActive] = useState(challenge?.active ?? true);
  return (
    <form
      className="challenge-editor"
      onSubmit={async (e) => {
        e.preventDefault();
        if (
          (await act("challenge", {
            challengeId: challenge?.id,
            text,
            duration: duration || null,
            active,
          })) &&
          !challenge
        ) {
          setText("");
          setDuration("");
        }
      }}
    >
      <Field label={challenge ? "Texte du défi" : "Nouveau défi"}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={1000}
          required
        />
      </Field>
      <div className="editor-bottom">
        <Field label="Durée en secondes (facultative)">
          <input
            type="number"
            min="1"
            max="3600"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
          />
        </Field>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
          Actif
        </label>
        <button className="secondary">
          {challenge ? "Enregistrer le défi" : "Ajouter le défi"}
        </button>
      </div>
    </form>
  );
}
function Admin({ s, act }: { s: State; act: Act }) {
  const [bonus, setBonus] = useState(s.room.bonus);
  const [sacrifice, setSacrifice] = useState(s.room.sacrifice);
  const [musicId, setMusicId] = useState(s.room.music_id);
  const [removing, setRemoving] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [confirmationCode, setConfirmationCode] = useState("");
  return (
    <>
      <p className="eyebrow">À VOTRE FAÇON</p>
      <h1>Les règles de la maison.</h1>
      <section className="panel">
        <h2>Les participants</h2>
        <p className="muted">Supprimer un joueur efface son profil, ses jetons et ses demandes dans cette soirée. Il pourra revenir avec un nouveau profil.</p>
        {s.players.map((player) => (
          <div className="challenge-editor" key={player.id}>
            <p><strong>{player.name}</strong>{player.id === s.room.admin_id ? " · Administrateur" : ""}{player.id === s.room.music_id ? " · Responsable musical" : ""}</p>
            {player.id !== s.me.id && (removing === player.id ? (
              <div role="group" aria-label={`Confirmer la suppression de ${player.name}`}>
                <p>Supprimer définitivement le profil de {player.name} ? Ses demandes seront annulées. Les chansons déjà ajoutées à votre application musicale y resteront.</p>
                <p>Ses épreuves comme témoin seront interrompues pour permettre de choisir quelqu’un d’autre. Les échecs déjà validés resteront des échecs.</p>
                {player.id === s.room.music_id && <p>Vous reprendrez le rôle de responsable musical.</p>}
                <div className="actions">
                  <button className="secondary" onClick={() => setRemoving(null)}>Annuler</button>
                  <button className="danger" onClick={async () => {
                    if (await act("remove_player", { playerId: player.id, confirmed: true })) setRemoving(null);
                  }}>Supprimer définitivement ce joueur</button>
                </div>
              </div>
            ) : <button className="secondary" onClick={() => setRemoving(player.id)}>Supprimer {player.name}</button>)}
          </div>
        ))}
      </section>
      <section className="panel">
        <h2>Réglages de la soirée</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act("settings", { bonus, sacrifice, musicId });
          }}
        >
          <Field label="Responsable musical">
            <select
              value={musicId}
              onChange={(e) => setMusicId(e.target.value)}
            >
              {s.players.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Probabilité du bonus skip (%)">
            <input
              type="number"
              value={bonus}
              min="0"
              max="100"
              required
              onChange={(e) => setBonus(Number(e.target.value))}
            />
          </Field>
          <p className="muted">
            0 % par défaut. Le taux est appliqué lors de la validation d’un
            défi.
          </p>
          <Field label="Contenu du sacrifice liquide">
            <textarea
              value={sacrifice}
              onChange={(e) => setSacrifice(e.target.value)}
              maxLength={1000}
              placeholder="Définissez librement le gage proposé à la place d’un défi."
            />
          </Field>
          <button className="primary">Enregistrer les réglages</button>
        </form>
      </section>
      <section className="panel">
        <h2>Les défis</h2>
        <p className="muted">
          Les changements s’appliquent aux prochains défis tirés. Les épreuves
          en cours conservent leur texte et leur durée.
        </p>
        {s.challenges.map((c) => (
          <ChallengeEditor
            key={c.id + c.text + c.duration + c.active}
            challenge={c}
            act={act}
          />
        ))}
        <ChallengeEditor act={act} />
      </section>
      <section className="panel">
        <h2>Clore et effacer la soirée</h2>
        <p>Cette action supprime définitivement la soirée pour tout le monde : profils, jetons, défis et demandes. Les codes d’accès ne fonctionneront plus.</p>
        <p className="muted">Une soirée sans ouverture ni action pendant six mois est également supprimée automatiquement. Si le serveur est en pause, le nettoyage reprend à sa réactivation.</p>
        {closing ? <form onSubmit={(e) => {
          e.preventDefault();
          void act("delete_room", { confirmed: true, roomCode: normalizeRoomCode(confirmationCode) });
        }}>
          <p>Pour confirmer, recopiez le code <strong>{s.room.code}</strong>.</p>
          <Field label="Code de confirmation de suppression">
            <input required autoComplete="off" value={confirmationCode} onChange={(e) => setConfirmationCode(e.target.value)} />
          </Field>
          <div className="actions">
            <button type="button" className="secondary" onClick={() => { setClosing(false); setConfirmationCode(""); }}>Annuler</button>
            <button className="danger" disabled={normalizeRoomCode(confirmationCode) !== s.room.code}>Effacer définitivement la soirée</button>
          </div>
        </form> : <button className="danger" onClick={() => setClosing(true)}>Clore et effacer la soirée</button>}
      </section>
    </>
  );
}

export default function App() {
  const installation = useInstallation();
  const [roomId, setRoomId] = useState(storage.get("room"));
  const activeRoom = useRef(roomId);
  const [state, setState] = useState<State | null>(() => {
    try {
      const saved = JSON.parse(storage.get("snapshot") ?? "null");
      return saved?.room.id === storage.get("room") ? saved : null;
    } catch {
      return null;
    }
  });
  const [tab, setTab] = useState<Tab>("play");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [connected, setConnected] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [now, setNow] = useState(Date.now());
  const clockOffset = useRef(0);
  const refreshRef = useRef(false);
  const spotifySyncRef = useRef(false);
  const spotifyCallbackRef = useRef(false);
  const [page, setPage] = useState<"help" | "share" | null>(null);
  const clearRoom = useCallback((id: string | null) => {
    if (id) storage.remove("recovery:" + id);
    storage.remove("room");
    storage.remove("snapshot");
    storage.remove("pending");
    activeRoom.current = null;
    setRoomId(null);
    setState(null);
    setConnected(false);
    setPage(null);
    setTab("play");
    history.replaceState(null, "", "/");
  }, []);
  const enter = (id: string) => {
    setPage(null);
    activeRoom.current = id;
    storage.set("room", id);
    setRoomId(id);
    setState(null);
    setTab("play");
    history.replaceState(null, "", "/");
  };
  const refresh = useCallback(async () => {
    if (!roomId || !configured || !navigator.onLine || refreshRef.current)
      return;
    refreshRef.current = true;
    try {
      const snapshot = await readState(roomId);
      if (activeRoom.current !== roomId) return;
      setState(snapshot);
      if (snapshot.spotify?.connected && !spotifySyncRef.current) {
        spotifySyncRef.current = true;
        void spotifyCall(roomId, "sync").catch(() => {}).finally(() => { spotifySyncRef.current = false; });
      }
      setConnected(true);
      clockOffset.current = Date.parse(snapshot.serverTime) - Date.now();
      setNow(Date.parse(snapshot.serverTime));
      try {
        storage.set("snapshot", JSON.stringify(snapshot));
      } catch {
        /* The server remains authoritative if local storage is full. */
      }
    } catch (e) {
      if (activeRoom.current !== roomId) return;
      if (e instanceof SessionUnavailable) clearRoom(roomId);
      setConnected(false);
      setError(e instanceof Error ? e.message : "Connexion indisponible.");
    } finally {
      refreshRef.current = false;
    }
  }, [roomId, clearRoom]);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("spotify") !== "callback" || spotifyCallbackRef.current) return;
    spotifyCallbackRef.current = true;
    const id = sessionStorage.getItem("jam:spotify-room");
    sessionStorage.removeItem("jam:spotify-room");
    history.replaceState(null, "", "/");
    void run(async () => {
      if (!id || !params.get("code") || params.get("error")) throw new Error("Connexion Spotify annulée ou expirée. Recommencez depuis la régie.");
      await spotifyCall(id, "callback", { code: params.get("code"), state: params.get("state") });
      setTab("dj");
      setMessage("Spotify est connecté. Lancez la musique sur l’appareil de la soirée.");
      await refresh();
    });
  }, [refresh]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5000);
    const resume = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", resume);
    navigator.serviceWorker?.addEventListener("message", resume);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
      navigator.serviceWorker?.removeEventListener("message", resume);
    };
  }, [refresh]);
  useEffect(() => {
    const timer = setInterval(
      () => setNow(Date.now() + clockOffset.current),
      1000,
    );
    const status = () => {
      setOnline(navigator.onLine);
      if (!navigator.onLine) setConnected(false);
      else void refresh();
    };
    window.addEventListener("online", status);
    window.addEventListener("offline", status);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", status);
      window.removeEventListener("offline", status);
    };
  }, [refresh]);
  async function run(work: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Une erreur est survenue.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  const act: Act = async (kind, data = {}) => {
    let ok = false;
    await run(async () => {
      if (kind === "test_push" && !isMobileDevice()) throw new Error(desktopNotificationsMessage);
      const result = await command(kind, { roomId, ...data });
      if (kind.startsWith("spotify_") && roomId) {
        try { await spotifyCall(roomId, "sync"); } catch { /* The persisted job remains visible and will be retried by synchronization. */ }
      }
      ok = true;
      setMessage(actionFeedback(kind, data));
      if (result.deleted) clearRoom(roomId);
      else await refresh();
    });
    return ok;
  };
  async function retry() {
    await run(async () => {
      const p = pendingCommand();
      if (!p) return;
      const result = await command(p.kind, p.payload);
      if (result.deleted) clearRoom(roomId);
      else if (result.roomId) {
        const secret = storage.get("joiningSecret");
        if (secret) storage.set("recovery:" + result.roomId, secret);
        storage.remove("joiningSecret");
        enter(result.roomId);
      } else await refresh();
      setMessage(actionFeedback(p.kind, p.payload));
    });
  }
  async function leave() {
    if (
      !confirm(
        "Votre progression reste sur le serveur. Avez-vous conservé votre code personnel ?",
      )
    )
      return;
    await run(async () => {
      if (pendingCommand())
        throw new Error("Vérifiez d’abord la dernière action en attente.");
      const reg = await navigator.serviceWorker?.getRegistration();
      const sub = await reg?.pushManager?.getSubscription();
      if (sub && state && online)
        await command("unsubscribe", { roomId, endpoint: sub.endpoint });
      await sub?.unsubscribe();
      await supabase?.auth.signOut();
      setPage(null);
      storage.remove("room");
      storage.remove("snapshot");
      activeRoom.current = null;
      setRoomId(null);
      setState(null);
      setConnected(false);
    });
  }
  const invitations =
    state?.assignments.filter(
      (a) =>
        a.witness_id === state.me.id &&
        ["invited", "running"].includes(a.status),
    ) ?? [];
  const tasks =
    state?.requests.filter((r) => r.status === "pending") ??
    [];
  const tabs: { id: Tab; text: string; count?: number }[] = [
    { id: "play", text: "Jouer" },
    {
      id: "witness",
      text: "Témoigner",
      count: invitations.length,
    },
    { id: "music", text: "Musique" },
  ];
  if (state?.me.id === state?.room.music_id && state)
    tabs.push({ id: "dj", text: "Régie", count: tasks.length });
  if (state?.me.id === state?.room.admin_id && state)
    tabs.push({ id: "admin", text: "Réglages" });
  const currentTab = page ? null : tabs.some((t) => t.id === tab) ? tab : "play";
  const taylor = state?.events.find((e) => e.kind === "taylor");
  const helpContent = (
        <section className="panel auxiliary-page">
          <button className="text-button" onClick={() => setPage(null)}>← Retour</button>
          <h1>Aide et installation</h1>
          <h2>Votre première chanson en trois étapes</h2>
          <QuickStart />
          <p className="muted">Jouer est facultatif. La musique continue pendant que vous profitez de la soirée.</p>
          {state && !installation.installed && <>
            <p>Avant l’installation, gardez votre code personnel. Si Jam vous redemande un profil, choisissez « Récupérer » avec ce code et celui de la soirée.</p>
            <Recovery roomId={state.room.id} />
          </>}
          <InstallGuide installation={installation} />
          {(state?.room.code || new URLSearchParams(location.search).get("soiree")) && <div className="notice">
            <p>Gardez aussi le code de la soirée pour la retrouver après l’installation.</p>
            <code className="secret">{state?.room.code ?? normalizeRoomCode(new URLSearchParams(location.search).get("soiree") ?? "")}</code>
          </div>}
          <h2>Être prévenu sur son téléphone</h2>
          <p>
            Activez les notifications pour être prévenu même quand Jam est fermé. Si vous n’en recevez pas, vos demandes et invitations restent visibles dans l’application.
          </p>
          {!state && <p>Une fois dans la soirée, revenez ici avec le bouton « ? » pour activer et tester les notifications. Sur iPhone, ouvrez d’abord Jam depuis son icône sur l’écran d’accueil.</p>}
          {state && (
            <div className="actions">
              {!isMobileDevice() ? <p role="note">{desktopNotificationsMessage}</p> : <>
              <button
                className="secondary"
                disabled={busy || !online}
                onClick={() =>
                  void run(async () => {
                    await enablePush(state.room.id);
                    setMessage(
                      "Notifications activées. Utilisez le bouton de test.",
                    );
                  })
                }
              >
                Activer les notifications
              </button>
              <button
                className="secondary"
                disabled={busy || !online}
                onClick={() => void act("test_push")}
              >
                Tester mes notifications
              </button>
              </>}
              <button className="text-button" onClick={() => void leave()}>
                Quitter ce profil
              </button>
            </div>
          )}
        </section>

  );
  const shareContent = state && (
            <section id="room-share" className="panel auxiliary-page">
              <button className="text-button" onClick={() => setPage(null)}>← Retour</button>
              <h1>Inviter des amis</h1>
              <div className="share">
              <QRCodeSVG
                value={location.origin + "/?soiree=" + normalizeRoomCode(state.room.code)}
                title="Scanner pour rejoindre la soirée"
                size={200}
                bgColor="#ffffff"
                fgColor="#101a17"
                marginSize={3}
              />
              <div>
                <h2>{state.room.name}</h2>
                <p>Scannez ce QR code ou partagez le lien.</p>
                <p>Code de la soirée</p>
                <code className="secret">{normalizeRoomCode(state.room.code)}</code>
                <Copy text={normalizeRoomCode(state.room.code)} label="Copier le code sans tirets" />
                <Copy
                  text={location.origin + "/?soiree=" + normalizeRoomCode(state.room.code)}
                  label="Copier le lien d’invitation"
                />
                <Copy label="Copier un message pour les amis" text={`Rejoins notre soirée sur Jam : ${location.origin}/?soiree=${normalizeRoomCode(state.room.code)}\nCode : ${normalizeRoomCode(state.room.code)}\nChoisis ton pseudo, relève un défi avec un ami comme témoin, puis propose ta chanson !\nPour installer Jam sur ton téléphone, ouvre « Comment jouer et installer Jam » sur l’accueil. Tu peux aussi jouer sans installer.`} />
              </div>
            </div></section>

  );
  return (
    <>
      <header className="site-header">
        <a className="brand" href="/" aria-label="Jam, accueil">
          jam<span>●</span>
        </a>
        <div className="header-right">
          {state && (
            <button className="room-button" aria-pressed={page === "share"} onClick={() => setPage(page === "share" ? null : "share")}>
              Inviter · QR code <span>↗</span>
            </button>
          )}
          <span
            className={
              "connection " + (online && (!roomId || connected) ? "ok" : "")
            }
          >
            <i />
            {!online
              ? "Hors connexion"
              : roomId
                ? connected
                  ? "Connecté"
                  : "Reconnexion…"
                : "Entre amis"}
          </span>
          <button
            className="help-button"
            aria-pressed={page === "help"}
            onClick={() => setPage(page === "help" ? null : "help")}
            aria-label="Aide et installation"
          >
            ?
          </button>
        </div>
      </header>
      {error && (
        <div className="flash error" role="alert">
          <span>{error}</span>
          <button aria-label="Fermer l’erreur" onClick={() => setError("")}>
            ×
          </button>
        </div>
      )}
      {message && (
        <div className="flash success" role="status">
          <span>{message}</span>
          <button aria-label="Fermer le message" onClick={() => setMessage("")}>
            ×
          </button>
        </div>
      )}
      {pendingCommand() && (
        <div className="flash notice">
          <span>Une action attend la confirmation du serveur.</span>
          <button
            className="secondary compact"
            disabled={busy || !online}
            onClick={() => void retry()}
          >
            Vérifier la dernière action
          </button>
        </div>
      )}
      {page === "help" && !state ? <main className="game-main">{helpContent}</main> : roomId && !state ? (
        <main className="loading panel">
          <h1>Retrouvons votre soirée.</h1>
          <p>
            {configured
              ? "Connexion au serveur…"
              : "Configurez le serveur pour activer cette application."}
          </p>
          <button className="secondary" onClick={() => void refresh()}>
            Réessayer
          </button>
          <button
            className="text-button"
            onClick={() => {
              storage.remove("room");
              activeRoom.current = null;
              setRoomId(null);
            }}
          >
            Revenir à l’accueil
          </button>
        </main>
      ) : !state ? (
        <Access enter={enter} busy={busy} run={run} showGuide={() => setPage("help")} />
      ) : (
        <>
          {taylor && !page && (
            <TaylorNotice key={state.room.id} event={taylor} roomId={state.room.id} />
          )}
          <div className="app-layout">
            <nav className="navigation" aria-label="Navigation principale">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  className={currentTab === t.id ? "active" : ""}
                  onClick={() => { setPage(null); setTab(t.id); window.scrollTo(0, 0); }}
                >
                  <NavIcon name={t.id} />
                  <span>{t.text}</span>
                  {!!t.count && <b>{t.count}</b>}
                </button>
              ))}
              <div className="nav-note">
                La soirée continue.
                <br />
                Jouez quand vous voulez.
              </div>
            </nav>
            <main className="game-main">
              {page === "help" ? helpContent : page === "share" ? shareContent : <>
              <fieldset
                className="game-fieldset"
                disabled={busy || !online || !connected}
              >
                {currentTab === "play" && (
                  <Play state={state} act={act} now={now} />
                )}
                {currentTab === "witness" && (
                  <>
                    <p className="eyebrow">VOUS ÊTES AUX PREMIÈRES LOGES</p>
                    <h1>Parole de témoin.</h1>
                    {invitations.length ? (
                      invitations.map((a) => (
                        <WitnessCard
                          key={a.attempt_id}
                          a={a}
                          s={state}
                          act={act}
                          now={now}
                        />
                      ))
                    ) : (
                      <Empty>
                        Aucune invitation en attente. Profitez de la soirée.
                      </Empty>
                    )}
                  </>
                )}
                {currentTab === "music" && (state.spotify?.connected ? <SpotifyMusic s={state} act={act} refresh={refresh} /> : <Music s={state} act={act} />)}
                {currentTab === "dj" && (
                  <>
                    <p className="eyebrow">AUX COMMANDES DE LA MUSIQUE</p>
                    <h1>La régie.</h1>
                    <SpotifyHost s={state} refresh={refresh} />
                    {!state.spotify?.connected && <>
                    <p className="muted">
                      Agissez d’abord dans votre application musicale, puis confirmez ici. L’ordre
                      affiché est l’ordre d’arrivée des demandes.
                    </p>
                    {tasks.length ? (
                      tasks.map((r) => (
                        <RequestCard key={r.id} r={r} s={state} act={act} />
                      ))
                    ) : (
                      <Empty>
                        Tout est à jour. Laissez tourner la playlist.
                      </Empty>
                    )}
                    </>}
                    <h2 className="subheading">Activité de la soirée</h2>
                    {state.events.map((e) => (
                      <div className="list-row" key={e.id}>
                        <p>{e.body}</p>
                        <small>{time(e.created_at)}</small>
                      </div>
                    ))}
                  </>
                )}
                {currentTab === "admin" && (
                  <Admin
                    key={
                      state.room.bonus +
                      "|" +
                      state.room.sacrifice +
                      "|" +
                      state.room.music_id
                    }
                    s={state}
                    act={act}
                  />
                )}
              </fieldset>
              {!online || !connected ? (
                <div className="notice">
                  Connexion interrompue. Les actions sont désactivées jusqu’à la
                  synchronisation avec le serveur.
                </div>
              ) : null}
              </>}
            </main>
          </div>
        </>
      )}
      <footer className="site-footer">
        <span>JAM · LA SOIRÉE VOUS APPARTIENT</span>
        <span>La musique se passe dans votre application musicale. Le jeu, ici.</span>
      </footer>
    </>
  );
}
