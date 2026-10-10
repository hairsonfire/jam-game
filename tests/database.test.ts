import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";

let db: PGlite;
const alice = randomUUID(),
  bob = randomUUID(),
  carol = randomUUID(),
  outsider = randomUUID();
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
async function spotify(op: string, args: Record<string, unknown> = {}, userId = alice) {
  await db.exec('set role service_role');
  try {
    return (await db.query<any>('select public.spotify_service($1,$2::jsonb) result', [op, JSON.stringify({roomId: room, userId, ...args})])).rows[0].result;
  } finally { await db.exec('reset role'); }
}
let room: string, code: string, aId: string, bId: string, cId: string;
async function as(user: string) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
}
async function cmd(
  user: string,
  kind: string,
  payload: Record<string, unknown> = {},
  id = randomUUID(),
) {
  await as(user);
  await db.exec("set role authenticated");
  try {
    const { rows } = await db.query<{ result: Record<string, any> }>(
      "select public.game_command($1,$2,$3::jsonb) result",
      [id, kind, JSON.stringify({ roomId: room, ...payload })],
    );
    if (rows[0].result.error) throw new Error(rows[0].result.error);
    return rows[0].result;
  } finally {
    await db.exec("reset role");
  }
}
async function state(user = alice) {
  await as(user);
  await db.exec("set role authenticated");
  try {
    const { rows } = await db.query<{ result: any }>(
      "select public.game_state($1) result",
      [room],
    );
    return rows[0].result;
  } finally {
    await db.exec("reset role");
  }
}
async function query(sql: string, params: unknown[] = []) {
  return (await db.query<any>(sql, params)).rows;
}
async function assigned(user = alice) {
  const res = await cmd(user, "draw");
  return res.assignmentId as string;
}
async function start(user = alice, witness = bob, witnessId = bId) {
  const assignmentId = await assigned(user);
  await cmd(user, "invite", { assignmentId, witnessId });
  const [{ attempt_id: attemptId }] = await query(
    "select attempt_id from jam.assignments where id=$1",
    [assignmentId],
  );
  await cmd(witness, "accept", { assignmentId, attemptId });
  return { assignmentId, attemptId };
}
async function win(user = alice, witness = bob, witnessId = bId) {
  const attempt = await start(user, witness, witnessId);
  await cmd(witness, "verdict", { ...attempt, success: true, inTime: true });
  return attempt;
}
beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
  for (const name of readdirSync("supabase/migrations").filter(n => n.endsWith(".sql")).sort())
    await db.exec(readFileSync("supabase/migrations/" + name, "utf8"));
}, 30000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec(
    "truncate jam.rooms,jam.players,jam.challenges,jam.assignments,jam.attempts,jam.requests,jam.ledger,jam.events,jam.subscriptions,jam.deliveries,jam.receipts,jam.limits cascade",
  );
  const created = await cmd(alice, "create", {
    name: "Alice",
    roomName: "Chez Alice",
    recoveryHash: hash("alice"),
  });
  room = created.roomId;
  code = created.code;
  aId = created.playerId;
  bId = (
    await cmd(bob, "join", { code, name: "Bob", recoveryHash: hash("bob") })
  ).playerId;
  cId = (
    await cmd(carol, "join", {
      code,
      name: "Carole",
      recoveryHash: hash("carol"),
    })
  ).playerId;
});

describe("Suppression manuelle d’une soirée", () => {
  const script = (roomCode: string, confirm = false, name = "") =>
    readFileSync("supabase/delete-party.sql", "utf8")
      .replace("code_soiree text := 'CODE_DE_LA_SOIREE'", `code_soiree text := '${roomCode}'`)
      .replace("confirmer boolean := false", `confirmer boolean := ${confirm}`)
      .replace("nom_attendu text := ''", `nom_attendu text := '${name}'`);

  it("prévisualise sans supprimer et refuse un nom ou code incorrect", async () => {
    await db.exec(script(code));
    expect((await state()).players).toHaveLength(3);
    for (const sql of [script(code, true, "Autre soirée"), script("INCONNU", true)]) {
      await expect(db.exec(sql)).rejects.toThrow();
      await db.exec("rollback");
      expect((await state()).players).toHaveLength(3);
    }
  });

  it("supprime les données liées, préserve les autres soirées et neutralise les reçus", async () => {
    await cmd(alice, "subscribe", {
      endpoint: "https://fcm.googleapis.com/fcm/send/deletion-test",
      p256dh: "a".repeat(87), auth: "b".repeat(22),
    });
    await win();
    await cmd(alice, "song", { text: "Chanson de test" });
    const other = await cmd(alice, "create", {
      name: "Alice", roomName: "À conserver", recoveryHash: hash("other"),
    });
    const before = await query("select * from jam.receipts where result->>'roomId'=$1", [other.roomId]);
    await db.exec(script(code.toLowerCase().replace(/(.{4})/g, "$1-"), true, "Chez Alice"));
    for (const table of ["assignments", "attempts", "requests", "ledger", "events", "subscriptions", "deliveries"]) {
      expect((await query(`select count(*)::int n from jam.${table}`))[0].n).toBe(0);
    }
    expect((await query("select id from jam.rooms"))).toEqual([{ id: other.roomId }]);
    expect((await query("select room_id from jam.players"))).toEqual([{ room_id: other.roomId }]);
    expect((await query("select count(*)::int n from jam.challenges where room_id=$1", [other.roomId]))[0].n).toBe(4);
    expect(await query("select * from jam.receipts where result->>'roomId'=$1", [other.roomId])).toEqual(before);
    expect((await query("select count(*)::int n from jam.receipts where coalesce(result->>'roomId',payload->>'roomId')=$1", [room]))[0].n).toBe(0);
    await expect(state()).rejects.toThrow();
    await expect(db.exec(script(code, true, "Chez Alice"))).rejects.toThrow(/Aucune soirée/);
    await db.exec("rollback");
  });
});

