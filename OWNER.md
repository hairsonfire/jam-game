# Gestion personnelle de Jam

Page privée : https://jam-wine-mu.vercel.app/?gestion=1

Cette page utilise un compte e-mail/mot de passe distinct de votre profil de joueur. Aucun compte n’est propriétaire par défaut. Connaître le lien, créer un compte ou administrer une soirée ne donne pas accès aux données : les deux commandes serveur vérifient une liste privée contenant un seul identifiant autorisé.

## Première activation

1. Appliquer `supabase/migrations/202610100008_site_owner.sql` dans le SQL Editor.
2. Publier l’interface compilée (`npm run build`, dossier `dist`).
3. Ouvrir le lien ci-dessus, renseigner son e-mail et un mot de passe personnel d’au moins 12 caractères, puis ouvrir **Première connexion → Créer mon compte**. Confirmer l’e-mail reçu et se connecter. Ne pas communiquer son mot de passe dans le chat.
4. Dans `supabase/setup-owner.sql`, remplacer `REMPLACER_PAR_VOTRE_EMAIL` par cette adresse, puis exécuter le script dans le SQL Editor. Il refuse les comptes invités et les adresses non confirmées. Un seul compte peut être propriétaire ; réexécuter le script avec un autre compte remplace l’ancien accès.
5. Actualiser la liste. Elle montre toutes les soirées, leur code, leur nombre de joueurs, leur création et leur dernière activité.

Pour supprimer : **Supprimer cette soirée**, recopier son code exact, puis **Effacer définitivement**. Toutes ses données de jeu sont effacées. Les morceaux déjà ajoutés dans une application musicale y restent. Une réponse réseau perdue peut être vérifiée en actualisant ; répéter une suppression ne supprime pas une autre soirée.

La session de gestion reste seulement dans l’onglet (`sessionStorage`), séparée de la session du joueur. Utiliser **Se déconnecter** sur un appareil partagé. La liste n’est pas mise en cache pour un accès hors ligne. L’inactivité de six mois reste gérée par la tâche existante ; consulter cette page ne prolonge pas une soirée.

Pour révoquer l’accès depuis le SQL Editor : `delete from jam.site_owner;`. Pour récupérer un mot de passe perdu, utiliser les outils de récupération du compte dans Supabase Authentication avant de se reconnecter. Ne jamais intégrer de clé `service_role` à l’interface.

## Joueurs et récupération

Dans chaque soirée, **Voir / actualiser les joueurs** affiche les pseudos, rôles et jetons. **Supprimer ce joueur** demande son pseudo exact ; pour supprimer l’administrateur, choisissez son successeur. Si le joueur est seul, supprimez la soirée entière. Les envois Spotify en cours doivent être terminés avant une suppression.

Les codes existants ne peuvent pas être relus : seul leur SHA-256 est conservé. **Nouveau code de récupération → Remplacer et afficher le code** génère un code aléatoire et invalide l’ancien. Copiez-le immédiatement ; il reste uniquement en mémoire sur cette page et n’est jamais conservé en clair sur le serveur. Cela ne ferme pas la session actuelle du joueur. Après une erreur réseau, **Vérifier la dernière action joueur** reprend la même action sans régénérer un autre code.

Migration requise : `supabase/migrations/202610100009_owner_players.sql`.
