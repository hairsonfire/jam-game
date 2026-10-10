import { useEffect, useRef, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

// Separate session: signing in here never replaces a player's guest identity.
const client = import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY
  ? createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, {
      auth: {storageKey: 'jam-owner-auth', storage: window.sessionStorage},
    }) : null;
type Room = {id: string; name: string; code: string; created_at: string; last_activity_at: string; players: number; spotify: boolean};
const date = (value: string) => new Date(value).toLocaleString('fr-FR');
export default function Owner() {
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const [message, setMessage] = useState(''), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [online, setOnline] = useState(navigator.onLine);
  const working = useRef(false);
  const account = useRef<string | null>(null);
  const [selected, setSelected] = useState<Room | null>(null), [confirmation, setConfirmation] = useState('');
  const [filter, setFilter] = useState('');
  async function list() {
    if (!client) throw new Error('Le serveur n’est pas configuré.');
    const requestedBy = account.current;
    const {data, error} = await client.rpc('owner_rooms').abortSignal(AbortSignal.timeout(15000));
    if (requestedBy !== account.current) return;
    if (error) { setRooms(null); throw new Error(error.code === '42501' ? 'Ce compte n’a pas accès à la gestion de Jam.' : 'Impossible de charger les soirées. Réessayez.'); }
    setRooms(data);
  }
  async function run(action: () => Promise<void>) {
    if (working.current) return;
    if (!navigator.onLine) {setError('Vous êtes hors connexion.'); return;}
    working.current = true; setBusy(true); setError(''); setMessage('');
    try {await action();} catch (e) {setError(e instanceof Error ? e.message : 'Action impossible.');}
    finally {working.current = false; setBusy(false);}
  }
  useEffect(() => {
    if (!client) return;
    const {data: {subscription}} = client.auth.onAuthStateChange((_event, session) => {
      const next = session?.user.id ?? null;
      if (next !== account.current) {account.current = next; setRooms(null); setSelected(null);}
      setSignedIn(Boolean(session));
      if (!session) {setRooms(null); setSelected(null);}
    });
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online',update); window.addEventListener('offline',update);
    return () => {subscription.unsubscribe(); window.removeEventListener('online',update); window.removeEventListener('offline',update);};
  }, []);
  useEffect(() => {
    if (signedIn && online) void list().catch(e=>setError(e instanceof Error ? e.message : 'Chargement impossible.'));
  }, [signedIn,online]);
  return <main className="owner-page">
    <a href="/" className="text-button">← Retour à Jam</a>
    <p className="eyebrow">ESPACE PERSONNEL</p><h1>Gestion des soirées.</h1>
    <p>Accès réservé au propriétaire de Jam. {online ? '' : 'Vous êtes hors connexion.'}</p>
    {error && <p className="notice" role="alert">{error}</p>}
    {message && <p className="notice" role="status">{message}</p>}
    {!signedIn ? <form className="panel" onSubmit={e => {e.preventDefault(); void run(async () => {
      if (!client) throw new Error('Le serveur n’est pas configuré.');
      const {error} = await client.auth.signInWithPassword({email:email.trim(),password});
      if (error) throw new Error('Connexion refusée. Vérifiez votre e-mail, votre mot de passe et la confirmation de votre adresse.');
      setPassword('');
    });}}>
      <fieldset disabled={busy || !online || !client}>
        <label className="field">Adresse e-mail<input type="email" required autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)} /></label>
        <label className="field">Mot de passe<input type="password" required autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} /></label>
        <button className="primary" type="submit">Se connecter</button>
        <details className="disclosure"><summary>Première connexion</summary><p>Créez votre compte avec votre adresse personnelle, puis confirmez l’e-mail reçu. La création d’un compte ne donne aucun droit de gestion : l’accès doit être attribué séparément côté serveur.</p>
          <button className="secondary" type="button" onClick={() => void run(async () => {
            if (!client || !email.trim() || password.length < 12) throw new Error('Renseignez votre e-mail et un mot de passe d’au moins 12 caractères.');
            const {error} = await client.auth.signUp({email:email.trim(),password,options:{emailRedirectTo:location.origin+'/?gestion=1'}});
            if (error) throw new Error('Création impossible. Réessayez plus tard ou connectez-vous si le compte existe déjà.');
            setPassword(''); setMessage('Vérifiez votre boîte e-mail pour confirmer votre adresse, puis revenez vous connecter ici.');
          })}>Créer mon compte</button>
        </details>
      </fieldset>
    </form> : <>
      <div className="actions"><button className="secondary" disabled={busy || !online} onClick={()=>void run(list)}>Actualiser les soirées</button>
      <button className="secondary" disabled={busy} onClick={async () => {
        // Local sign-out also clears the view when the network is unavailable.
        const result = await client!.auth.signOut({scope:'local'});
        if (result.error) {setError('Déconnexion impossible. Fermez cet onglet pour effacer la session de gestion.'); return;}
        setRooms(null); setSelected(null); setSignedIn(false); setError('');
      }}>Se déconnecter</button></div>
      {rooms !== null && <>
        <h2>{rooms.length} soirée{rooms.length !== 1 ? 's' : ''}</h2>
        <label className="field">Chercher par nom ou code<input value={filter} onChange={e=>setFilter(e.target.value)} /></label>
        {rooms.length === 0 && <p>Aucune soirée enregistrée.</p>}
        {rooms.filter(r=>(r.name+' '+r.code).toLocaleLowerCase().includes(filter.toLocaleLowerCase())).map(room=><section className="panel" key={room.id}>
          <h2>{room.name}</h2><p><code>{room.code}</code> · {room.players} joueur{room.players !== 1 ? 's' : ''}</p>
          <p>Créée le {date(room.created_at)}<br/>Dernière activité : {date(room.last_activity_at)}{room.spotify && <><br/>Spotify connecté</>}</p>
          {selected?.id !== room.id ? <button className="secondary" disabled={busy || !online} onClick={()=>{setSelected(room);setConfirmation('');}}>Supprimer cette soirée</button> : <div className="notice">
            <p>Cette suppression est définitive : tous les joueurs, jetons, défis et demandes de cette soirée seront effacés. Les morceaux déjà envoyés à l’application musicale y resteront.</p>
            <label className="field">Recopiez {room.code} pour confirmer<input value={confirmation} autoComplete="off" onChange={e=>setConfirmation(e.target.value)} /></label>
            <div className="actions"><button className="primary" disabled={busy || !online || confirmation !== room.code} onClick={()=>void run(async () => {
              const {error} = await client!.rpc('owner_delete_room',{room_key:room.id,confirmation_code:confirmation}).abortSignal(AbortSignal.timeout(15000));
              if (error) throw new Error('Suppression non confirmée. Actualisez la liste avant de réessayer.');
              setRooms(current=>current?.filter(r=>r.id!==room.id) ?? null);setSelected(null);setConfirmation('');setMessage('La soirée a été définitivement supprimée.');
            })}>Effacer définitivement</button><button className="secondary" disabled={busy} onClick={()=>setSelected(null)}>Annuler</button></div>
          </div>}
        </section>)}
      </>}
    </>}
  </main>;
}