describe("Administration des joueurs et fin de soirée", () => {
  it("réserve les suppressions à l’admin et exige une confirmation", async () => {
    for (const user of [bob, outsider]) {
      await expect(cmd(user, "remove_player", { playerId: cId, confirmed: true })).rejects.toThrow();
      await expect(cmd(user, "delete_room", { confirmed: true, roomCode: code })).rejects.toThrow();
    }
    await expect(cmd(alice, "remove_player", { playerId: bId })).rejects.toThrow(/Confirmez/);
    await expect(cmd(alice, "remove_player", { playerId: aId, confirmed: true })).rejects.toThrow(/administrateur/);
    await expect(cmd(alice, "delete_room", { confirmed: true, roomCode: "FAUX" })).rejects.toThrow(/code/);
    await db.exec("set role authenticated");
    await expect(db.query("select jam.purge_inactive_rooms()")).rejects.toThrow(/permission denied/);
    await expect(db.query("select jam.erase_room($1)", [room])).rejects.toThrow(/permission denied/);
    await db.exec("reset role");
    expect((await state()).players).toHaveLength(3);
  });

  it("retire un témoin sans autoriser de nouveau verdict ni recommencer un échec", async () => {
    const running = await start();
    const failed = await start(carol);
    await cmd(bob, "verdict", { ...failed, success: false });
    const action = randomUUID();
    const payload = { playerId: bId, confirmed: true };
    await cmd(alice, "remove_player", payload, action);
    await cmd(alice, "remove_player", payload, action);
    await expect(cmd(bob, "verdict", { ...running, success: true, inTime: true })).rejects.toThrow();
    const reset = (await state()).assignments[0];
    expect(reset.status).toBe("assigned");
    expect(reset.attempt_id).toBeNull();
    expect(reset.started_at).toBeNull();
    expect((await state(carol)).assignments[0].status).toBe("failed");
    await expect(cmd(carol, "invite", { ...failed, witnessId: aId })).rejects.toThrow(/Après échec/);
    await cmd(alice, "invite", { ...running, witnessId: cId });
    expect((await state()).me.adds).toBe(0);
  });

  it("supprime les demandes et abonnements du joueur, et réattribue la musique", async () => {
    await cmd(alice, "settings", { musicId: bId, bonus: 100, sacrifice: "Gage" });
    await cmd(bob, "subscribe", { endpoint: "https://fcm.googleapis.com/fcm/send/remove", p256dh: "a".repeat(87), auth: "b".repeat(22) });
    await win(bob, alice, aId);
    await cmd(bob, "song", { text: "Ma chanson" });
    await cmd(bob, "skip");
    await cmd(alice, "remove_player", { playerId: bId, confirmed: true });
    for (const table of ["requests", "assignments", "ledger", "subscriptions"])
      expect(await query(`select id from jam.${table} where player_id=$1`, [bId])).toHaveLength(0);
    expect((await state()).room.music_id).toBe(aId);
    await expect(state(bob)).rejects.toThrow(/plus accès/);
    await expect(cmd(bob, "recover", { code, recoveryHash: hash("bob"), newRecoveryHash: hash("next") })).rejects.toThrow(/incorrect/);
    await cmd(bob, "join", { code, name: "Bob de retour", recoveryHash: hash("fresh") });
    expect((await state(bob)).me.adds).toBe(0);
    expect((await state(bob)).me.skip).toBe(false);
  });

  it("efface la soirée, permet la reprise du même clic et préserve une autre soirée", async () => {
    const other = await cmd(carol, "create", { name: "Carole", roomName: "Autre", recoveryHash: hash("other") });
    const action = randomUUID(), payload = { confirmed: true, roomCode: code };
    expect(await cmd(alice, "delete_room", payload, action)).toEqual({ deleted: true });
    expect(await cmd(alice, "delete_room", payload, action)).toEqual({ deleted: true });
    await expect(state()).rejects.toThrow(/supprimée/);
    expect(await query("select id from jam.rooms")).toEqual([{ id: other.roomId }]);
    await expect(cmd(bob, "join", { code, name: "Bob", recoveryHash: hash("b2") })).rejects.toThrow(/introuvable/);
  });

  it("réinitialise l’inactivité sur lecture ou action réussie, pas sur un accès refusé", async () => {
    const age = () => db.query("update jam.rooms set last_activity_at=now()-interval '7 months' where id=$1", [room]);
    await age();
    await expect(state(outsider)).rejects.toThrow();
    expect((await query("select last_activity_at < now()-interval '6 months' old from jam.rooms"))[0].old).toBe(true);
    await state();
    expect((await query("select jam.purge_inactive_rooms() n"))[0].n).toBe(0);
    await age();
    await cmd(alice, "draw");
    expect((await query("select jam.purge_inactive_rooms() n"))[0].n).toBe(0);
  });

  it("nettoie uniquement après six mois et supporte plusieurs passages", async () => {
    await win();
    await cmd(alice, "song", { text: "À supprimer" });
    const other = await cmd(carol, "create", { name: "Carole", recoveryHash: hash("other") });
    await db.query("update jam.rooms set last_activity_at=now()-interval '6 months'+interval '1 day' where id=$1", [room]);
    expect((await query("select jam.purge_inactive_rooms() n"))[0].n).toBe(0);
    await db.query("update jam.rooms set last_activity_at=now()-interval '6 months'-interval '1 day' where id=$1", [room]);
    expect((await query("select jam.purge_inactive_rooms() n"))[0].n).toBe(1);
    expect((await query("select jam.purge_inactive_rooms() n"))[0].n).toBe(0);
    expect(await query("select id from jam.rooms")).toEqual([{ id: other.roomId }]);
    expect(await query("select id from jam.requests")).toHaveLength(0);
  });
});

