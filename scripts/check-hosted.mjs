// Explicit opt-in smoke test: creates one labelled test room and one guest.
import { createClient } from '@supabase/supabase-js';
import { randomUUID, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
if (!process.argv.includes('--create-test-room')) throw new Error('Pass --create-test-room');
const url = process.env.VITE_SUPABASE_URL;
const client = createClient(url, process.env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const auth = await client.auth.signInAnonymously();
assert.ifError(auth.error);
const payload = { name: 'Recette serveur', roomName: 'Test technique automatisé', recoveryHash: randomBytes(32).toString('hex') };
const args = { action_id: randomUUID(), kind: 'create', payload };
const results = await Promise.all([client.rpc('game_command', args), client.rpc('game_command', args)]);
for (const result of results) { assert.ifError(result.error); assert.ok(result.data.roomId); }
assert.deepEqual(results[0].data, results[1].data);
const roomId = results[0].data.roomId;
const state = await client.rpc('game_state', { room_id: roomId });
assert.ifError(state.error);
assert.equal(state.data.me.adds, 0);
assert.equal(state.data.room.bonus, 0);
const push = await client.functions.invoke('push-dispatch', { body: { roomId } });
if (push.error) {
  console.error('Push function failed:', push.error.message);
  if (push.error.context) console.error(await push.error.context.text());
  process.exitCode = 1;
} else {
  assert.equal(typeof push.data.claimed, 'number');
  console.log('PASS: authenticated push dispatcher, no phone subscription needed.');
}
const denied = await fetch(url + '/functions/v1/push-dispatch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
assert.equal(denied.status, 401);
console.log('PASS: guest sign-in, concurrent identical action exactly once, initial balances, unauthenticated dispatcher denied.');
