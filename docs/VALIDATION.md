# Registre de validation

## Réalisé localement

- Compilation TypeScript et bundle de production Vite.
- 19 tests SQL sur PGlite, avec les mêmes migrations que Supabase et les permissions `authenticated`/`anon`/`service_role`.
- Trois tests Playwright dans Edge headless sur le bundle de production : trois contextes indépendants au format mobile, création/jonction, témoin, récompense, chanson, confirmations de régie, message Taylor Swift, administration, réponse perdue rejouée sans double effet, rechargement hors connexion et retour réseau.
- Vérification Deno des types et imports de la fonction Web Push. Son exécution dans Supabase et la livraison à un téléphone ne sont pas encore vérifiées.
- Captures visuelles contrôlées à 390 px et 1 440 px ; aucun débordement horizontal dans les scénarios testés.
- Audit npm après mise à jour de Vitest : zéro vulnérabilité signalée.

Le backend HTTP des tests simule uniquement l’authentification et le transport Supabase ; les actions exécutent le vrai SQL. PGlite utilise une seule connexion : cela teste la répétition et l’atomicité, mais ne prouve pas à lui seul les verrous entre plusieurs connexions PostgreSQL distantes. Il faut aussi effectuer les essais simultanés ci-dessous sur Supabase.

## Hébergement — vérification du 4 octobre 2026 UTC

Application publique : https://jam-wine-mu.vercel.app/ . Publication statique du dossier `dist` sur Vercel Hobby. Une soirée « Vérification du déploiement » a été créée depuis cette adresse : identité invitée, lecture serveur, rôles du créateur et soldes initiaux à zéro vérifiés dans le navigateur. Aucun essai sur téléphone réel à ce stade.

| Vérification | État |
|---|---|
| Comptes Vercel Hobby et Supabase Free sans facturation | Comptes créés ; offres Hobby et FREE affichées |
| Migrations exécutées dans Supabase | Deux migrations exécutées ; RLS active sur les 12 tables privées |
| Publication HTTPS publique | Effectuée ; accueil et création d’une soirée vérifiés |
| Authentification anonyme et limites Wi-Fi partagé | Connexion invitée vérifiée ; limites à plusieurs téléphones à vérifier |
| Edge Function avec clés VAPID et secrets Vault | Déployée et configurée après autorisation ; appel authentifié réussi, appel sans authentification refusé (401) |
| Cron de reprise quand aucun téléphone n’est ouvert | Tâche active chaque minute ; exécution `succeeded` avec file vide. Livraison et reprise après erreur à vérifier sur téléphone |
| Export et restauration dans un projet vide | À vérifier |

## Matrice sur appareils réels

Test distant supplémentaire : `node --env-file=.env.local scripts/check-hosted.mjs --create-test-room` réussi. Deux commandes de création identiques envoyées simultanément à Supabase ont renvoyé le même résultat, avec une seule soirée. Soldes initiaux et bonus à zéro vérifiés. Ce test crée volontairement une soirée technique ; il ne valide pas encore toutes les courses entre joueurs. Le rechargement du navigateur conserve également la session de la soirée créée depuis l’interface publiée.

Noter pour chaque ligne : modèle, version OS/navigateur, heure d’envoi et de réception, résultat, réglages de notification et observations. Ne pas remplir « réussi » depuis un émulateur.

| Scénario | iPhone installé, iOS 16.4+ | Android Chrome |
|---|---|---|
| Installation et réouverture | Non testé | Non testé |
| Test Push application au premier plan | Non testé | Non testé |
| Application en arrière-plan avec Spotify actif | Non testé | Non testé |
| Application fermée normalement | Non testé | Non testé |
| Téléphone verrouillé depuis 10 minutes | Non testé | Non testé |
| Fermeture forcée par l’utilisateur | Non testé | Non testé |
| Concentration / Ne pas déranger | Non testé | Non testé |
| Économie de batterie | Non testé | Non testé |
| Notifications refusées : listes persistantes utilisables | Non testé | Non testé |
| Réseau coupé, réouverture, puis reconnexion | Non testé | Non testé |

Les systèmes peuvent retarder ou masquer une notification. Cela ne doit jamais faire disparaître une demande ni attribuer deux récompenses. Web Push documenté ne signifie pas livraison garantie sur un téléphone donné.

## Recette à trois téléphones sur le site publié

1. A crée une soirée, B et C rejoignent par lien et QR. Sauvegarder leurs codes personnels.
2. A tire un défi, choisit B ; aucun chrono ni récompense avant acceptation. B accepte et valide après avoir constaté la réussite dans le délai. Vérifier un seul crédit.
3. Répéter un envoi ou une validation depuis deux onglets du même profil. Le deuxième effet doit être refusé ou renvoyer le résultat du premier.
4. Inviter B, le remplacer par C et tenter de valider depuis l’ancien écran de B. Aucun crédit.
5. Tester échec, sacrifice configuré, sacrifice refusé et abandon avec blocage de deux minutes.
6. Proposer une chanson. « Ajouté à la file » termine la demande et libère la place. Tester un refus avant ajout et vérifier un seul remboursement ; refuser toute annulation ou nouvelle confirmation après ajout.
7. Passer temporairement le bonus à 100 %. A et B gagnent chacun un skip et le demandent au même instant. Une seule demande est ouverte, l’autre jeton reste disponible. Vérifier qu’un skip réservé bloque le bonus suivant et qu’un refus le restitue.
8. Confirmer un skip réellement exécuté. Puis tester un skip devenu caduc après changement naturel, avec annulation/remboursement.
9. Confirmer une demande contenant `TAYLOR swift`. Le message exact apparaît une fois dans les événements. L’ajout à la file le déclenche.
10. Récupérer un profil depuis un autre téléphone. Vérifier jetons/rôles, rotation du code personnel et refus de l’ancien accès.
11. Fermer tous les téléphones après une action et vérifier la reprise des notifications via cron. Examiner les journaux serveur sans publier d’endpoint ni de clé.
12. Remettre le taux de bonus à **0 %** et faire une répétition avec Spotify, sans ordinateur.

## Critère final d’acceptation

Trois vrais téléphones terminent le parcours complet, sans perte de progression après coupure, sans incohérence de jetons ni demande disparue. La liste persistante fonctionne même si les notifications sont indisponibles. Les limites observées des notifications sont consignées, et l’administrateur sait réactiver Supabase avant la soirée si nécessaire.