describe("Accès, sessions et administration", () => {
  it("partage une soirée réelle, avec zéro jeton et aucun secret dans les états", async () => {
    const s = await state();
    expect(s.players).toHaveLength(3);
    expect(s.me.adds).toBe(0);
    expect(s.room.bonus).toBe(0);
    expect(JSON.stringify(s)).not.toContain("recovery_hash");
    expect(JSON.stringify(s)).not.toContain(alice);
    expect((await state(bob)).room.id).toBe(room);
  });
  it("bloque les accès externes et les écritures directes", async () => {
    await expect(state(outsider)).rejects.toThrow(/plus accès/);
    await expect(cmd(outsider, "draw")).rejects.toThrow(/participez pas/);
    await db.exec("set role authenticated");
    await expect(db.query("update jam.players set adds=999")).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.query("select public.push_claim(25)")).rejects.toThrow(
      /permission denied/,
    );
    await db.exec("reset role");
    await expect(
      cmd(bob, "settings", { musicId: bId, bonus: 100, sacrifice: "Gage" }),
    ).rejects.toThrow(/administrateur/);
  });
  it("récupère un profil, conserve les jetons et révoque l’ancienne identité", async () => {
    await win();
    await cmd(outsider, "recover", {
      code,
      recoveryHash: hash("alice"),
      newRecoveryHash: hash("rotated"),
    });
    expect((await state(outsider)).me.adds).toBe(1);
    expect((await state(outsider)).me.id).toBe(aId);
    await expect(state(alice)).rejects.toThrow(/plus accès/);
    await expect(
      cmd(alice, "recover", {
        code,
        recoveryHash: hash("alice"),
        newRecoveryHash: hash("new"),
      }),
    ).rejects.toThrow(/incorrect/);
  });
  it("limite les mauvaises tentatives de récupération sans annuler le compteur", async () => {
    for (let i = 0; i < 5; i++)
      await expect(
        cmd(outsider, "recover", {
          code,
          recoveryHash: hash("wrong"),
          newRecoveryHash: hash("next"),
        }),
      ).rejects.toThrow(/incorrect/);
    await expect(
      cmd(outsider, "recover", {
        code,
        recoveryHash: hash("alice"),
        newRecoveryHash: hash("next"),
      }),
    ).rejects.toThrow(/15 minutes/);
  });
  it("conserve le texte attribué après une modification des défis", async () => {
    const id = await assigned();
    const before = (await state()).assignments[0];
    for (const c of (await state()).challenges)
      await cmd(alice, "challenge", {
        challengeId: c.id,
        text: "Nouveau texte",
        duration: 3,
        active: false,
      });
    expect((await state()).assignments[0].text).toBe(before.text);
    await cmd(alice, "abandon", { assignmentId: id });
    await db.query(
      "update jam.players set cooldown_until=now()-interval '1 second' where id=$1",
      [aId],
    );
    await expect(cmd(alice, "draw")).rejects.toThrow(/Aucun défi actif/);
  });
});
describe("Épreuves et récompenses", () => {
  it("interdit deux épreuves et le témoignage de soi-même", async () => {
    const assignmentId = await assigned();
    await expect(cmd(alice, "draw")).rejects.toThrow(/déjà/);
    await expect(
      cmd(alice, "invite", { assignmentId, witnessId: aId }),
    ).rejects.toThrow(/autre participant/);
    expect((await state()).me.adds).toBe(0);
  });
  it("démarre à l’acceptation et exige l’attestation du délai, même tardive", async () => {
    const attempt = await start();
    await expect(
      cmd(bob, "verdict", { ...attempt, success: true }),
    ).rejects.toThrow(/Attestez/);
    await db.query(
      "update jam.assignments set started_at=now()-interval '1 hour' where id=$1",
      [attempt.assignmentId],
    );
    expect((await state()).me.adds).toBe(0);
    await cmd(bob, "verdict", { ...attempt, success: true, inTime: true });
    expect((await state()).me.adds).toBe(1);
    expect((await state()).me.skip).toBe(false);
  });
  it("ne récompense qu’une fois et mémorise le tirage après répétition", async () => {
    const attempt = await start(),
      id = randomUUID();
    await cmd(bob, "verdict", { ...attempt, success: true, inTime: true }, id);
    const [before] = await query(
      "select bonus_roll from jam.assignments where id=$1",
      [attempt.assignmentId],
    );
    await cmd(bob, "verdict", { ...attempt, success: true, inTime: true }, id);
    await expect(
      cmd(bob, "verdict", { ...attempt, success: true, inTime: true }),
    ).rejects.toThrow(/plus disponible/);
    expect((await state()).me.adds).toBe(1);
    expect(await query("select * from jam.ledger")).toHaveLength(1);
    expect(
      (
        await query("select bonus_roll from jam.assignments where id=$1", [
          attempt.assignmentId,
        ])
      )[0],
    ).toEqual(before);
    await expect(
      cmd(bob, "verdict", { ...attempt, success: false }, id),
    ).rejects.toThrow(/autre action/);
  });
  it("empêche les verdicts non autorisés et invalide l’ancien témoin", async () => {
    const attempt = await start();
    await expect(
      cmd(carol, "verdict", { ...attempt, success: true, inTime: true }),
    ).rejects.toThrow(/autorisé/);
    await cmd(alice, "invite", {
      assignmentId: attempt.assignmentId,
      witnessId: cId,
      unavailable: true,
    });
    await expect(
      cmd(bob, "verdict", { ...attempt, success: true, inTime: true }),
    ).rejects.toThrow(/autorisé/);
    const current = (await state()).assignments[0];
    expect(current.started_at).toBeNull();
    await cmd(carol, "accept", {
      assignmentId: current.id,
      attemptId: current.attempt_id,
    });
    await cmd(carol, "verdict", {
      assignmentId: current.id,
      attemptId: current.attempt_id,
      success: true,
      inTime: true,
    });
    expect((await state()).me.adds).toBe(1);
  });
  it("après échec : sacrifice ou abandon, jamais nouvelle tentative", async () => {
    const attempt = await start();
    await cmd(bob, "verdict", { ...attempt, success: false });
    await expect(
      cmd(alice, "invite", {
        assignmentId: attempt.assignmentId,
        witnessId: cId,
      }),
    ).rejects.toThrow(/Après échec/);
    await expect(
      cmd(alice, "sacrifice", { assignmentId: attempt.assignmentId }),
    ).rejects.toThrow(/configuré/);
    await cmd(alice, "settings", {
      musicId: aId,
      bonus: 100,
      sacrifice: "Gage personnalisé",
    });
    await cmd(alice, "sacrifice", { assignmentId: attempt.assignmentId });
    await cmd(alice, "invite", {
      assignmentId: attempt.assignmentId,
      witnessId: bId,
    });
    const a = (await state()).assignments[0];
    await cmd(bob, "accept", { assignmentId: a.id, attemptId: a.attempt_id });
    await cmd(bob, "verdict", {
      assignmentId: a.id,
      attemptId: a.attempt_id,
      success: true,
    });
    expect((await state()).me.skip).toBe(true);
    expect((await state()).me.adds).toBe(1);
    const [row] = await query(
      "select bonus_roll from jam.assignments where id=$1",
      [a.id],
    );
    expect(row.bonus_roll).not.toBeNull();
  });
  it.each([0, 100])("sacrifice : bonus à %i % fixé à la validation, sans double récompense", async bonus => {
    await cmd(alice, "settings", { musicId: aId, bonus: 0, sacrifice: "Gage" });
    async function sacrifice() {
      const assignmentId = await assigned();
      await cmd(alice, "sacrifice", { assignmentId });
      await cmd(alice, "invite", { assignmentId, witnessId: bId });
      const a = (await state()).assignments.find((a: any) => a.id === assignmentId);
      const verdict = { assignmentId, attemptId: a.attempt_id, success: true };
      await cmd(bob, "accept", verdict);
      return verdict;
    }
    const verdict = await sacrifice();
    await cmd(alice, "settings", { musicId: aId, bonus, sacrifice: "Gage" });
    const action = randomUUID();
    await cmd(bob, "verdict", verdict, action);
    const [original] = await query("select bonus_rate,bonus_roll,bonus_won from jam.assignments where id=$1", [verdict.assignmentId]);
    expect(original.bonus_rate).toBe(bonus);
    expect(original.bonus_roll).not.toBeNull();
    expect(original.bonus_won).toBe(bonus === 100);
    await cmd(bob, "verdict", verdict, action);
    await expect(cmd(bob, "verdict", verdict)).rejects.toThrow();
    expect((await state()).me.adds).toBe(1);
    expect((await state()).me.skip).toBe(bonus === 100);
    expect((await query("select bonus_rate,bonus_roll,bonus_won from jam.assignments where id=$1", [verdict.assignmentId]))[0]).toEqual(original);
    if (bonus === 100) {
      await cmd(alice, "skip");
      await cmd(bob, "verdict", await sacrifice());
      const [last] = await query("select bonus_roll,bonus_won from jam.assignments where player_id=$1 and id<>$2", [aId, verdict.assignmentId]);
      expect(last.bonus_roll).toBeNull();
      expect(last.bonus_won).toBe(false);
      expect((await state()).me.adds).toBe(2);
    }
  });
  it("un sacrifice refusé laisse seulement l’abandon, qui impose dix minutes", async () => {
    await cmd(alice, "settings", { musicId: aId, bonus: 0, sacrifice: "Gage" });
    const id = await assigned();
    await cmd(alice, "sacrifice", { assignmentId: id });
    await cmd(alice, "invite", { assignmentId: id, witnessId: bId });
    const a = (await state()).assignments[0];
    await cmd(bob, "accept", { assignmentId: id, attemptId: a.attempt_id });
    await cmd(bob, "verdict", {
      assignmentId: id,
      attemptId: a.attempt_id,
      success: false,
    });
    await expect(cmd(alice, "sacrifice", { assignmentId: id })).rejects.toThrow(
      /déjà/,
    );
    await expect(
      cmd(alice, "invite", { assignmentId: id, witnessId: cId }),
    ).rejects.toThrow(/Après échec/);
    await cmd(alice, "abandon", { assignmentId: id });
    await expect(cmd(alice, "draw")).rejects.toThrow(/dix minutes/);
    const s = await state();
    expect(
      Date.parse(s.me.cooldown_until) - Date.parse(s.serverTime),
    ).toBeGreaterThan(598000);
    await db.query("update jam.players set cooldown_until=now()+interval '7 minutes' where id=$1", [aId]);
    await expect(cmd(alice, "draw")).rejects.toThrow(/dix minutes/);
    await db.query("update jam.players set cooldown_until=now()-interval '1 second' where id=$1", [aId]);
    await expect(cmd(alice, "draw")).resolves.toHaveProperty("assignmentId");
  });
  it("respecte 100 %, le plafond et la réservation du skip", async () => {
    await cmd(alice, "settings", { musicId: aId, bonus: 100, sacrifice: "" });
    await win();
    expect((await state()).me.skip).toBe(true);
    await cmd(alice, "skip");
    const second = await win();
    const [a] = await query(
      "select bonus_roll,bonus_won from jam.assignments where id=$1",
      [second.assignmentId],
    );
    expect(a.bonus_roll).toBeNull();
    expect(a.bonus_won).toBe(false);
    expect((await state()).me.adds).toBe(2);
  });
});
describe("Demandes musicales", () => {
  it("partage les chansons ajoutées avec les autres joueurs, sans ouvrir la soirée aux inconnus", async () => {
    await win();
    await cmd(alice, "song", { text: "Chanson partagée" });
    const requestId = (await state()).requests[0].id;
    await cmd(alice, "queue", { requestId });
    expect((await state(bob)).requests).toEqual(expect.arrayContaining([expect.objectContaining({id:requestId, player_id:aId, status:"queued"})]));
    await expect(state(outsider)).rejects.toThrow();
  });
  it("dépense un jeton, préserve le texte et libère la place dès l’ajout à la file", async () => {
    await win();
    await win();
    const text = "  Blinding Lights — The Weeknd  ";
    await cmd(alice, "song", { text });
    let s = await state();
    const requestId = s.requests[0].id;
    expect(s.requests[0].text).toBe(text);
    expect(s.me.adds).toBe(1);
    await expect(cmd(alice, "song", { text: "Autre" })).rejects.toThrow(/encore en attente/);
    await expect(cmd(bob, "queue", { requestId })).rejects.toThrow(/responsable/);
    const action = randomUUID();
    await cmd(alice, "queue", { requestId }, action);
    await cmd(alice, "queue", { requestId }, action);
    expect((await state()).requests[0].resolved_at).toBeTruthy();
    await expect(cmd(alice, "reject", { requestId, reason: "Trop tard" })).rejects.toThrow(/déjà traitée/);
    await expect(cmd(alice, "queue", { requestId })).rejects.toThrow(/déjà traitée/);
    await cmd(alice, "song", { text: "Nouvelle chanson" });
    expect((await state()).me.adds).toBe(0);
  });
  it("bloque les doubles dépenses de requêtes rapprochées", async () => {
    await win();
    await as(alice);
    await db.exec("set role authenticated");
    const attempt = () =>
      db.query("select public.game_command($1,$2,$3::jsonb)", [
        randomUUID(),
        "song",
        JSON.stringify({ roomId: room, text: "Chanson" }),
      ]);
    const results = await Promise.allSettled([attempt(), attempt()]);
    await db.exec("reset role");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await state()).me.adds).toBe(0);
    expect((await state()).requests).toHaveLength(1);
  });
  it("refus avant ajout avec motif et remboursement unique", async () => {
    await win();
    await cmd(alice, "song", { text: "Introuvable" });
    const requestId = (await state()).requests[0].id;
    await expect(
      cmd(bob, "reject", { requestId, reason: "Non" }),
    ).rejects.toThrow(/responsable/);

    await cmd(alice, "reject", {
      requestId,
      reason: "Introuvable",
      removed: true,
    });
    await expect(
      cmd(alice, "reject", { requestId, reason: "Encore", removed: true }),
    ).rejects.toThrow(/déjà traitée/);
    await expect(cmd(alice, "queue", { requestId })).rejects.toThrow(
      /déjà traitée/,
    );
    expect((await state()).me.adds).toBe(1);
  });
  it("un seul skip, sans dépense concurrente ni priorité musicale", async () => {
    await cmd(alice, "settings", { musicId: aId, bonus: 100, sacrifice: "" });
    await win();
    await win(bob, carol, cId);
    await cmd(alice, "skip");
    await expect(cmd(bob, "skip")).rejects.toThrow(/déjà en attente/);
    expect((await state(bob)).me.skip).toBe(true);
    let requestId = (await state()).requests[0].id;
    await cmd(alice, "reject", {
      requestId,
      reason: "Le morceau a changé naturellement",
    });
    expect((await state()).me.skip).toBe(true);
    await cmd(bob, "skip");
    requestId = (await state()).requests.find(
      (r: any) => r.status === "pending",
    ).id;
    await expect(cmd(alice, "skip_done", { requestId })).rejects.toThrow(
      /réellement/,
    );
    await cmd(alice, "skip_done", { requestId, performed: true });
    expect((await state(bob)).me.skip).toBe(false);
    expect((await state()).requests.some((r: any) => r.kind === "song")).toBe(
      false,
    );
  });
  it("déclenche Taylor Swift à l’ajout à la file, sans casse et une seule fois", async () => {
    await win();
    await cmd(alice, "song", { text: "Anti-Hero — TAYLOR swift" });
    const requestId = (await state()).requests[0].id;
    const id = randomUUID();
    await cmd(alice, "queue", { requestId }, id);
    await cmd(alice, "queue", { requestId }, id);
    const events = (await state(bob)).events.filter(
      (e: any) => e.kind === "taylor",
    );
    expect(events).toHaveLength(1);
    expect(events[0].body).toBe("Du Taylor Swift Arrive, bienvenue en enfer");
  });
});
describe("Notifications persistantes", () => {
  it("stocke les notifications, réserve les envois et reprend après erreur", async () => {
    await cmd(alice, "subscribe", {
      endpoint: "https://fcm.googleapis.com/fcm/send/test",
      p256dh: "a".repeat(87),
      auth: "b".repeat(22),
    });
    await cmd(alice, "test_push");
    const [{ batch }] = await query("select public.push_claim(25) batch");
    expect(batch).toHaveLength(1);
    expect(
      (await query("select public.push_claim(25) batch"))[0].batch,
    ).toHaveLength(0);
    await db.query("select public.push_finish($1,$2,$3)", [
      batch[0].id,
      batch[0].lease,
      "network",
    ]);
    await db.exec(
      "update jam.deliveries set available_at=now()-interval '1 second'",
    );
    const [retry] = await query("select public.push_claim(25) batch");
    expect(retry.batch[0].attempts).toBe(2);
    await db.query("select public.push_finish($1,$2,$3)", [
      batch[0].id,
      batch[0].lease,
      "sent",
    ]);
    expect(
      (await query("select sent_at from jam.deliveries"))[0].sent_at,
    ).toBeNull();
    await db.query("select public.push_finish($1,$2,$3)", [
      retry.batch[0].id,
      retry.batch[0].lease,
      "sent",
    ]);
    expect(
      (await query("select sent_at from jam.deliveries"))[0].sent_at,
    ).not.toBeNull();
  });
  it("refuse un endpoint arbitraire et nettoie une souscription expirée", async () => {
    await expect(
      cmd(alice, "subscribe", {
        endpoint: "https://localhost/private",
        p256dh: "a".repeat(87),
        auth: "b".repeat(22),
      }),
    ).rejects.toThrow(/non reconnu/);
    await cmd(alice, "subscribe", {
      endpoint: "https://web.push.apple.com/test",
      p256dh: "a".repeat(87),
      auth: "b".repeat(22),
    });
    await cmd(alice, "test_push");
    const [{ batch }] = await query("select public.push_claim(25) batch");
    await db.query("select public.push_finish($1,$2,$3)", [
      batch[0].id,
      batch[0].lease,
      "gone",
    ]);
    expect(await query("select * from jam.subscriptions")).toHaveLength(0);
    expect((await state()).events.some((e: any) => e.kind === "test")).toBe(
      true,
    );
  });
});

