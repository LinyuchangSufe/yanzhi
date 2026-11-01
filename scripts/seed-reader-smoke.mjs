// Isolated browser acceptance data. Never seed the default user library.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { PDFDocument } from "pdf-lib";

const base=process.env.KB_SMOKE_URL||"http://127.0.0.1:3107";
const url=new URL(base);
assert.ok(["127.0.0.1","localhost"].includes(url.hostname)&&url.port&&url.port!=="3000","Use an isolated loopback service, not the default user library");
async function read(route,options){const response=await fetch(base+route,options);const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;}
const post=(action,payload)=>read("/api/kb",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,payload})});
async function upload(paperId,name,bytes){const form=new FormData();form.set("paperId",paperId);form.set("file",new Blob([bytes],{type:"application/pdf"}),name);return (await read("/api/kb/attachment",{method:"POST",body:form})).result;}
assert.equal((await read("/api/kb")).papers.length,0,"Refuse to alter a nonempty library");
const fixture=await fs.readFile("tests/fixtures/reading-fixture.pdf");
const paper=(await post("paper.create",{title:"TEST READING · 连续阅读与批注定位",authors:["Synthetic test fixture"],year:2026})).result;
const first=await upload(paper.id,"reading-fixture.pdf",fixture);
const revised=await PDFDocument.load(fixture);revised.setSubject("Explicit synthetic attachment version 2, same page content");revised.setModificationDate(new Date("2026-10-28T01:00:00Z"));
const second=await upload(paper.id,"reading-fixture-version-2.pdf",await revised.save());
const highlight=(await post("annotation.create",{paperId:paper.id,attachmentId:first.id,kind:"highlight",pageIndex:0,pageLabel:"i",rects:[{x:48/600,y:605/800,width:370/600,height:14/800}],selectedText:"Select this exact sentence to create a persistent text highlight.",comment:"TEST READING · 第一物理页文字批注"})).result;
const region=(await post("annotation.create",{paperId:paper.id,attachmentId:first.id,kind:"region",pageIndex:2,pageLabel:"2",rects:[{x:70/600,y:350/800,width:460/600,height:120/800}],selectedText:"",comment:"TEST READING · 第三物理页旋转区域"})).result;
const snapshot=await read("/api/kb");const note=snapshot.notes.find(n=>snapshot.relations.some(r=>r.fromId===n.id&&r.toId===paper.id));
await post("note.update",{id:note.id,revision:note.revision,body:`# TEST READING · 我的阅读笔记\n\n中文独立正文与公式 $x_t^2$。收起面板、专注阅读后应保持。\n\n[封面文字出处](kb://annotation/${highlight.id})\n\n[旋转页区域](kb://annotation/${region.id})\n`});
await post("reading.set",{paperId:paper.id,attachmentId:first.id,pageIndex:2,scale:"page-width",rotation:0});
await post("reading.set",{paperId:paper.id,attachmentId:second.id,pageIndex:1,scale:"page-width",rotation:0});
let realPaper;
try{
 const bytes=await fs.readFile("tests/fixtures/lora-2106.09685v2.pdf");
 realPaper=(await post("paper.create",{title:"TEST READING · LoRA 长文滚动",sourceUrl:"https://arxiv.org/abs/2106.09685v2",arxivId:"2106.09685v2"})).result;
 await upload(realPaper.id,"lora-2106.09685v2.pdf",bytes);
}catch(error){if(error.code!=="ENOENT")throw error;}
const report={date:new Date().toISOString(),base,paperId:paper.id,firstAttachment:first.id,secondAttachment:second.id,noteId:note.id,highlightId:highlight.id,regionId:region.id,longPaperId:realPaper?.id,expectedInitial:{attachmentId:second.id,pageIndex:1},expectedOldSource:{attachmentId:first.id,pageIndex:2,pageLabel:"2"}};
await fs.mkdir("test-results",{recursive:true});await fs.writeFile("test-results/reader-smoke-seed.json",JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify(report,null,2));
