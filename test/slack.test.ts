import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sendSlack,slackWebhookUrl} from '../src/slack.ts';
import type {Post,ResetAnalysis} from '../src/types.ts';
const webhook='https://hooks.slack.com/services/T123/B123/secret';
const post:Post={id:'2110618732666257557',text:'Reset complete <!channel> & <@U123>.',url:'https://evil.example',publishedAt:'2026-10-15T06:28:13Z'};
const analysis:ResetAnalysis={classification:'completed',summary:'Reset completed',precision:'exact',startsAt:'2026-10-15T06:00:00Z',endsAt:null,timeZone:'Pacific/Auckland',sourceTimeText:'Reset complete',assumptions:[],model:'gpt-6-luna'};

test('Slack alerts preserve post text without mentions and use local timing and canonical links',async()=>{
 await sendSlack(webhook,'thsottiaux',post,async(url,init)=>{
  assert.equal(String(url),webhook);
  assert.equal(init?.redirect,'manual');
  const b=JSON.parse(String(init?.body));
  assert.equal(b.text,'ChatGPT / Codex reset completed');
  assert.equal(b.blocks[1].text.type,'plain_text');
  assert.equal(b.blocks[1].text.text,post.text);
  assert.ok(JSON.stringify(b.blocks).includes('Pacific/Auckland'));
  assert.ok(!JSON.stringify(b).includes('<t:'));
  assert.ok(!JSON.stringify(b).includes('evil.example'));
  assert.equal(b.unfurl_links,false);
  return new Response('ok');
 },analysis,'Pacific/Auckland');
});

test('Slack accepts only recognized HTTPS webhook hosts and service paths',()=>{
 assert.equal(slackWebhookUrl(webhook).hostname,'hooks.slack.com');
 assert.equal(slackWebhookUrl(webhook.replace('slack.com','slack-gov.com')).hostname,'hooks.slack-gov.com');
 for(const url of ['http://hooks.slack.com/services/T/B/secret','https://evil.example/services/T/B/secret',webhook+'?secret=foo','https://hooks.slack.com/api/test','https://user:pass@hooks.slack.com/services/T/B/secret']) assert.throws(()=>slackWebhookUrl(url));
});

test('Slack requires its plain text confirmation and sanitizes failures',async()=>{
 await assert.rejects(sendSlack(webhook,'thsottiaux',post,async()=>new Response('invalid_payload')),/slack_missing_confirmation/);
 await assert.rejects(sendSlack(webhook,'thsottiaux',post,async()=>new Response(null,{status:429,headers:{'Retry-After':'60'}})),e=>!!e&&typeof e==='object'&&'retryAfterMs' in e&&e.retryAfterMs===60000);
 await assert.rejects(sendSlack(webhook,'thsottiaux',post,async()=>{throw Error(webhook);}),/slack_network_error/);
});

test('Slack connectivity and completed-reset demos are clearly labelled',async()=>{
 for(const demo of [false,true]) await sendSlack(webhook,'thsottiaux',null,async(_url,init)=>{
  const b=JSON.parse(String(init?.body));
  assert.match(b.text,demo?/DEMO.*reset completed/:/webhook test/);
  assert.match(b.blocks[1].text.text,demo?/No real reset/:/test message/);
  return new Response('ok');
 },undefined,undefined,demo);
});

test('admin Slack demo uses the runtime webhook and requires authorization',async()=>{
 const {default:worker}=await import('../src/index.ts');
 const env={ADMIN_TOKEN:'admin',X_USERNAME:'thsottiaux',SLACK_WEBHOOK_URL:webhook} as import('../src/types.ts').Env;
 const request=new Request('https://worker.example/test-webhook?target=slack&demo=completed',{method:'POST',headers:{Authorization:'Bearer admin'}});
 const original=globalThis.fetch;
 let sends=0;
 try {
  globalThis.fetch=async(url,init)=>{sends++;assert.equal(String(url),webhook);assert.match(JSON.parse(String(init?.body)).text,/DEMO/);return new Response('ok');};
  assert.equal((await worker.fetch(new Request(request.url,{method:'POST'}),env)).status,401);
  assert.equal(sends,0);
  const response=await worker.fetch(request,env);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{sent:true,target:'slack'});
  assert.equal(sends,1);
 } finally {globalThis.fetch=original;}
});
