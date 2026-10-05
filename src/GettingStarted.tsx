import { useEffect, useRef, useState } from "react";

type InstallPrompt = Event & {
  prompt: () => Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function useInstallation() {
  const standalone = () => window.matchMedia("(display-mode: standalone)").matches ||
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  const [installed, setInstalled] = useState(standalone);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const pending = useRef<InstallPrompt | null>(null);
  useEffect(() => {
    const media = window.matchMedia("(display-mode: standalone)");
    const offered = (event: Event) => {
      event.preventDefault();
      pending.current = event as InstallPrompt;
      setAvailable(true);
    };
    const done = () => {
      setInstalled(true);
      setAvailable(false);
      pending.current = null;
      setMessage("");
    };
    const changed = () => { if (standalone()) done(); };
    window.addEventListener("beforeinstallprompt", offered);
    window.addEventListener("appinstalled", done);
    media.addEventListener("change", changed);
    return () => {
      window.removeEventListener("beforeinstallprompt", offered);
      window.removeEventListener("appinstalled", done);
      media.removeEventListener("change", changed);
    };
  }, []);
  async function install() {
    const event = pending.current;
    if (!event) return;
    pending.current = null;
    setAvailable(false);
    setBusy(true);
    try {
      const result = await event.prompt();
      setMessage(result.outcome === "accepted"
        ? "Installation demandée. Retrouvez ensuite l’icône Jam sur votre écran d’accueil."
        : "Vous pouvez continuer à jouer ici et installer Jam plus tard.");
    } catch {
      setMessage("L’installation directe n’a pas abouti. Suivez les étapes ci-dessous.");
    } finally { setBusy(false); }
  }
  return { installed, available, busy, message, install };
}

export function QuickStart() {
  return <ol className="guide-steps">
    <li><strong>Rejoignez vos amis.</strong><span>Entrez le code de la soirée et choisissez votre pseudo.</span></li>
    <li><strong>Relevez un défi.</strong><span>Choisissez un ami comme témoin. Il accepte avant le départ, puis valide votre réussite.</span></li>
    <li><strong>Proposez votre chanson.</strong><span>Utilisez le jeton gagné dans « Musique ». La personne aux commandes reçoit votre demande et l’ajoute à la file.</span></li>
  </ol>;
}

export function InstallGuide({ installation }: { installation: ReturnType<typeof useInstallation> }) {
  const [device, setDevice] = useState<"ios" | "android">(() =>
    /iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1) ? "ios" : "android");
  return <section className="install-guide" aria-label="Installation de Jam">
    <h2>Jam sur votre écran d’accueil</h2>
    {installation.installed ? <p role="status">Jam est déjà installé ou ouvert comme une application. Retrouvez-le grâce à son icône sur votre écran d’accueil.</p> : <>
      <p>Gardez Jam à portée de main, comme vos autres applications. C’est gratuit et vous pouvez aussi jouer ici sans l’installer.</p>
      {installation.available && <button className="primary" disabled={installation.busy} onClick={() => void installation.install()}>Installer Jam</button>}
      <div className="actions" role="group" aria-label="Votre téléphone">
        <button className="secondary" aria-pressed={device === "ios"} onClick={() => setDevice("ios")}>iPhone / iPad</button>
        <button className="secondary" aria-pressed={device === "android"} onClick={() => setDevice("android")}>Android</button>
      </div>
      {device === "ios" ? <ol className="guide-steps">
        <li><strong>Ouvrez le menu Partager.</strong><span>Cherchez le carré avec une flèche vers le haut <svg className="share-symbol" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3m-4 4 4-4 4 4M7 10H4v11h16V10h-3" /></svg>. Selon votre navigateur, il est dans le menu « … ».</span></li>
        <li><strong>Choisissez « Sur l’écran d’accueil ».</strong><span>Faites défiler les actions si nécessaire. Le libellé peut être « Ajouter à l’écran d’accueil ». Si « Ouvrir comme app web » apparaît, laissez cette option activée.</span></li>
        <li><strong>Appuyez sur « Ajouter ».</strong><span>Revenez à l’écran d’accueil de votre téléphone, puis ouvrez la nouvelle icône Jam.</span></li>
      </ol> : <ol className="guide-steps">
        <li><strong>Ouvrez le menu du navigateur.</strong><span>Appuyez sur les trois points « ⋮ », généralement près de la barre d’adresse.</span></li>
        <li><strong>Choisissez « Installer l’application ».</strong><span>L’option peut aussi s’appeler « Ajouter à l’écran d’accueil ». Confirmez l’ajout.</span></li>
        <li><strong>Ouvrez l’icône Jam.</strong><span>Retrouvez-la sur l’écran d’accueil ou dans la liste des applications de votre téléphone.</span></li>
      </ol>}
      <details className="disclosure"><summary>Je ne trouve pas l’option</summary><p>Si le lien est ouvert dans une messagerie, utilisez son menu pour l’ouvrir dans votre navigateur habituel. Sur iPhone, essayez Safari. Les menus varient selon le navigateur et sa version.</p></details>
    </>}
    {installation.message && <p role="status">{installation.message}</p>}
  </section>;
}
