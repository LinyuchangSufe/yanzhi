// Production HTTP integration: only synthetic input, a fresh temporary data directory,
// real process restart and fresh-directory restore. No external service or AI call.
import assert from "node:assert/strict";
import {spawn,execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

const cwd=fileURLToPath(new URL("..",import.meta.url));
process.chdir(cwd);
const root=fs.mkdtempSync(path.join(os.tmpdir(),"research-kb-http-"));
const source=path.join(root,"source");
const port=process.env.KB_SMOKE_PORT||"3110";
const base=`http://127.0.0.1:${port}`;
const fixture=fs.readFileSync("tests/fixtures/reading-fixture.pdf");
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const steps=[];
// A downloaded source ZIP has no Git metadata; checks must still be runnable.
function gitValue(args) {
  try { return execFileSync("git",args,{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim(); }
  catch { return null; }
}
let child;
let logs="";
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function start(dataDir){
  logs="";
  child=spawn(process.execPath,["scripts/serve.mjs","start"],{cwd,detached:true,stdio:["ignore","pipe","pipe"],env:{...process.env,PORT:port,KB_DATA_DIR:dataDir,KB_AI_PROVIDER:"none",NEXT_TELEMETRY_DISABLED:"1"}});
  for(const stream of [child.stdout,child.stderr])stream.on("data",data=>{logs=(logs+data).slice(-12000);});
  for(let attempt=0;attempt<100;attempt++){
    if(child.exitCode!==null)throw new Error(`Server exited: ${logs}`);
    try{if((await fetch(`${base}/api/kb`,{signal:AbortSignal.timeout(1000)})).ok)return;}catch{}
    await pause(200);
  }
  throw new Error(`Server not ready: ${logs}`);
}
async function stop(){
  if(!child)return;
  const running=child;child=undefined;
  if(running.exitCode!==null)return;
  const exited=new Promise(resolve=>running.once("exit",resolve));
  process.kill(-running.pid,"SIGTERM");
  await Promise.race([exited,pause(5000)]);
  if(running.exitCode===null){try{process.kill(-running.pid,"SIGKILL");}catch{}await exited;}
}
async function json(route,options){
  const response=await fetch(base+route,options);
  const result=await response.json();
  assert.equal(response.status,200,JSON.stringify(result));return result;
}
const post=(action,payload)=>json("/api/kb",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,payload})});
const state=()=>json("/api/kb");
try{
  await start(source);
  assert.equal((await fetch(base)).status,200);
  assert.equal((await state()).papers.length,0);
  const first=await post("paper.create",{title:"HTTP TEST · 中文文献",sourceUrl:"https://example.org/test-only",doi:"10.1234/http-test",tags:["中文测试"]});
  const paper=first.result;
  const note=first.state.notes.find(n=>n.purpose==="paper");
  const initialBody="独特短语：青竹条件。我的公式 $x_t^2$，由我维护。";
  await post("note.update",{id:note.id,revision:note.revision,body:initialBody});
  const conflict=await fetch(base+"/api/kb",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"note.update",payload:{id:note.id,revision:note.revision,body:"must not overwrite"}})});
  assert.equal(conflict.status,409);
  const duplicate=await fetch(base+"/api/kb",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"paper.create",payload:{title:"duplicate",doi:"https://doi.org/10.1234/http-test"}})});
  assert.equal(duplicate.status,409);
  steps.push("metadata-only paper, persistent Chinese note, revision conflict and DOI duplicate");
  await stop();await start(source);
  assert.equal((await state()).notes.find(n=>n.id===note.id).body,initialBody);
  const upload=new FormData();upload.set("paperId",paper.id);upload.set("file",new Blob([fixture],{type:"application/pdf"}),"reading-fixture.pdf");
  const attachment=(await json("/api/kb/attachment",{method:"POST",body:upload})).result;
  assert.equal(sha(new Uint8Array(await (await fetch(base+`/api/kb/attachment?id=${attachment.id}`)).arrayBuffer())),sha(fixture));
  const annotation=(await post("annotation.create",{paperId:paper.id,attachmentId:attachment.id,kind:"region",pageIndex:2,pageLabel:"2",rects:[{x:0.1,y:0.6,width:0.5,height:0.2}],selectedText:"",comment:"HTTP TEST region comment, no fabricated OCR"})).result;
  const second=(await post("paper.create",{title:"HTTP TEST · second paper"})).result;
  const topic=(await post("topic.create",{title:"HTTP TEST · 研究问题",description:"跨论文比较"})).result;
  const topic2=(await post("topic.create",{title:"HTTP TEST · 第二问题"})).result;
  for(const toId of [topic.id,topic2.id])await post("link.set",{fromType:"paper",fromId:paper.id,toType:"topic",toId});
  await post("link.set",{fromType:"paper",fromId:second.id,toType:"topic",toId:topic.id});
  await post("note.create",{title:"HTTP TEST · independent idea",purpose:"idea",body:"独立想法共享正文",paperIds:[paper.id,second.id],topicIds:[topic.id]});
  const updated=(await state()).notes.find(n=>n.id===note.id);
  const body=initialBody+`\n\n[页内来源](kb://annotation/${annotation.id})\n\n[跨论文来源](kb://paper/${second.id})`;
  await post("note.update",{id:note.id,revision:updated.revision,body});
  await post("reading.set",{paperId:paper.id,attachmentId:attachment.id,pageIndex:2,scale:1.5,rotation:90});
  assert.ok((await json("/api/kb?q="+encodeURIComponent("青竹条件"))).searchResults.some(r=>r.id===note.id));
  const unavailable=await fetch(base+"/api/kb/ai",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({paperId:paper.id,kind:"summary"})});
  assert.equal(unavailable.status,422);
  assert.equal((await state()).notes.find(n=>n.id===note.id).body,body);
  const external=await fetch(base+"/api/kb",{method:"POST",headers:{Origin:"https://example.org","Content-Type":"application/json"},body:'{"action":"paper.create","payload":{"title":"reject"}}'});
  assert.equal(external.status,403);
  const invalid=await fetch(base+"/api/kb",{method:"POST",headers:{"Content-Type":"application/json"},body:"{invalid"});
  assert.equal(invalid.status,400);
  steps.push("real PDF upload/download, rotated physical-page region, links, topics, idea, reading position, search, AI-disabled and HTTP error boundaries");
  const exported=await (await fetch(base+`/api/kb/export?noteId=${note.id}`)).text();
  assert.match(exported,/青竹条件/);assert.match(exported,/物理页 3/);assert.match(exported,/显示页码 2/);
  const expected=await state();
  const archive=new Uint8Array(await (await fetch(base+"/api/kb/backup")).arrayBuffer());
  const restore=new FormData();restore.set("file",new Blob([archive]),"test.kb.json.gz");
  const restored=await json("/api/kb/backup",{method:"POST",body:restore});
  assert.notEqual(restored.restoredDirectory,source);
  await stop();await start(restored.restoredDirectory);
  assert.deepEqual(await state(),expected);
  assert.equal(sha(new Uint8Array(await (await fetch(base+`/api/kb/attachment?id=${attachment.id}`)).arrayBuffer())),sha(fixture));
  assert.ok((await json("/api/kb?q="+encodeURIComponent("青竹条件"))).searchResults.some(r=>r.id===note.id));
  assert.ok((await state()).relations.some(r=>r.fromId===note.id&&r.toId===annotation.id&&r.purpose==="reference"));
  steps.push("Markdown export, HTTP complete backup, fresh-directory restore, real process restart, identical stable IDs/content/relationships and PDF hash, restored search");
  const status=gitValue(["status","--porcelain"]);
  const report={timestamp:new Date().toISOString(),node:process.version,baseCommit:gitValue(["rev-parse","--verify","HEAD"]),workingTreeDirty:status===null?null:Boolean(status),fixtureSha256:sha(fixture),ai:"disabled; no real inference claimed",steps,counts:restored.counts,result:"passed"};
  fs.mkdirSync("test-results",{recursive:true});fs.writeFileSync("test-results/http-smoke.json",JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify(report,null,2));
}finally{await stop();fs.rmSync(root,{recursive:true,force:true});}
