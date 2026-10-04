export function isMobileDevice(device: Pick<Navigator, "userAgent" | "maxTouchPoints"> = navigator) {
  return /Android|iPhone|iPad|iPod/i.test(device.userAgent) ||
    (/Macintosh/i.test(device.userAgent) && device.maxTouchPoints > 1);
}

export const desktopNotificationsMessage = "Les notifications de Jam sont indisponibles sur ordinateur. Utilisez votre téléphone pour les activer et les tester.";

export function actionFeedback(kind: string, data: Record<string, unknown> = {}) {
  if (kind === "verdict") return data.success
    ? "Réussite validée ! Le joueur a gagné un jeton pour ajouter une chanson."
    : "Épreuve non réussie. Le joueur peut consulter la suite dans son écran de jeu.";
  const messages: Record<string, string> = {
    create: "Votre soirée est créée. Invitez vos amis avec le QR code !",
    join: "Vous avez rejoint la soirée. À vous de jouer !",
    recover: "Votre profil est retrouvé, avec vos jetons et votre progression.",
    draw: "Votre défi est prêt. Choisissez un ami pour être témoin.",
    invite: "Demande envoyée au témoin. Attendez son accord pour commencer.",
    accept: "C’est parti ! L’épreuve commence maintenant.",
    decline: "Invitation refusée. Le joueur peut choisir un autre témoin.",
    sacrifice: "Le sacrifice remplace votre défi. Choisissez votre témoin.",
    abandon: "Épreuve abandonnée. Vous pourrez tirer un nouveau défi dans deux minutes.",
    song: "Chanson demandée ! La personne qui contrôle la musique a reçu votre demande. Un jeton a été utilisé.",
    queue: "Chanson ajoutée à la file ! La demande est terminée, le joueur peut en proposer une autre.",
    skip: "Demande de skip envoyée. Votre jeton est réservé en attendant la réponse.",
    skip_done: "Skip confirmé. Le jeton réservé a été utilisé.",
    reject: "Demande annulée. Le jeton a été rendu au joueur.",
    settings: "Les réglages de la soirée sont enregistrés.",
    challenge: "Défi enregistré. Il sera utilisé pour les prochains tirages.",
    subscribe: "Notifications activées sur cet appareil.",
    test_push: "Test demandé. Une notification devrait apparaître sur votre téléphone ; elle peut prendre quelques instants.",
  };
  return messages[kind] ?? "";
}
