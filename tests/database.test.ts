import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";

let db: PGlite;
const alice = randomUUID(),
  bob = randomUUID(),
  carol = randomUUID(),
  outsider = randomUUID();
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
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
  await db.exec(
    readFileSync("supabase/migrations/202610040001_jam.sql", "utf8"),
  );
  await db.exec(
    readFileSync(
      "supabase/migrations/202610040002_push_permission.sql",
      "utf8",
    ),
  );
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
    await expect(state(outsider)).rejects.toThrow(/accès refusé/);
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
    await expect(state(alice)).rejects.toThrow(/accès refusé/);
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
    expect((await state()).me.skip).toBe(false);
    expect((await state()).me.adds).toBe(1);
    const [row] = await query(
      "select bonus_roll from jam.assignments where id=$1",
      [a.id],
    );
    expect(row.bonus_roll).toBeNull();
  });
  it("un sacrifice refusé laisse seulement l’abandon, qui impose deux minutes", async () => {
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
    await expect(cmd(alice, "draw")).rejects.toThrow(/deux minutes/);
    const s = await state();
    expect(
      Date.parse(s.me.cooldown_until) - Date.parse(s.serverTime),
    ).toBeGreaterThan(118000);
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
