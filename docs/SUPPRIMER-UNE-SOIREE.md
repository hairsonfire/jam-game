# Supprimer une soirée soi-même

Le [script de suppression](../supabase/delete-party.sql) s’utilise dans **SQL Editor** du tableau de bord du serveur, avec le rôle **postgres**. Aucun logiciel à installer. Vous pouvez enregistrer la requête dans SQL Editor pour la retrouver la prochaine fois.

## 1. Afficher l’aperçu

Copiez le script **en entier** dans une nouvelle requête. Changez uniquement le code dans cette ligne :

```sql
code_soiree text := 'VOTRE_CODE';
```

Gardez `confirmer boolean := false;`, puis cliquez sur **Run** sans sélectionner une partie du texte. Les tirets et espaces du code sont acceptés. Le résultat affiche le nom de la soirée et le nombre de participants, défis, épreuves, demandes et événements de notification concernés. **À cette étape, rien n’est supprimé.**

## 2. Confirmer la suppression

Vérifiez le nom et le code affichés, puis modifiez ces deux lignes :

```sql
confirmer boolean := true;
nom_attendu text := 'Nom exact affiché dans l’aperçu';
```

Dans une valeur SQL, une apostrophe doit être doublée : pour `La soirée d’Alice` avec une apostrophe droite, écrire `'La soirée d''Alice'`.

Exécutez à nouveau **tout le script**. Si le tableau de bord demande confirmation, vérifiez qu’il s’agit de cette requête. Le résultat `SUPPRIMÉE — opération définitive` confirme la suppression. Remettez ensuite `confirmer` à `false` avant d’enregistrer la requête pour la prochaine utilisation.

**Cette opération est définitive.** Elle efface la soirée, ses participants et jetons, défis, tentatives, demandes musicales, historique et abonnements aux notifications. Les autres soirées et les comptes de connexion sont conservés. Des reçus techniques sans les données de la soirée restent pour empêcher qu’une ancienne action rejouée recrée celle-ci. Les limites de fréquence communes à une identité restent également en place.

La suppression ne ferme pas instantanément les écrans déjà ouverts : les participants perdent l’accès à la prochaine synchronisation et peuvent utiliser **? → Quitter ce profil**. Une notification déjà transmise ne peut pas être rappelée.

## Si une erreur apparaît

- **Code introuvable :** vérifiez le code ; une soirée déjà supprimée ne peut pas l’être une deuxième fois.
- **Nom incorrect :** recopiez exactement le nom affiché par l’aperçu.
- **Délai d’attente ou autre erreur :** l’opération est annulée en entier, sans suppression partielle. Si l’éditeur indique qu’une transaction est interrompue, exécutez `ROLLBACK;` seul, puis relancez le script complet. Évitez de supprimer une soirée pendant que les participants jouent.

Ce script reste une solution manuelle pour le propriétaire du serveur. L’administrateur peut aussi supprimer sa soirée depuis **Réglages → Clore et effacer la soirée** dans Jam. Avec la migration 005 et le job `jam-room-cleanup` installés, un nettoyage quotidien supprime les soirées après six mois sans ouverture ni action ; il reprend après réactivation si le serveur est en pause.
