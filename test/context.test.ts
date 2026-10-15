import assert from 'node:assert/strict';
import { test } from 'node:test';
import { officialContext } from '../src/sources.ts';
import type { Env } from '../src/types.ts';
const env = { X_USERNAME: 'thsottiaux', X_BEARER_TOKEN: 'test' } as Env;
const root = { id: '2110595484180214059', author_id: '42', text: 'Day 10/ Reset' };
const reply = { id: '2110595554036400151', author_id: '42', text: 'Landing within the next 2 hours', in_reply_to_user_id: '42', referenced_tweets: [{ id: root.id, type: 'replied_to' }] };
const quote = { id: '2110618732666257557', text: 'Done and dusted', referenced_tweets: [{ id: reply.id, type: 'quoted' }] };

test('quote context follows a nested self-reply and reuses expanded posts', async () => {
  const known = new Map([[reply.id, reply]]);
  let calls = 0;
  const context = await officialContext(quote, known, env, '42', async (url) => {
    calls++;
    assert.equal(new URL(url).pathname, '/2/tweets/' + root.id);
    return Response.json({ data: root });
  });
  assert.equal(calls, 1);
  assert.deepEqual(context.map(p => [p.id, p.referencedBy, p.relation]), [[reply.id, quote.id, 'quoted'], [root.id, reply.id, 'replied_to']]);
  await officialContext(quote, known, env, '42', async () => { throw Error('should be cached'); });
});

test('context excludes other authors, unrelated posts, and reference cycles', async () => {
  const known = new Map<string, any>([[root.id, root], [reply.id, { ...reply, author_id: 'other' }]]);
  assert.deepEqual(await officialContext(quote, known, env, '42', fetch), []);
  known.set(reply.id, { ...reply, referenced_tweets: [{ id: quote.id, type: 'quoted' }] });
  assert.equal((await officialContext(quote, known, env, '42', fetch)).length, 1);
});

test('unavailable context is omitted; transient failures remain retryable', async () => {
  assert.deepEqual(await officialContext(quote, new Map(), env, '42', async () => new Response(null, {status:404})), []);
  await assert.rejects(officialContext(quote, new Map(), env, '42', async () => new Response(null, {status:429})), /x_http_429/);
});

test('context traversal stops at three ancestors', async () => {
  const known = new Map<string, any>();
  for (let n=0;n<5;n++) known.set(String(2110595484180214059n+BigInt(n)), {id:String(2110595484180214059n+BigInt(n)), author_id:'42', text:'Reset', referenced_tweets:[{id:String(2110595484180214060n+BigInt(n)),type:'quoted'}]});
  const context = await officialContext(known.values().next().value, known, env, '42', async () => {throw Error('unexpected lookup');});
  assert.equal(context.length,3);
});
