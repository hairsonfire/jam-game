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
          <OwnerPlayers roomId={room.id} onChange={list} />
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

type ManagedPlayer = {id:string;name:string;adds:number;skip:boolean;admin:boolean;music:boolean};
function OwnerPlayers({roomId,onChange}:{roomId:string;onChange:()=>Promise<void>}) {
  const [players,setPlayers]=useState<ManagedPlayer[] | null>(null);
  const [busy,setBusy]=useState(false), [error,setError]=useState('');
  const [target,setTarget]=useState<ManagedPlayer | null>(null), [mode,setMode]=useState<'delete'|'recovery'>('delete');
  const [name,setName]=useState(''), [successor,setSuccessor]=useState('');
  const [code,setCode]=useState<{name:string;value:string}|null>(null);
  const pending=useRef<{action_id:string;room_key:string;player_key:string;operation:string;options:Record<string,string>;secret?:string;name:string}|null>(null);
  const lock=useRef(false);
  async function load() {
    const {data,error}=await client!.rpc('owner_players',{room_key:roomId});
    if(error) throw new Error(error.message); setPlayers(data);
  }
  async function run(work:()=>Promise<void>) {
    if(lock.current) return;
    if(!navigator.onLine) {setError('Vous êtes hors connexion.');return;}
    lock.current=true;setBusy(true);setError('');
    try {await work();} catch(e) {setError(e instanceof Error ? e.message : 'Action impossible.');}
    finally {lock.current=false;setBusy(false);}
  }
  async function send() {
    const action=pending.current!;
    const {secret,name:playerName,...args}=action;
    const {error}=await client!.rpc('owner_player_action',args).abortSignal(AbortSignal.timeout(15000));
    if(error) {
      // SQL errors roll back. A network failure can hide a committed action.
      if(error.code && /^[0-9A-Z]{5}$/.test(error.code) && !error.code.startsWith('08')) pending.current=null;
      throw new Error(error.message);
    }
    pending.current=null;
    setCode(secret ? {name:playerName,value:secret} : null);setTarget(null);
    await load();await onChange();
  }
  return <div className="disclosure">
    <button className="secondary" disabled={busy} onClick={()=>void run(load)}>Voir / actualiser les joueurs</button>
    {error && <p role="alert">{error}</p>}
    {pending.current && !busy && <button className="secondary" onClick={()=>void run(send)}>Vérifier la dernière action joueur</button>}
    {code && <div className="notice"><p>Nouveau code de récupération de {code.name}. L’ancien code ne fonctionne plus. Copiez-le avant de quitter cette page.</p><code className="secret">{code.value}</code><button className="secondary" onClick={()=>void run(async()=>{await navigator.clipboard.writeText(code.value);})}>Copier le nouveau code</button></div>}
    {players?.length===0 && <p>Aucun joueur.</p>}
    {players && players.length>0 && <p className="muted">Les anciens codes ne sont pas lisibles. Vous pouvez les remplacer par un nouveau code à copier.</p>}
    {players?.map(player=><div className="panel" key={player.id}>
      <h3>{player.name}</h3><p>{player.admin ? 'Administrateur · ' : ''}{player.music ? 'Responsable musical · ' : ''}{player.adds} jeton(s) d’ajout{player.skip ? ' · 1 skip' : ''}</p>
      <div className="actions"><button className="secondary" disabled={busy || Boolean(pending.current)} onClick={()=>{setTarget(player);setMode('recovery');setCode(null);}}>Nouveau code de récupération</button>
      <button className="secondary" disabled={busy || Boolean(pending.current)} onClick={()=>{setTarget(player);setMode('delete');setName('');setSuccessor('');}}>Supprimer ce joueur</button></div>
      {target?.id===player.id && <div className="notice">
        {mode==='recovery' ? <p>Remplacer le code de {player.name} ? L’ancien code deviendra inutilisable. Le nouveau permet de récupérer son profil. Sa session actuelle reste ouverte.</p> : <>
          <p>Le profil, ses jetons et ses demandes seront définitivement supprimés. Les morceaux déjà ajoutés dans l’application musicale y resteront.</p>
          <label className="field">Recopiez le pseudo {player.name}<input value={name} onChange={e=>setName(e.target.value)} /></label>
          {player.admin && <label className="field">Nouvel administrateur<select value={successor} onChange={e=>setSuccessor(e.target.value)}><option value="">Choisir un autre joueur</option>{players.filter(p=>p.id!==player.id).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>{players.length===1 && <small>Ce joueur est seul : supprimez plutôt la soirée entière.</small>}</label>}
        </>}
        <button className="primary" disabled={busy || Boolean(pending.current) || (mode==='delete' && (name!==player.name || (player.admin && !successor)))} onClick={()=>void run(async()=>{
          let secret:string|undefined;
          let options:Record<string,string>={name,successor};
          if(mode==='recovery') {
            secret=Array.from(crypto.getRandomValues(new Uint8Array(20)),b=>b.toString(16).padStart(2,'0')).join('');
            const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(secret));
            options={hash:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')};
          }
          pending.current={action_id:crypto.randomUUID(),room_key:roomId,player_key:player.id,operation:mode,options,secret,name:player.name};
          await send();
        })}>{mode==='recovery' ? 'Remplacer et afficher le code' : 'Effacer ce joueur définitivement'}</button>
        <button className="secondary" disabled={busy} onClick={()=>setTarget(null)}>Annuler</button>
      </div>}
    </div>)}
  </div>;
}
