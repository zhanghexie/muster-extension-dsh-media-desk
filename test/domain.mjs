import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(repo, 'dsh-media-desk');
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'extension.json'), 'utf8'));
assert.equal(manifest.agent, undefined);
assert.deepEqual(new Set(manifest.permissions), new Set(['data', 'files', 'media', 'exports', 'models', 'theme']));

const { createDomainRuntime } = await import(pathToFileURL(path.join(packageRoot, 'domain.mjs')));
const identity = { extensionId: 'dsh-media-desk', extensionInstanceId: 'test', workspaceId: 'workspace' };
const files = new Map();
const broker = async (method, args) => {
  if(method==='data.read') return files.has(args[0])?{content:files.get(args[0])}:null;
  if(method==='data.write') { files.set(args[0],args[1]);return {ok:true} }
  if(method==='models.list') return [];
  throw new Error(`unexpected broker call: ${method}`);
};
const runtime = createDomainRuntime({ identity, broker });
const initial = await runtime.query('desk.read',{path:'state'});
assert.ok(initial.state.items.length>10,'upstream inspiration wall has the original sample content');
const before=initial.state.items.length;
const add=await runtime.execute('desk.write',{path:'ops',body:{ops:[{op:'add_item',kind:'note',title:'测试灵感',body:'回归'}]}});
assert.equal(add.ok,true);
assert.equal(add.result.state.items.length,before+1);
const id=add.result.receipts[0].target;
await runtime.execute('desk.write',{path:'produce',body:{id}});
let state;
for(let i=0;i<40;i++) { state=await runtime.query('desk.read',{path:'state'});if(state.state.items.find(row=>row.id===id).production?.status!=='running')break;await new Promise(resolve=>setTimeout(resolve,10)); }
const produced=state.state.items.find(row=>row.id===id).production;
assert.equal(produced.status,'done');assert.ok(produced.article);assert.equal(produced.shots.length,6);assert.equal(produced.engine,'local');
await runtime.close();
const restarted = createDomainRuntime({ identity, broker });
assert.equal((await restarted.query('desk.read',{path:'state'})).state.items.length,before+1);
await restarted.close();
const withModels = createDomainRuntime({ identity, broker: (method, args) => method === 'models.list' ? Promise.resolve([
  {providerId:'one',modelId:'first',modalities:['text']},
  {providerId:'two',modelId:'selected',modalities:['text'],isDefault:true}
]) : broker(method,args) });
assert.deepEqual((await withModels.query('desk.read',{path:'models'})).default,{provider:'two',model:'selected'},'follow default must select the host active model, not the first provider');
await withModels.close();
let attempts = 0;
const failing = createDomainRuntime({ identity, broker: async (method, args) => {
  if (method === 'data.read') return null;
  if (method === 'data.write') { attempts++; throw new Error('disk unavailable'); }
  return broker(method,args);
} });
await assert.rejects(() => failing.getSnapshot(), /disk unavailable/);
await assert.rejects(() => failing.getSnapshot(), /disk unavailable/);
assert.equal(attempts,2,'failed initial persistence must retry and must not masquerade as a saved desk');
await failing.close();
const panel=fs.readFileSync(path.join(packageRoot,'client','index.jsx'),'utf8');
for(const component of ['HomeView','Studio','ScheduleView','InsightsView','StyleView','ChatDock']) assert.ok(panel.includes(component));
const host=fs.readFileSync(path.join(packageRoot,'client','host.js'),'utf8');
for(const contract of ['sdk().files.pick','sdk().media.import','sdk().exports.create'])assert.ok(host.includes(contract));
console.log('dsh-media-desk: manifest, discovery, persistence and host contracts ok');
