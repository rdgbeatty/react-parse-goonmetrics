// Local-only integration harness: synthetic credentials, no GitHub writes.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createRequire } from 'node:module';
import { ROOT } from '../apps/market-backend/lib/paths.mjs';
import '../apps/market-backend/lib/github-node.mjs';
const sodium = createRequire(import.meta.url)('libsodium-wrappers'); await sodium.ready;
const keys = sodium.crypto_box_keypair();
const config = JSON.parse(await readFile(join(ROOT,'config/market.json')));
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const parts = [{ alg: 'RS256', kid: 'qa' }, { iss: 'https://login.eveonline.com', aud: [config.clientId,'EVE Online'], sub: `CHARACTER:EVE:${config.collectorCharacterId}`, name: 'Synthetic QA collector', exp: Math.floor(Date.now()/1000)+1200, scp: ['esi-markets.structure_markets.v1','esi-universe.read_structures.v1'] }].map((v)=>Buffer.from(JSON.stringify(v)).toString('base64url'));
const jwt = [...parts,sign('RSA-SHA256',Buffer.from(parts.join('.')),privateKey).toString('base64url')].join('.');
const base = '/react-parse-goonmetrics/', port = Number(process.env.QA_PORT ?? 4176);
const bootstrap = `(() => {
 const originalFetch = window.fetch.bind(window);
 window.__calls = [];
 sessionStorage.clear(); localStorage.clear();
 sessionStorage.setItem('market-github-only-pkce-v1', JSON.stringify({clientId:${JSON.stringify(config.clientId)},redirectUri:location.origin+location.pathname,verifier:'a'.repeat(43),state:'qa-state',createdAt:Date.now()}));
 window.fetch = async (url, options={}) => {
  const text = String(url);window.__calls.push({url:text,method:options.method??'GET',body:options.body});
  const json = value => new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
  if(text.endsWith('oauth-authorization-server')) return json({issuer:'https://login.eveonline.com',authorization_endpoint:'https://login.eveonline.com/v2/oauth/authorize',token_endpoint:'https://login.eveonline.com/v2/oauth/token',jwks_uri:'https://login.eveonline.com/oauth/jwks',code_challenge_methods_supported:['S256']});
  if(text.endsWith('/oauth/jwks')) return json({keys:[${JSON.stringify({...publicKey.export({format:'jwk'}),kid:'qa',alg:'RS256'})}]});
  if(text.endsWith('/v2/oauth/token')) return json({access_token:${JSON.stringify(jwt)},refresh_token:'synthetic-qa-refresh-never-real'});
  if(text === 'https://api.github.com/user') return json({login:${JSON.stringify(config.repository.split('/')[0])}});
  if(text === 'https://api.github.com/repos/${config.repository}') return json({default_branch:'main',permissions:{push:true}});
  if(text.endsWith('/public-key')) return json({key:${JSON.stringify(sodium.to_base64(keys.publicKey,sodium.base64_variants.ORIGINAL))},key_id:'qa-key'});
  if(text.includes('api.github.com')) {
   if(options.method === 'PUT') { const result=await originalFetch('/qa-seal',{method:'POST',headers:{'Content-Type':'application/json'},body:options.body});if(!result.ok)throw new Error('Invalid sealed box');window.__sealValid=true;return new Response(null,{status:201}); }
   if(options.method === 'POST') return new Response(null,{status:204});
   throw new Error('Unexpected mock GitHub request');
  }
  return originalFetch(url, options);
 };
})();`;
const qa = `<!doctype html><meta charset='utf-8'><title>Release browser QA</title><body><pre id='result'>Running…</pre><iframe id='legacy' style='width:1100px;height:800px'></iframe><iframe id='cold' style='width:1100px;height:800px'></iframe><iframe id='market' style='width:1100px;height:800px'></iframe><iframe id='owner' style='width:1100px;height:800px'></iframe><script>
const results=[];const check=(ok,name)=>{if(!ok)throw new Error(name);results.push(name)};
const tick=()=>fetch('/qa-tick');
async function until(fn,label){for(let i=0;i<2000;i++){if(fn())return;await tick()}throw new Error('Timed out: '+label)}
async function frame(id,url){const el=document.getElementById(id);el.src=url;await until(()=>el.contentDocument?.readyState==='complete'&&el.contentWindow.location.pathname===new URL(url,location.href).pathname,'load '+id);return el}
(async()=>{
const old=await frame('legacy','${base}#/imports');
await until(()=>old.contentDocument.querySelector('tbody tr'),'live legacy imports');
check([...old.contentDocument.querySelectorAll('a')].some(a=>a.textContent.trim()==='EVE Markets'&&a.pathname==='${base}market/'),'legacy link targets new site');
const oldColor=old.contentWindow.getComputedStyle(old.contentDocument.body).backgroundColor;
old.contentWindow.location.hash='/exports';await until(()=>old.contentDocument.querySelector('h1')?.textContent==='Exports'&&old.contentDocument.querySelector('tbody tr'),'legacy exports');check(true,'legacy live top500 imports and exports');
const all=[...old.contentDocument.querySelectorAll('button')].find(b=>b.textContent.trim()==='All Items');all.click();await tick();await until(()=>!old.contentDocument.body.textContent.includes('Loading')&&old.contentDocument.querySelector('tbody tr'),'legacy all items exports');check(true,'legacy live marketgroup exports');
old.contentWindow.location.hash='/imports';await until(()=>old.contentDocument.querySelector('h1')?.textContent==='Imports','imports route');await tick();const allImports=[...old.contentDocument.querySelectorAll('button')].find(b=>b.textContent.trim()==='All Items');allImports.click();await tick();await until(()=>allImports.classList.contains('active')&&!old.contentDocument.body.textContent.includes('Loading')&&old.contentDocument.querySelector('tbody tr'),'legacy all items imports');check(true,'legacy live marketgroup imports');
const cold=await frame('cold','${base}market/?qa-cold=1');await until(()=>cold.contentDocument.getElementById('browse-notice')?.textContent.includes('No published market snapshot'),'cold start message');check(!cold.contentDocument.getElementById('empty').hidden,'cold start visibly explains missing data');
const market=await frame('market','${base}market/');await until(()=>market.contentDocument.querySelector('#rows tr'),'modern rows');
check(market.contentDocument.getElementById('result-count').textContent.includes('19,258'),'full saved modern dataset');
check(market.contentDocument.getElementById('legacy-link').pathname==='${base}','modern link returns to original');
check(market.contentWindow.getComputedStyle(market.contentDocument.body).backgroundColor!==oldColor,'styles isolated');
const search=market.contentDocument.getElementById('search');search.value='Tritanium';search.dispatchEvent(new market.contentWindow.Event('input'));await until(()=>market.contentDocument.querySelector('#rows tr')?.textContent.includes('Tritanium'),'new search');check(true,'new viewer search');
market.contentDocument.getElementById('swap').click();check(market.contentDocument.getElementById('source').value==='cj6mt','new viewer route swap');
const owner=await frame('owner','${base}market/connect.html?code=synthetic-qa-code&state=qa-state&qa=1');await until(()=>owner.contentDocument.getElementById('character')?.textContent.includes('Synthetic QA collector'),'browser JWT validation');
owner.contentDocument.getElementById('token').value='synthetic-qa-owner-token';owner.contentDocument.getElementById('save').click();await until(()=>owner.contentDocument.getElementById('status').textContent.includes('Setup pending.'),'pending dispatch');
check(owner.contentWindow.__sealValid===true,'real browser LibSodium sealed box decrypts on Node');
const dispatch=owner.contentWindow.__calls.find(c=>c.url.includes('/dispatches'));const payload=JSON.parse(dispatch.body);check(payload.inputs.operation==='adopt'&&/^[a-f0-9]{64}$/.test(payload.inputs.nonce)&&!dispatch.body.includes('synthetic-qa-refresh'),'dispatch has no plaintext credential');
check(owner.contentDocument.getElementById('token').value===''&&owner.contentWindow.sessionStorage.length===0&&owner.contentWindow.localStorage.length===0,'credentials cleared and absent from browser storage');
check(!owner.contentDocument.body.textContent.includes('synthetic-qa-refresh'),'grant never rendered');
document.getElementById('result').textContent=JSON.stringify({passed:true,checks:results},null,2);document.documentElement.dataset.complete='true';
})().catch(e=>{document.getElementById('result').textContent=JSON.stringify({passed:false,error:e.message,legacyText:document.getElementById('legacy').contentDocument?.body?.textContent.slice(0,1400),checks:results},null,2);document.documentElement.dataset.complete='true'});
</script>`;
const server=createServer(async(req,res)=>{
 try{
 const url=new URL(req.url,'http://localhost');res.setHeader('Cache-Control','no-store');
 if(url.pathname==='/qa'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(qa);return}
 if(url.pathname==='/qa-tick'){await new Promise(r=>setTimeout(r,25));res.end('tick');return}
 if(url.pathname==='/qa-cold.js'){res.setHeader('Content-Type','text/javascript');res.end("const original=window.fetch.bind(window);window.fetch=(url,options)=>String(url).endsWith('data/market.json')?Promise.resolve(new Response(null,{status:404})):original(url,options);");return}
 if(url.pathname==='/qa-bootstrap.js'){res.setHeader('Content-Type','text/javascript');res.end(bootstrap);return}
 if(url.pathname==='/qa-seal'&&req.method==='POST'){
  let body='';for await(const chunk of req){body+=chunk;if(body.length>50000)throw new Error('large mock')}
  const value=JSON.parse(body),plain=JSON.parse(sodium.to_string(sodium.crypto_box_seal_open(sodium.from_base64(value.encrypted_value,sodium.base64_variants.ORIGINAL),keys.publicKey,keys.privateKey)));
  if(plain.grant.refreshToken!=='synthetic-qa-refresh-never-real'||plain.repository!==config.repository)throw new Error('bad mock');res.end('valid');return;
 }
 if(!url.pathname.startsWith(base)||url.pathname.includes('..')||url.pathname.includes('\\'))throw new Error('path');
 let relative=url.pathname.slice(base.length);if(relative.endsWith('/')||!relative)relative+='index.html';
 let content=await readFile(join(ROOT,'dist',relative));
 if(relative==='market/index.html'&&url.searchParams.get('qa-cold')==='1')content=Buffer.from(content.toString().replace('</head>','<script src="/qa-cold.js"></script></head>'));
 if(relative==='market/connect.html'&&url.searchParams.get('qa')==='1')content=Buffer.from(content.toString().replace('</head>','<script src="/qa-bootstrap.js"></script></head>'));
 res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json'})[extname(relative)]??'application/octet-stream');res.end(content);
 }catch{res.writeHead(404);res.end('QA request failed')}
});
server.listen(port,'127.0.0.1',()=>console.log(`QA harness: http://localhost:${port}/qa (synthetic credentials only)`));
const stop=()=>{server.close();server.closeAllConnections()};process.once('SIGINT',stop);process.once('SIGTERM',stop);