describe('Spotify : transactions et permissions', () => {
  const track = { id: '1234567890123456789012', uri: 'spotify:track:1234567890123456789012', name: 'Test', artists: 'Artiste', durationMs: 180000, url: 'https://open.spotify.com/track/1234567890123456789012', image: null };
  async function connected() {
    await spotify('connect', { accountId: 'premium-test', credentials: 'encrypted-test' });
    await spotify('cache', { tracks: [track] });
    await win();
  }
  async function send() {
    const lock = await spotify('lease', { purpose: 'sync' });
    const job = await spotify('claim', lock);
    return { lease: lock.lease, jobId: job.id };
  }
  it('cache les secrets et interdit les commandes serveur aux téléphones', async () => {
    await connected();
    const s = await state(bob);
    expect(s.spotify.connected).toBe(true);
    expect(JSON.stringify(s)).not.toContain('encrypted-test');
    await db.exec('set role authenticated');
    try { await expect(db.query("select public.spotify_service('connect','{}')")).rejects.toThrow(/permission/); }
    finally { await db.exec('reset role'); }
    await expect(spotify('connect', {accountId: 'other', credentials: 'secret'}, bob)).rejects.toThrow(/responsable/);
    await expect(spotify('access', {}, outsider)).rejects.toThrow(/refusé/);
  });
  it('débite une fois, interdit le traitement manuel et rembourse une fois', async () => {
    await connected();
    const id = randomUUID();
    const result = await cmd(alice, 'spotify_song', {trackId: track.id}, id);
    expect(await cmd(alice, 'spotify_song', {trackId: track.id}, id)).toEqual(result);
    expect((await state()).me.adds).toBe(0);
    await expect(cmd(alice, 'queue', {requestId: result.requestId})).rejects.toThrow(/automatiquement/);
    await expect(cmd(alice, 'song', {text: 'Autre'})).rejects.toThrow(/Spotify/);
    const job = await send();
    await spotify('finish', {...job, outcome: 'failed', issue: 'Appareil absent'});
    await spotify('finish', {...job, outcome: 'failed'});
    await spotify('finish', {...job, outcome: 'ok'});
    const s = await state();
    expect(s.me.adds).toBe(1);
    expect(s.requests[0].status).toBe('rejected');
    expect(await query("select * from jam.ledger where operation='refund'")).toHaveLength(1);
  });
  it('ne rejoue pas un envoi incertain et réserve la résolution au responsable', async () => {
    await connected();
    await cmd(alice, 'spotify_song', {trackId: track.id});
    const job = await send();
    await spotify('finish', {...job, outcome: 'uncertain'});
    expect(await spotify('claim', {lease: job.lease})).toBeNull();
    await expect(spotify('resolve', {...job, performed: false}, bob)).rejects.toThrow(/responsable/);
    await expect(cmd(alice, 'settings', {musicId: bId, bonus: 0, sacrifice: ''})).rejects.toThrow(/envois/);
    await spotify('resolve', {...job, performed: true});
    await expect(spotify('resolve', {...job, performed: false})).rejects.toThrow(/vérifier/);
    expect((await state()).requests[0].status).toBe('queued');
    expect((await state()).me.adds).toBe(0);
  });
  it('un crash expire en état incertain et deux exécuteurs ne prennent pas le même envoi', async () => {
    await connected();
    await cmd(alice, 'spotify_song', {trackId: track.id});
    const job = await send();
    expect(await spotify('lease', {purpose: 'sync'})).toEqual({busy: true});
    await db.exec("update jam.spotify_connections set lease_until=now()-interval '1 second'");
    const next = await spotify('lease', {purpose: 'sync'});
    await expect(spotify('finish', {...job, outcome: 'ok'})).rejects.toThrow(/expirée/);
    expect(await spotify('claim', {lease: next.lease})).toBeNull();
    expect((await state()).spotify.jobs[0].status).toBe('uncertain');
  });
  it('garde un seul skip réservé et le consomme uniquement après succès', async () => {
    await connected();
    await db.exec('update jam.players set skip=true');
    const lock = await spotify('lease', {purpose: 'sync'});
    await spotify('snapshot', {...lock, snapshot: {current: track, playing: true, progressMs: 5000, queue: []}});
    await spotify('release', lock);
    await cmd(alice, 'spotify_skip');
    await expect(cmd(bob, 'spotify_skip')).rejects.toThrow(/déjà/);
    expect((await state()).me.skip).toBe(true);
    const job = await send();
    await spotify('finish', {...job, outcome: 'ok'});
    await spotify('finish', {...job, outcome: 'failed'});
    expect((await state()).me.skip).toBe(false);
    expect((await state(bob)).me.skip).toBe(true);
  });
  it('ne marque jouée qu’une lecture observée après la demande', async () => {
    await connected();
    await cmd(alice, 'spotify_song', {trackId: track.id});
    const job = await send();
    await spotify('finish', {...job, outcome: 'ok'});
    await spotify('snapshot', {...job, snapshot: {current: track, playing: true, progressMs: 180000, queue: []}});
    expect((await state()).requests[0].played_at).toBeNull();
    await db.exec("update jam.requests set resolved_at=now()-interval '2 minutes'");
    await spotify('snapshot', {...job, snapshot: {current: track, playing: true, progressMs: 30000, queue: []}});
    expect((await state()).requests[0].played_at).not.toBeNull();
  });
  it('lie le retour OAuth au responsable et refuse sa réutilisation', async () => {
    await spotify('oauth_start', {state: 'random-state', verifier: 'encrypted-verifier'});
    await expect(spotify('oauth_take', {state: 'random-state'}, bob)).rejects.toThrow(/expirée/);
    expect(await spotify('oauth_take', {state: 'random-state'})).toEqual({verifier: 'encrypted-verifier'});
    await expect(spotify('oauth_take', {state: 'random-state'})).rejects.toThrow(/expirée/);
  });
  it('préserve les anciennes demandes manuelles et respecte Retry-After', async () => {
    await win();
    await cmd(alice, 'song', {text: 'Titre manuel'});
    await expect(spotify('connect', {accountId: 'test', credentials: 'secret'})).rejects.toThrow(/manuelles/);
    const s = await state();
    await cmd(alice, 'queue', {requestId: s.requests[0].id});
    await spotify('connect', {accountId: 'test', credentials: 'secret'});
    const lock = await spotify('lease', {purpose: 'sync'});
    await spotify('release', {...lock, retrySeconds: 60, issue: 'Quota'});
    expect(await spotify('lease', {purpose: 'sync'})).toEqual({busy: true});
  });
});

