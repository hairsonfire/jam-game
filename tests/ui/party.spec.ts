import { test, expect } from "@playwright/test";

test("guide accessible avant connexion et installation proposée seulement si disponible", async ({ page }) => {
  await page.goto("/?soiree=ABCDEF123456");
  await page.getByRole("button", { name: "Comment jouer et installer Jam" }).click();
  await expect(page.getByRole("heading", { name: "Aide et installation" })).toBeVisible();
  await expect(page.getByText("ABCDEF123456", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "iPhone / iPad" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Installer Jam", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Android", exact: true }).click();
  await expect(page.getByText("Ouvrez le menu du navigateur.", { exact: true })).toBeVisible();
  // Emulate the optional browser event, without installing anything on this computer.
  await page.evaluate(() => {
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, { prompt: async () => ({ outcome: "dismissed" }) });
    window.dispatchEvent(event);
  });
  await page.getByRole("button", { name: "Installer Jam", exact: true }).click();
  await expect(page.getByText("Vous pouvez continuer à jouer ici et installer Jam plus tard.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Installer Jam", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "iPhone / iPad" }).click();
  await page.getByRole("heading", { name: "Jam sur votre écran d’accueil" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/08-guide-installation.png" });
  await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
  await expect(page.getByText(/Jam est déjà installé ou ouvert/)).toBeVisible();
  await page.getByRole("button", { name: "← Retour" }).click();
  await expect(page.getByLabel("Code de la soirée")).toHaveValue("ABCDEF123456");
});

test("trois téléphones : défi, témoignage, chanson, régie, réglages et reconnexion", async ({
  browser,
  page: alice,
}) => {
  const b = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const c = await browser.newContext({
    viewport: { width: 412, height: 915 },
    isMobile: true,
    hasTouch: true,
  });
  const bob = await b.newPage(),
    carol = await c.newPage();
  const issues: string[] = [];
  for (const p of [alice, bob, carol])
    p.on("pageerror", (e) => issues.push(e.message));
  await alice.goto("/");
  await expect(alice.getByRole("heading", { name: /La soirée/ })).toBeVisible();
  await alice.screenshot({
    path: "test-results/01-accueil-mobile.png",
    fullPage: true,
  });
  await alice.getByRole("button", { name: "Créer", exact: true }).click();
  await alice.getByLabel("Votre pseudo").fill("Alice");
  await alice.getByLabel("Nom de la soirée").fill("Samedi chez Alice");
  await alice.getByRole("button", { name: "Créer ma soirée" }).click();
  await expect(
    alice.getByRole("heading", { name: "À vous, Alice." }),
  ).toBeVisible();
  await alice.getByRole("button", { name: /Inviter · QR code/ }).click();
  const code = await alice.locator(".share code").innerText();
  for (const [p, name] of [
    [bob, "Bob"],
    [carol, "Carole"],
  ] as const) {
    await p.goto("/?soiree=" + code);
    await p.getByLabel("Votre pseudo").fill(name);
    await p.getByRole("button", { name: "Rejoindre la soirée" }).click();
    await expect(
      p.getByRole("heading", { name: `À vous, ${name}.` }),
    ).toBeVisible();
  }
  await alice.getByRole("button", { name: /Inviter · QR code/ }).click();
  await expect(alice.getByText("3 participants")).toBeVisible();
  await expect(alice.getByText(/Un défi validé =/)).toHaveCount(0);
  await expect(alice.getByText("Mes derniers mouvements de jetons")).toHaveCount(0);
  expect(await alice.locator(".navigation svg").count()).toBe(5);
  const iconSizes = await alice.locator(".navigation svg").evaluateAll(icons => icons.map(icon => {
    const { width, height } = icon.getBoundingClientRect(); return [width, height];
  }));
  expect(iconSizes).toEqual(Array(5).fill([24, 24]));
  await alice.getByRole("button", { name: "Aide et installation" }).click();
  await expect(alice.getByRole("heading", { name: "Aide et installation" })).toBeVisible();
  await expect(alice.getByRole("button", { name: "Tirer un défi" })).toHaveCount(0);
  await alice.getByRole("button", { name: /Inviter · QR code/ }).click();
  await expect(alice.getByRole("heading", { name: "Inviter des amis" })).toBeVisible();
  await expect(alice.getByRole("heading", { name: "Aide et installation" })).toHaveCount(0);
  await alice.getByRole("button", { name: "Musique", exact: false }).click();
  await expect(alice.getByRole("heading", { name: "Inviter des amis" })).toHaveCount(0);
  await alice.getByRole("button", { name: "Jouer", exact: false }).click();
  await alice.screenshot({ path: "test-results/07-navigation-mobile.png", fullPage: true });
  await alice.getByRole("button", { name: "Tirer un défi" }).click();
  await alice.getByLabel("Choisir un témoin").selectOption({ label: "Bob" });
  await alice.getByRole("button", { name: "Demander son accord" }).click();
  await bob.getByRole("button", { name: /Témoigner/ }).click();
  await expect(
    bob.getByRole("button", { name: "Accepter et commencer" }),
  ).toBeVisible();
  await bob.getByRole("button", { name: "Accepter et commencer" }).click();
  await expect(bob.locator(".timer")).toBeVisible();
  await bob.screenshot({
    path: "test-results/02-temoin-mobile.png",
    fullPage: true,
  });
  await bob.getByLabel(/J’atteste/).check();
  await bob.getByRole("button", { name: "Valider la réussite" }).click();
  await expect(alice.locator(".balances strong").first()).toHaveText("1");
  await alice.getByRole("button", { name: "Musique", exact: false }).click();
  await alice
    .getByLabel("Chanson et artiste, dans vos mots")
    .fill("Anti-Hero — TAYLOR swift");
  await alice.getByRole("button", { name: "Proposer · 1 jeton" }).click();
  await expect(
    alice.getByText("Vous pourrez proposer une autre chanson"),
  ).toBeVisible();
  await alice.getByRole("button", { name: /Régie/ }).click();
  await alice.screenshot({
    path: "test-results/03-regie-mobile.png",
    fullPage: true,
  });
  await alice.getByRole("button", { name: "Ajouté à la file" }).click();
  await expect(alice.getByRole("button", { name: "Morceau lancé" })).toHaveCount(0);
  await expect(
    bob.getByText("Du Taylor Swift Arrive, bienvenue en enfer", {
      exact: false,
    }),
  ).toBeVisible();
  await alice.getByRole("button", { name: /Réglages/ }).click();
  await alice.getByLabel("Probabilité du bonus skip (%)").fill("100");
  await alice
    .getByLabel("Contenu du sacrifice liquide")
    .fill("Le gage choisi pour cette soirée.");
  await alice.getByRole("button", { name: "Enregistrer les réglages" }).click();
  await expect(alice.getByLabel("Probabilité du bonus skip (%)")).toHaveValue(
    "100",
  );
  await alice.screenshot({
    path: "test-results/04-administration-mobile.png",
    fullPage: true,
  });
  await alice.getByLabel("Probabilité du bonus skip (%)").fill("0");
  await alice.getByRole("button", { name: "Enregistrer les réglages" }).click();
  await expect(alice.getByLabel("Probabilité du bonus skip (%)")).toHaveValue(
    "0",
  );
  await alice.getByRole("button", { name: "Jouer", exact: false }).click();
  await alice.reload();
  await expect(
    alice.getByRole("heading", { name: "À vous, Alice." }),
  ).toBeVisible();
  await alice.context().setOffline(true);
  await expect(
    alice.getByRole("button", { name: "Tirer un défi" }),
  ).toBeDisabled();
  await alice.context().setOffline(false);
  await expect(
    alice.getByRole("button", { name: "Tirer un défi" }),
  ).toBeEnabled();
  expect(
    await alice.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(issues).toEqual([]);
  await alice.getByRole("button", { name: /Réglages/ }).click();
  await alice.getByRole("button", { name: "Supprimer Bob", exact: true }).click();
  await alice.getByRole("button", { name: "Annuler", exact: true }).click();
  await expect(bob.getByRole("button", { name: /Témoigner/ })).toBeVisible();
  await alice.getByRole("button", { name: "Supprimer Bob", exact: true }).click();
  await alice.getByRole("button", { name: "Supprimer définitivement ce joueur" }).click();
  await expect(alice.getByRole("button", { name: "Supprimer Bob", exact: true })).toHaveCount(0);
  await expect(bob.getByRole("button", { name: "Rejoindre la soirée" })).toBeVisible();
  expect(await bob.evaluate(() => localStorage.getItem("jam:snapshot"))).toBeNull();
  await alice.getByRole("button", { name: "Clore et effacer la soirée", exact: true }).click();
  await expect(alice.getByRole("button", { name: "Effacer définitivement la soirée" })).toBeDisabled();
  await alice.getByLabel("Code de confirmation de suppression").fill(code);
  await alice.screenshot({ path: "test-results/06-suppression-mobile.png", fullPage: true });
  let deletionIntercepted = false;
  await alice.route("**/rest/v1/rpc/game_command", async route => {
    if (route.request().postDataJSON().kind === "delete_room" && !deletionIntercepted) {
      deletionIntercepted = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await alice.getByRole("button", { name: "Effacer définitivement la soirée" }).click();
  // Either state synchronization or replay of the lost response must exit the deleted room.
  const retryButton = alice.getByRole("button", { name: "Vérifier la dernière action" });
  if (await retryButton.isVisible()) await retryButton.click();
  await expect(alice.getByRole("button", { name: "Rejoindre la soirée" })).toBeVisible();
  await expect(carol.getByRole("button", { name: "Rejoindre la soirée" })).toBeVisible();
  expect(await alice.evaluate(() => localStorage.getItem("jam:snapshot"))).toBeNull();
  await b.close();
  await c.close();
});

test("accueil desktop et récupération accessibles sans débordement", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.screenshot({
    path: "test-results/05-accueil-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Récupérer", exact: true }).click();
  await expect(page.getByLabel("Votre code personnel secret")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("une réponse perdue peut être revérifiée sans attribuer un deuxième défi", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Créer", exact: true }).click();
  await page.getByLabel("Votre pseudo").fill("Reconnectée");
  await page.getByRole("button", { name: "Créer ma soirée" }).click();
  await expect(
    page.getByRole("heading", { name: "À vous, Reconnectée." }),
  ).toBeVisible();
  let intercepted = false;
  await page.route("**/rest/v1/rpc/game_command", async (route) => {
    const body = route.request().postDataJSON();
    if (body.kind === "draw" && !intercepted) {
      intercepted = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Tirer un défi" }).click();
  await expect(
    page.getByRole("button", { name: "Vérifier la dernière action" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Vérifier la dernière action" })
    .click();
  await expect(page.getByText("Votre défi est prêt. Choisissez un ami pour être témoin.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Vérifier la dernière action" }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Choisir un témoin")).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("jam:snapshot")!).assignments.length,
    ),
  ).toBe(1);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.context().setOffline(true);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "À vous, Reconnectée." }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Abandonner" })).toBeDisabled();
  await page.context().setOffline(false);
  await expect(page.getByRole("button", { name: "Abandonner" })).toBeEnabled();
});

test('Spotify : recherche, ajout automatique, suivi et commandes de régie', async ({ page }) => {
  const track = { id: '1234567890123456789012', uri: 'spotify:track:1234567890123456789012', name: 'Chanson de test', artists: 'Artiste de test', durationMs: 180000, image: null, url: 'https://open.spotify.com/track/1234567890123456789012' };
  const calls: string[] = [];
  let releaseOldSearch: (() => void) | undefined;
  let oldSearchFinished = false;
  let added = false;
  await page.route('**/rest/v1/rpc/game_state', async route => {
    const response = await route.fetch();
    const s = await response.json();
    s.me.adds = 2; s.me.skip = true;
    s.spotify = {connected: true, checkedAt: new Date().toISOString(), issue: null, jobs: [], snapshot: { current: {...track, id: 'other', uri: 'spotify:track:other'}, queue: added ? [track] : [], playing: true, progressMs: 60000, device: 'Enceinte du salon' }};
    if (added) s.requests.push({id:'test-song', room_id:s.room.id, player_id:s.me.id, kind:'song', text: track.name, status:'queued', spotify_track:track, played_at:null});
    await route.fulfill({json:s});
  });
  await page.route('**/functions/v1/spotify', async route => {
    const data = route.request().postDataJSON(); calls.push(data.action);
    if (data.action === 'search' && data.query === 'Ancienne') {
      await new Promise<void>(resolve => { releaseOldSearch = resolve; });
      await route.fulfill({json:{tracks:[{...track, name:'Ancien résultat'}]}});
      oldSearchFinished = true;
      return;
    }
    await route.fulfill({json:data.action === 'search' ? {tracks:[track]} : data.action === 'devices' ? {devices:[{id:'speaker', name:'Enceinte du salon', active:true}]} : {ok:true}});
  });
  await page.route('**/rest/v1/rpc/game_command', async route => {
    const data = route.request().postDataJSON();
    if (data.kind?.startsWith('spotify_')) {
      calls.push(data.kind); if (data.kind === 'spotify_song') added = true;
      await route.fulfill({json:{requestId:'test-song'}});
    } else await route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', {name:'Créer', exact:true}).click();
  await page.getByLabel('Votre pseudo').fill('DJ');
  await page.getByLabel('Nom de la soirée').fill('Spotify test');
  await page.getByRole('button', {name:'Créer ma soirée'}).click();
  await expect(page.getByRole('heading', {name:'À vous, DJ.'})).toBeVisible();
  await page.getByRole('button', {name:'Musique', exact:true}).click();
  await page.getByLabel('Chercher une chanson ou un artiste').fill('Ancienne');
  await expect.poll(() => Boolean(releaseOldSearch)).toBe(true);
  await page.getByLabel('Chercher une chanson ou un artiste').fill('Chanson');
  // Suggestions appear automatically, without submitting the field.
  await expect(page.getByRole('button', {name:'Ajouter · 1 jeton'})).toBeVisible();
  releaseOldSearch!();
  await expect.poll(() => oldSearchFinished).toBe(true);
  await expect(page.getByText('Ancien résultat', {exact:true})).toHaveCount(0);
  await page.getByLabel('Chercher une chanson ou un artiste').fill('');
  await expect(page.getByRole('button', {name:'Ajouter · 1 jeton'})).toHaveCount(0);
  await page.getByLabel('Chercher une chanson ou un artiste').fill('Chanson');
  await page.getByRole('button', {name:'Ajouter · 1 jeton'}).click();
  await expect(page.getByText('1e dans la file · environ 2 min')).toBeVisible();
  const sharedQueue = page.getByRole('region', {name:'File de la soirée'});
  await expect(sharedQueue.getByText('Demandée par DJ', {exact:false})).toBeVisible();
  await expect(sharedQueue.getByText('Chanson de test', {exact:true})).toBeVisible();
  expect(calls.filter(c => c === 'spotify_song')).toHaveLength(1);
  await page.getByRole('button', {name:'Passer maintenant · 1 skip'}).click();
  await expect.poll(() => calls.includes('spotify_skip')).toBe(true);
  await page.screenshot({path:'test-results/09-spotify-mobile.png', fullPage:true});
  await page.getByRole('button', {name:'Régie', exact:true}).click();
  await page.getByRole('button', {name:'Pause', exact:true}).click();
  await expect.poll(() => calls.includes('pause')).toBe(true);
  await page.getByRole('button', {name:'Choisir l’appareil'}).click();
  await page.getByRole('button', {name:'Enceinte du salon · actif'}).click();
  await expect.poll(() => calls.includes('transfer')).toBe(true);
});

test('gestion privée : connexion séparée, confirmation et suppression', async ({page}) => {
  const room = {id:'11111111-1111-4111-8111-111111111111',name:'Soirée à effacer',code:'ABC123DEF456',players:3,spotify:false,created_at:new Date().toISOString(),last_activity_at:new Date().toISOString()};
  let deleted = false;
  let playerDeleted = false;
  await page.route('**/rest/v1/rpc/owner_players',route=>route.fulfill({json:playerDeleted ? [] : [{id:'player-test',name:'Bob',adds:2,skip:false,admin:false,music:false}]}));
  await page.route('**/rest/v1/rpc/owner_player_action',async route=>{
    const data=route.request().postDataJSON();
    if(data.operation==='recovery') {
      expect(data.options.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(data).not.toHaveProperty('secret');
    } else {expect(data.options.name).toBe('Bob');playerDeleted=true;}
    await route.fulfill({json:{ok:true}});
  });
  await page.route('**/rest/v1/rpc/owner_rooms',route=>route.fulfill({json:deleted ? [] : [room]}));
  await page.route('**/rest/v1/rpc/owner_delete_room',async route=>{
    expect(route.request().postDataJSON()).toEqual({room_key:room.id,confirmation_code:room.code});
    deleted=true; await route.fulfill({json:{deleted:true}});
  });
  await page.goto('/?gestion=1');
  await expect(page.getByRole('heading',{name:'Gestion des soirées.'})).toBeVisible();
  await expect(page.getByText(room.name,{exact:true})).toHaveCount(0);
  await page.getByLabel('Adresse e-mail').fill('owner@example.test');
  await page.getByLabel('Mot de passe',{exact:true}).fill('test-password-owner');
  await page.getByRole('button',{name:'Se connecter',exact:true}).click();
  await expect(page.getByRole('heading',{name:room.name})).toBeVisible();
  await page.getByRole('button',{name:'Voir / actualiser les joueurs'}).click();
  await expect(page.getByRole('heading',{name:'Bob',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Nouveau code de récupération',exact:true}).click();
  await page.getByRole('button',{name:'Remplacer et afficher le code'}).click();
  await expect(page.locator('code.secret')).toHaveText(/^[a-f0-9]{40}$/);
  await page.getByRole('button',{name:'Supprimer ce joueur',exact:true}).click();
  await expect(page.getByRole('button',{name:'Effacer ce joueur définitivement'})).toBeDisabled();
  await page.getByLabel('Recopiez le pseudo Bob').fill('Bob');
  await page.getByRole('button',{name:'Effacer ce joueur définitivement'}).click();
  await expect(page.getByText('Aucun joueur.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Supprimer cette soirée'}).click();
  await expect(page.getByRole('button',{name:'Effacer définitivement'})).toBeDisabled();
  await page.getByLabel('Recopiez '+room.code+' pour confirmer').fill(room.code);
  await page.screenshot({path:'test-results/10-owner-mobile.png',fullPage:true});
  await page.getByRole('button',{name:'Effacer définitivement'}).click();
  await expect(page.getByText('La soirée a été définitivement supprimée.')).toBeVisible();
  await expect(page.getByText('Aucune soirée enregistrée.')).toBeVisible();
  expect(await page.evaluate(()=>localStorage.getItem('jam-owner-auth'))).toBeNull();
  await page.getByRole('button',{name:'Se déconnecter'}).click();
  await expect(page.getByRole('button',{name:'Se connecter',exact:true})).toBeVisible();
});
