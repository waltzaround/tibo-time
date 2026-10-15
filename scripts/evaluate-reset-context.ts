// Opt-in live model regression: reads .dev.vars through Node's --env-file flag.
// Never sends Discord messages or modifies production state.
import assert from 'node:assert/strict';
import { analyzePost } from '../src/analyze.ts';
import type { Env, Post, PostContext } from '../src/types.ts';
const env = {...process.env, X_USERNAME:'thsottiaux', OPENAI_MODEL:'gpt-6-luna'} as unknown as Env;
const root: Post = {id:'2110595484180214059',text:'The reports of my reset button being lost are greatly exaggerated\n\nDay 10/ Reset',publishedAt:'2026-10-15T04:55:51.053Z',url:'https://x.com/thsottiaux/status/2110595484180214059'};
const reply: Post = {id:'2110595554036400151',text:'Landing within the next 2 hours',publishedAt:'2026-10-15T04:56:07.708Z',url:'https://x.com/thsottiaux/status/2110595554036400151'};
const completed: Post = {id:'2110618732666257557',text:'Done and dusted',publishedAt:'2026-10-15T06:28:13.924Z',url:'https://x.com/thsottiaux/status/2110618732666257557'};
function context(post: Post, child: Post, relation: PostContext['relation']): PostContext {return {id:post.id,text:post.text,publishedAt:post.publishedAt,author:'thsottiaux',relation,referencedBy:child.id};}
reply.context=[context(root,reply,'replied_to')];
completed.context=[context(reply,completed,'quoted'),...reply.context];
const cases: {name:string;post:Post;expected:string[]}[] = [
 {name:'informal reset announcement',post:root,expected:['announced']},
 {name:'linked timing reply',post:reply,expected:['announced']},
 {name:'nested completion',post:completed,expected:['completed']},
 {name:'completion without context',post:{...completed,context:[]},expected:['unclear','not_reset']},
 {name:'unrelated linked feature',post:{...completed,context:[{...context(root,completed,'quoted'),text:'The new dark mode is landing today.'}]},expected:['not_reset','unclear']},
 {name:'explicit denial',post:{...reply,text:'No usage reset is planned.'},expected:['announced']},
 {name:'password reset',post:{...root,text:'Password reset is done.'},expected:['announced','completed']},
];
let failures=0;
for(const item of cases) {
 try {
 const result=await analyzePost(env,item.post,fetch);
 assert.ok(item.expected.includes(result.classification));
 if(item.name==='linked timing reply') {assert.equal(result.precision,'window');assert.ok(Math.abs(Date.parse(result.startsAt!)-Date.parse(reply.publishedAt))<1000);assert.ok(Math.abs(Date.parse(result.endsAt!)-Date.parse(reply.publishedAt)-7200000)<1000);}
 if(item.name==='nested completion') assert.equal(result.precision,'unknown');
 console.log(JSON.stringify({case:item.name,pass:true,classification:result.classification,precision:result.precision}));
 }catch {failures++;console.log(JSON.stringify({case:item.name,pass:false}));}
}
process.exitCode=failures?1:0;