describe('Gestion privée du propriétaire', () => {
  async function ownerRpc(user: string, sql: string, values: unknown[] = []) {
    await as(user); await db.exec('set role authenticated');
    try { return (await db.query<any>(sql,values)).rows[0]?.result; }
    finally { await db.exec('reset role'); }
  }
  beforeEach(async () => {await db.exec('truncate jam.site_owner');});
  it('interdit la liste et les suppressions aux joueurs, même administrateurs de soirée', async () => {
    for (const user of [alice,bob,outsider]) {
      await expect(ownerRpc(user,'select public.owner_rooms() result')).rejects.toThrow(/propriétaire/);
      await expect(ownerRpc(user,'select public.owner_delete_room($1,$2) result',[room,code])).rejects.toThrow(/propriétaire/);
    }
    await db.exec('set role authenticated');
    try {await expect(db.query('insert into jam.site_owner(user_id) values($1)',[alice])).rejects.toThrow(/permission/);}
    finally {await db.exec('reset role');}
    expect((await state()).players).toHaveLength(3);
  });
  it('liste toutes les soirées sans exposer les codes personnels ni les identifiants Spotify', async () => {
    const second = await cmd(bob,'create',{name:'Bob',roomName:'Autre soirée',recoveryHash:hash('autre')});
    await db.query('insert into jam.site_owner(user_id) values($1)',[outsider]);
    const list = await ownerRpc(outsider,'select public.owner_rooms() result');
    expect(list.map((r:any)=>r.id).sort()).toEqual([room,second.roomId].sort());
    expect(list.find((r:any)=>r.id===room).players).toBe(3);
    expect(JSON.stringify(list)).not.toContain(hash('alice'));
    expect(Object.keys(list[0]).sort()).toEqual(['id','name','code','created_at','last_activity_at','players','spotify'].sort());
  });
  it('confirme exactement, supprime avec les dépendances et résiste aux répétitions', async () => {
    await db.query('insert into jam.site_owner(user_id) values($1)',[outsider]);
    await spotify('connect',{accountId:'owner-delete-test',credentials:'secret'});
    await win(); await cmd(alice,'spotify_skip').catch(()=>{});
    await expect(ownerRpc(outsider,'select public.owner_delete_room($1,$2) result',[room,'ERREUR'])).rejects.toThrow(/code exact/);
    expect((await state()).players).toHaveLength(3);
    expect(await ownerRpc(outsider,'select public.owner_delete_room($1,$2) result',[room,code])).toEqual({deleted:true});
    expect(await ownerRpc(outsider,'select public.owner_delete_room($1,$2) result',[room,code])).toEqual({deleted:true});
    for (const table of ['rooms','players','assignments','attempts','requests','ledger','spotify_connections']) {
      expect(await query('select * from jam.'+table)).toHaveLength(0);
    }
    expect(await ownerRpc(outsider,'select public.owner_rooms() result')).toEqual([]);
    await db.exec('truncate jam.site_owner');
    await expect(ownerRpc(outsider,'select public.owner_rooms() result')).rejects.toThrow(/propriétaire/);
  });
});

