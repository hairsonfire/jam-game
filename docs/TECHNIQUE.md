# Jam — installation et maintenance

PWA française React/TypeScript. De vrais défis validés par un témoin, des jetons contrôlés dans PostgreSQL et une régie musicale manuelle. La lecture musicale reste indépendante de Jam.

[← Guide des joueurs](../README.md)

Les commandes et chemins ci-dessous sont relatifs à la racine du projet.

## État de livraison

Le code et les migrations sont implémentés. Les tests métier exécutent les véritables fonctions SQL dans PostgreSQL embarqué (PGlite). Les tests navigateur utilisent trois sessions indépendantes, une authentification de test et ces mêmes migrations. **Ce serveur de test n’est jamais déployé.**

Site publié : **https://jam-wine-mu.vercel.app/** sur Vercel Hobby, avec Supabase Free. Migrations, connexions invitées, fonction Web Push, secrets et relance cron configurés. Création et persistance de session vérifiées sur le site réel ; appel serveur de notifications vérifié. La livraison sur iPhone et Android réels reste à vérifier. Voir [le registre de validation](VALIDATION.md).

Le premier déploiement utilise l’envoi du dossier statique `dist` dans Vercel, sans dépôt Git connecté. Pour préparer une nouvelle publication : `npm run build`, puis `node scripts/prepare-static.mjs`. Publier uniquement `dist`, jamais les fichiers `.env*.local`. Les modifications locales ne sont pas publiées automatiquement.

## Développement

Node.js 22.12 minimum (24 recommandé).

```sh
npm ci
```

Copier `.env.example` dans `.env.local`, renseigner les deux variables publiques Supabase, puis :

```sh
npm run dev
npm test
npm run build
npm run test:ui
```

Sans configuration, l’accueil affiche explicitement que le service n’est pas connecté. Il ne fabrique aucune partie ou récompense de démonstration. Les tests UI créent leur propre environnement isolé et n’utilisent pas vos données Supabase.

Les tests navigateur utilisent Edge installé par défaut. Sur un autre système, installer Chromium Playwright et définir `PLAYWRIGHT_CHANNEL=chromium` avant `npm run test:ui`. Ne pas exposer `tests/support/backend.mjs` sur Internet.

## Publication gratuite, une seule fois

### 1. Créer Supabase Free

