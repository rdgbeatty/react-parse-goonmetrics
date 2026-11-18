import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectLive } from "../lib/collector.mjs";
import { configuredHubs } from "../lib/hubs.mjs";
import { writeJson, publishSnapshot, readJson } from "../lib/storage.mjs";
import { compareHubs, validateSnapshot } from "../../../packages/shared/src/marketSnapshot.mjs";
import { historyTargets } from "../lib/history-refresh.mjs";
import { createFixture } from "../lib/fixture.mjs";
import { runJob } from "../lib/jobs.mjs";
const NOW = new Date('2026-11-16T15:00:00Z');
const config = { clientId:'client', contact:'test', cjId:'1000000000002', tortugaId:'1000000000001', typeLimit:0 };
const catalog = { types:{34:{name:'Tritanium',volumeM3:.01,packagedVolumeM3:.01},35:{name:'Pyerite',volumeM3:.01,packagedVolumeM3:.01}} };
async function temporary(t) { const path=await mkdtemp(join(tmpdir(),'market-hubs-test-'));t.after(()=>rm(path,{recursive:true,force:true}));await writeJson(join(path,'private','grant.json'),{refreshToken:'old',authentication:'pkce'});return path; }
function source({ denyInfo, denyBook, status=403 }={}) {
 const calls=[];
 const fetchImpl=async(url)=>{
  const u=new URL(url),path=u.pathname;calls.push(path);
  if(path===`/universe/structures/${denyInfo}`||path===`/markets/structures/${denyBook}`)return new Response(JSON.stringify({error:'Not available'}),{status});
  let body;
  if(path.startsWith('/universe/structures/'))body={solar_system_id:Number(path.at(-1))};
  else if(path.startsWith('/universe/systems/')) {const id=Number(path.at(-1));body={name:({1:'Siseide',2:'C-J6MT',3:'Other System'})[id],constellation_id:id*10};}
  else if(path.startsWith('/universe/constellations/'))body={region_id:({10:10000030,20:10000009,30:10000043})[Number(path.split('/').at(-1))]};
  else {
   const location=path.includes('structures')?Number(path.split('/').at(-1)):60003760;
   body=[{order_id:location,type_id:34,location_id:location,volume_remain:100,is_buy_order:false,price:location===60003760?100:200}];
   if(location===60003760)body.push({order_id:2,type_id:35,location_id:location,volume_remain:100,is_buy_order:false,price:50});
  }
  return new Response(JSON.stringify(body),{headers:{Expires:new Date(NOW.getTime()+3600000).toUTCString(),'Last-Modified':NOW.toUTCString()}});
 };return {fetchImpl,calls};
}
const sso={refresh:async(_config,_grant,persist)=>{await persist({refreshToken:'replacement',authentication:'pkce',character:{id:'123',name:'Collector'}});return {accessToken:'access',character:{id:'123',name:'Collector'}};}};

test('retired Siseide is disabled even when an old structure ID is saved',async(t)=>{
 const directory=await temporary(t),mock=source({denyInfo:config.tortugaId});
 const snapshot=await collectLive(config,directory,sso,{...mock,catalog,now:()=>NOW});
 assert.deepEqual(snapshot.hubs.map(h=>h.id),['jita','cj6mt']);
 assert.equal(mock.calls.some(path=>path.includes(config.tortugaId)),false);
 assert.deepEqual(snapshot.omittedHubs,[{id:'tortuga',name:'Tortuga · Siseide',reason:'disabled',status:null}]);
 assert.equal(compareHubs(snapshot,'jita','cj6mt')[0].destinationPrice,200);
 assert.equal(historyTargets(snapshot).length,4);
 assert.ok(historyTargets(snapshot).every(pair=>pair.regionId!=='10000030'));
 const blank=await collectLive({...config,tortugaId:''},directory,sso,{...mock,catalog,now:()=>NOW});
 assert.equal(blank.hubs.length,2);
});

for(const stage of ['info','book'])for(const status of [403,404])test(`optional hub ${stage} ${status} cannot poison Jita/C-J6MT collection`,async(t)=>{
 const directory=await temporary(t),mock=source({[stage==='info'?'denyInfo':'denyBook']:config.tortugaId,status});
 const snapshot=await collectLive({...config,tortugaEnabled:true},directory,sso,{...mock,catalog,now:()=>NOW});
 assert.deepEqual(snapshot.hubs.map(h=>h.id),['jita','cj6mt']);
 assert.equal(snapshot.omittedHubs[0].status,status);
 assert.ok(mock.calls.includes('/markets/10000002/orders'));
 assert.ok(mock.calls.includes(`/markets/structures/${config.cjId}`));
});

test('a required C-J6MT failure retains the previous public snapshot',async(t)=>{
 const directory=await temporary(t),snapshotPath=join(directory,'public','data','market.json');
 const previous=createFixture(1,NOW);await publishSnapshot(snapshotPath,previous);
 const mock=source({denyInfo:config.cjId});
 await assert.rejects(runJob('quotes',directory,config,sso,{consoleImpl:{log(){}},collector:(cfg,dir,auth,options)=>collectLive(cfg,dir,auth,{...options,...mock,catalog,now:()=>NOW})}),/403/);
 assert.deepEqual(await readJson(snapshotPath),previous);
});

test('future structure hubs are configured once and appear in comparisons automatically',async(t)=>{
 const directory=await temporary(t),mock=source();
 const cfg={...config,additionalHubs:[{id:'deployment',name:'Next deployment',structureId:'1000000000003',expectedSystem:'Other System'}]};
 const snapshot=await collectLive(cfg,directory,sso,{...mock,catalog,now:()=>NOW});
 assert.deepEqual(snapshot.hubs.map(h=>h.id),['jita','cj6mt','deployment']);
 assert.equal(compareHubs(snapshot,'jita','deployment')[0].destinationPrice,200);
 assert.equal(validateSnapshot(JSON.parse(JSON.stringify(snapshot))).hubs[2].name,'Next deployment');
 assert.throws(()=>configuredHubs({...cfg,additionalHubs:[{id:'jita',name:'Duplicate',structureId:'123'}]}),/duplicate/);
});

test('snapshot validation preserves legacy datasets and rejects duplicate or unsafe custom hubs',()=>{
 const snapshot=createFixture(1,NOW);assert.equal(validateSnapshot(snapshot).hubs.length,3);
 const current={...snapshot,hubs:snapshot.hubs.filter(h=>h.id!=='tortuga')};assert.equal(validateSnapshot(current).hubs.length,2);
 assert.throws(()=>validateSnapshot({...current,hubs:[current.hubs[0],current.hubs[0]]}),/hub identity/);
 assert.throws(()=>validateSnapshot({...current,omittedHubs:[{id:'jita',name:'Duplicate',reason:'disabled',status:null}]}),/omitted hub/);
 assert.throws(()=>validateSnapshot({...current,omittedHubs:[{id:'tortuga',name:'Gone',reason:'disabled',status:null,refreshToken:'not-public'}]}),/unexpected/);
});
