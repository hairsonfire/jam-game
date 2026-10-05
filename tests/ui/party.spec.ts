import { test, expect } from "@playwright/test";

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