1. Créer un compte sur [Supabase](https://supabase.com/dashboard), puis une organisation **Free** et un projet gratuit. Conserver le mot de passe de la base en lieu sûr.
2. Dans Authentication, activer **Allow anonymous sign-ins**. Un participant utilise le rôle PostgreSQL `authenticated` même sans adresse e-mail.
3. Dans SQL Editor, exécuter, dans cet ordre, les fichiers complets :
   - `supabase/migrations/202610040001_jam.sql`
   - `supabase/migrations/202610040002_push_permission.sql`
   - `supabase/migrations/202610040003_neutral_wording.sql`
   - `supabase/migrations/202610040004_queue_completes_song.sql`
4. Copier l’URL du projet et la clé publique **anon** depuis les réglages API vers `.env.local`. **Jamais de clé `service_role` dans une variable `VITE_`**, dans Git ou dans le navigateur.
5. Vérifier la limite d’authentifications anonymes par IP avant une soirée : plusieurs téléphones sur le même Wi-Fi partagent une IP. Supabase applique des limites distinctes des quotas de la base. Si nécessaire, régler la limite dans Authentication / Rate Limits ou faire rejoindre les participants en amont. L’application est prévue pour une soirée privée de 50 participants maximum.

### 2. Préparer les notifications

Générer les clés VAPID et le secret du planificateur avec une adresse de contact que vous contrôlez :

```sh
node scripts/generate-push-keys.mjs mailto:votre-adresse@example.com
```

Le script écrit les secrets dans `.env.push.local`, exclu de Git, sans les afficher dans le terminal. Garder les mêmes clés pour toute la vie de l’installation. Si `.env.local` existait déjà, y copier uniquement la valeur **publique** `VAPID_PUBLIC_KEY` sous le nom `VITE_VAPID_PUBLIC_KEY`.

### 3. Publier sur Vercel Hobby

1. Créer un compte personnel [Vercel](https://vercel.com/signup), conserver le plan **Hobby**, sans moyen de paiement, sans essai Pro.
2. Publier le dossier avec la CLI Vercel (`npx vercel`) ou importer son dépôt personnel Git depuis le tableau de bord. Framework : **Vite**, commande `npm run build`, sortie `dist`.
3. Définir les variables `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` et `VITE_VAPID_PUBLIC_KEY` dans l’environnement Production. Ne pas utiliser l’adresse du serveur de test `127.0.0.1:8787`.
4. Déployer/re-déployer après modification des variables. Garder l’adresse HTTPS `*.vercel.app`, sans achat de domaine.
5. Ajouter cette URL aux réglages Site URL de Supabase. Dans `.env.push.local`, remplacer `APP_ORIGIN` par cette origine exacte, sans slash final.
6. Vérifier que l’URL de production est accessible aux invités sans compte Vercel.

### 4. Déployer la fonction de notification

Installer/utiliser la CLI officielle Supabase, s’authentifier et lier le projet :

```sh
npx supabase login
npx supabase link --project-ref VOTRE_REFERENCE_PROJET
npx supabase secrets set --env-file .env.push.local
npx supabase functions deploy push-dispatch --no-verify-jwt
```

`verify_jwt=false` est intentionnel : le code vérifie lui-même le JWT utilisateur avec Supabase Auth **et** l’appartenance à la soirée, ou le secret du planificateur. Les fonctions de lecture de la file et d’acquittement sont réservées au rôle serveur `service_role`.

Dans Supabase Vault (depuis le tableau de bord), ajouter :

| Nom | Valeur |
|---|---|
| `jam_project_url` | URL HTTPS du projet Supabase |
| `jam_push_cron_secret` | Même valeur que `PUSH_CRON_SECRET` dans `.env.push.local` |

Puis exécuter `supabase/setup-push-cron.sql` dans SQL Editor. Il active `pg_cron` / `pg_net` et installe une reprise toutes les minutes. L’appel réseau n’a lieu que si des notifications attendent. Ce n’est pas un mécanisme de maintien artificiel du projet en activité.

Après une action, le téléphone demande un envoi immédiat. Si cette requête se perd, le planificateur reprend l’envoi. Les locations d’envoi expirent après deux minutes ; six essais maximum avec délai croissant, événements de moins de 24 heures, TTL Web Push d’une heure. Un endpoint expiré est supprimé. Les notifications peuvent être reçues plus d’une fois ; leur identifiant stable réduit les doublons d’affichage. Les écritures de jeu, elles, sont idempotentes.

### 5. Vérifier sur de vrais téléphones

Créer une soirée, sauvegarder son code personnel, puis ouvrir **? → Activer les notifications → Tester mes notifications**. Sur iPhone, faire cette opération depuis l’icône installée sur l’écran d’accueil. Effectuer la matrice de [validation](VALIDATION.md) avant d’utiliser le jeu en soirée.

## Avant chaque soirée

1. Ouvrir l’URL et créer/rejoindre une soirée. Si Supabase est en pause, le réactiver dans son tableau de bord et attendre son retour avant l’arrivée des invités.
2. Sauvegarder le code personnel de l’administrateur et du responsable musical.
3. Vérifier les défis actifs, le contenu facultatif du sacrifice et le bonus (**0 % par défaut**).
4. Tester les notifications du responsable et d’un témoin ; les listes persistantes restent utilisables si les notifications sont refusées.
5. Lancer la playlist dans votre application musicale, puis partager le lien/QR de la soirée.

Pendant la soirée, aucun ordinateur n’est nécessaire. Le responsable copie le texte, agit dans son application musicale et confirme dans Jam. **« Ajouté à la file » termine la demande et libère immédiatement la place du joueur.** Le chrono ne valide rien automatiquement.

## Architecture et cohérence

- Schéma privé `jam`, aucune lecture/écriture directe autorisée aux clients, RLS activée sans politique publique. Seules `game_command`, `game_state` et la permission limitée du dispatcher sont exposées.
- Les commandes prennent un verrou transactionnel par identité puis sur la ligne de la soirée. Récompense, tirage, débit/remboursement, journal, événement et reçu d’idempotence sont enregistrés dans la même transaction.
- Un identifiant de commande conservé localement permet de **vérifier la dernière action** après perte de réponse. Une reprise ne rejoue pas son effet. Les identifiants d’ancienne tentative ne permettent pas de valider après remplacement du témoin.
- Le code personnel contient 160 bits aléatoires. Seule son empreinte SHA-256 est stockée côté serveur ; elle doit également être traitée comme un secret. La récupération change l’identité attachée au participant, renouvelle le code et supprime les abonnements push des anciens appareils.
- Actualisation de l’état toutes les cinq secondes seulement lorsque la page est visible, immédiatement après une action et au retour dans l’application. Cette V1 utilise la lecture RPC, sans connexion Realtime maintenue en arrière-plan. Les chronomètres se calculent localement à partir des dates serveur.
- Dernier état conservé localement pour une réouverture hors connexion, actions désactivées jusqu’à la resynchronisation. Le serveur reste la source de vérité.
- L’application ne connaît pas le morceau réellement joué. Le responsable décide si un skip a été exécuté ou s’il est devenu caduc après un changement naturel.

## Gratuité et limites

Vercel Hobby et Supabase Free seulement. Aucun service payant, aucun domaine acheté, aucun abonnement à une boutique, aucune facturation automatique configurée. La gratuité concerne l’application et son hébergement, pas la connexion Internet ni le service musical utilisé séparément.

La mise en pause Supabase pour faible activité a été acceptée. Les quotas peuvent bloquer le service. Aucune promesse de disponibilité illimitée ou de maintien éternel des offres gratuites. Les abonnements et la consommation restent visibles dans les tableaux de bord des fournisseurs. Ne pas activer une mise à niveau pour lever un quota.

## Export et déplacement

Conserver le dépôt, les migrations, le fichier de configuration et les clés VAPID privées hors Git. Le compte gratuit n’inclut pas les sauvegardes automatiques des offres payantes.

Avec les outils PostgreSQL installés et les paramètres de connexion du projet fournis par Supabase, utiliser `pg_dump` (mot de passe saisi à l’invite, pas dans l’historique) :

```sh
pg_dump --host=HOTE_SUPABASE --port=5432 --username=UTILISATEUR_SUPABASE --dbname=postgres --password --format=custom --schema=jam --file=jam-backup.dump
```

Garder cette sauvegarde privée : elle contient des données et des empreintes de récupération. Pour restaurer sur un **projet vide**, exécuter les migrations, puis restaurer les données avec le compte PostgreSQL d’administration :

```sh
pg_restore --host=NOUVEL_HOTE --port=5432 --username=NOUVEL_UTILISATEUR --dbname=postgres --password --data-only --disable-triggers jam-backup.dump
```

L’usage de `--disable-triggers` pendant cette restauration administrative permet de charger les références circulaires soirée/participants. Ne jamais restaurer par-dessus une soirée active. Cette procédure nécessite un essai de restauration sur un projet vide avant de s’y fier. Les utilisateurs retrouveront leur progression par leur code personnel ; l’ancienne session Supabase ne migre pas automatiquement. Sur changement de domaine, réinstaller/réactiver les notifications et configurer les secrets/cron du nouveau projet.

## Documentation officielle

- [Authentification anonyme Supabase](https://supabase.com/docs/guides/auth/auth-anonymous)
- [Planification des Edge Functions avec Cron et Vault](https://supabase.com/docs/guides/functions/schedule-functions)
- [Dépendances npm dans les Edge Functions](https://supabase.com/docs/guides/functions/dependencies)
- [Notifications Web Push sur iPhone](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- [Web Push et exécution en arrière-plan](https://web.dev/articles/push-notifications-overview)
- [Vercel Hobby](https://vercel.com/docs/plans/hobby), [Supabase Free](https://supabase.com/pricing)
