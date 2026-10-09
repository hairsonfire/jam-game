# Connecter Spotify à Jam

## Activation de cette version

Cette intégration utilise le compte Premium du responsable. Les joueurs ne connectent pas de compte Spotify. Le mode manuel reste disponible tant que le responsable n’a pas connecté Spotify.

1. Dans le tableau de bord Spotify Developers de votre application, ajoutez exactement cette **Redirect URI**, puis enregistrez :

   `https://jam-wine-mu.vercel.app/?spotify=callback`

2. En mode développement, vérifiez que le compte du responsable est autorisé dans les utilisateurs de l’application Spotify.
3. Appliquez `supabase/migrations/202610090007_spotify.sql` après les migrations précédentes dans le SQL Editor Supabase.
4. Dans les secrets Edge Functions, conservez `APP_ORIGIN=https://jam-wine-mu.vercel.app` et `PUSH_CRON_SECRET` déjà configurés. Ajoutez :
   - `SPOTIFY_CLIENT_ID=48f3dd78f87043be899444dba6f59dce` (identifiant public) ;
   - `SPOTIFY_ENCRYPTION_KEY` : 32 octets aléatoires encodés en base64, générés une fois et sauvegardés hors Git. Ne pas utiliser le Client ID comme clé. Ne pas changer cette clé pendant une soirée : les comptes connectés devraient être reconnectés.
5. Déployez `supabase/functions/spotify/index.ts` sous le nom **spotify**, avec la vérification JWT historique désactivée. Le code vérifie les sessions avec `auth.getUser` et les appartenances/rôles en base ; seul le secret de planification existant autorise une synchronisation sans session utilisateur. Les clés privées ne sont jamais dans le navigateur.
6. Exécutez `supabase/setup-spotify-cron.sql`. Ce script réutilise les secrets Vault du push ; il synchronise chaque minute les soirées actives, même sans téléphone ouvert. Aucun abonnement supplémentaire.
7. Publiez le résultat de `npm run build` sur l’hébergement habituel.
8. Dans Jam, ouvrez **Régie → Connecter Spotify**, acceptez les permissions et lancez un morceau dans Spotify sur l’appareil de la soirée. Terminez auparavant les demandes manuelles encore en attente.

Aucun Client Secret n’est utilisé : connexion OAuth avec PKCE. Référence : https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow

## Pendant la soirée

- Le témoin valide le défi comme avant. Le joueur gagne son jeton, recherche un titre dans **Musique**, puis choisit **Ajouter · 1 jeton**. Le titre est envoyé automatiquement ; aucune validation du responsable n’est demandée.
- Dès l’ajout confirmé par Spotify, le joueur peut demander une autre chanson avec un autre jeton.
- **Mes chansons** indique la position et une attente estimée dans la file visible. Une observation de lecture après la demande permet d’afficher **Lecture détectée**. Cela ne prouve pas une écoute complète. Un morceau passé entre deux vérifications peut rester « lecture non confirmée » ; une disparition de la file seule ne prouve jamais sa lecture.
- **Passer maintenant** déclenche le skip directement. Si le morceau a changé avant le traitement, le jeton est conservé. Le skip ne change pas la priorité des demandes.
- Le responsable dispose de **Lecture**, **Pause** et **Choisir l’appareil**.
- Si Spotify refuse une demande, le jeton est restitué une seule fois. Si la réponse à une commande est perdue, Jam ne la renvoie pas automatiquement : le responsable vérifie dans Spotify si elle a eu lieu, puis clôture la demande dans la régie. Cette vérification exceptionnelle évite les doubles ajouts et doubles skips.

Le suivi se met à jour au mieux toutes les dix secondes avec Jam ouvert, et chaque minute avec la tâche serveur. Ce sont des cadences de tentative, pas des garanties. Les limites Spotify, pauses, changements d’appareil et modifications manuelles peuvent affecter les délais. Un même compte ne peut être connecté qu’à une seule soirée à la fois. Aucun historique personnel complet ni playlist souvenir n’est demandé.

## Contrôles avant publication

- `npm test` : transactions SQL, identités, OAuth lié au responsable, secrets non exposés, verrou d’exécution, doubles dépenses/remboursements, résolution des réponses perdues, skips réservés, observation de lecture et délai de reprise.
- `npm run build` : TypeScript et production.
- `npx deno check --config supabase/functions/spotify/deno.json supabase/functions/spotify/index.ts` : fonction serveur.
- `npm run test:ui` : parcours mobiles simulés.

Les tests locaux ne contactent pas le compte Spotify réel. Après déploiement, tester avec Premium : connexion/retour, recherche, ajout avec défi validé, lecture détectée, pause/reprise, choix d’appareil, skip avec bonus de test à 100 %, puis remettre le bonus à 0 %. Vérifier aussi l’absence d’appareil actif et le comportement après coupure réseau. Ne pas annoncer ces essais réels comme réussis avant de les effectuer.