describe('Gestion des joueurs par le propriétaire',()=>{
  async function op(user:string,playerId:string,operation:string,options:Record<string,string>,id=randomUUID()) {
    await as(user);await db.exec('set role authenticated');
    try {return (await db.query<any>('select public.owner_player_action($1,$2,$3,$4,$5::jsonb) result',[id,room,playerId,operation,JSON.stringify(options)])).rows[0].result;}
    finally {await db.exec('reset role');}
  }
  beforeEach(async()=>{await db.exec('truncate jam.site_owner');await db.query('insert into jam.site_owner(user_id) values($1)',[outsider]);});
  it('interdit aux administrateurs de soirée de lire ou modifier les joueurs globalement',async()=>{
    await expect(op(alice,bId,'delete',{name:'Bob'})).rejects.toThrow(/propriétaire/);
    await expect(op(bob,aId,'recovery',{hash:hash('new')})).rejects.toThrow(/propriétaire/);
    await as(alice);await db.exec('set role authenticated');
    try {await expect(db.query('select public.owner_players($1)',[room])).rejects.toThrow(/propriétaire/);}
    finally {await db.exec('reset role');}
  });
  it('renouvelle le code une seule fois, sans stocker ni exposer le secret',async()=>{
    const id=randomUUID(), secret='replacement';
    await op(outsider,bId,'recovery',{hash:hash(secret)},id);
    await op(outsider,bId,'recovery',{hash:hash(secret)},id);
    await expect(cmd(carol,'recover',{code,recoveryHash:hash('bob'),newRecoveryHash:hash('next')})).rejects.toThrow(/incorrect/);
    const fresh=randomUUID();
    const recovered=await cmd(fresh,'recover',{code,recoveryHash:hash(secret),newRecoveryHash:hash('next')});
    expect(recovered.playerId).toBe(bId);
    // Replaying the original rotation must not resurrect that now-consumed code.
    await op(outsider,bId,'recovery',{hash:hash(secret)},id);
    expect((await query('select recovery_hash from jam.players where id=$1',[bId]))[0].recovery_hash).toBe(hash('next'));
    await as(outsider);const [{result}]=await query('select public.owner_players($1) result',[room]);
    expect(result).toHaveLength(3);expect(JSON.stringify(result)).not.toContain(hash('next'));
  });
  it('supprime un joueur avec confirmation et permet de transférer l’administration',async()=>{
    await expect(op(outsider,bId,'delete',{name:'Erreur'})).rejects.toThrow(/pseudo/);
    const id=randomUUID();await op(outsider,bId,'delete',{name:'Bob'},id);await op(outsider,bId,'delete',{name:'Bob'},id);
    expect((await state()).players).toHaveLength(2);
    await expect(op(outsider,aId,'delete',{name:'Alice'})).rejects.toThrow(/administrateur/);
    await op(outsider,aId,'delete',{name:'Alice',successor:cId});
    const s=await state(carol);expect(s.room.admin_id).toBe(cId);expect(s.room.music_id).toBe(cId);expect(s.players).toHaveLength(1);
    await expect(op(outsider,cId,'delete',{name:'Carole',successor:cId})).rejects.toThrow(/administrateur/);
  });
});
