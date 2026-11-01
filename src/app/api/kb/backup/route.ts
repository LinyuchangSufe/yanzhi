import path from "node:path";
import {getStore,StoreError} from "@/lib/db";
import {createBackup,restoreBackup} from "@/lib/archive";
import {assertLocalRequest,errorResponse} from "@/lib/security";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export function GET(request:Request){try{assertLocalRequest(request);const bytes=createBackup(getStore());return new Response(new Uint8Array(bytes),{headers:{"Content-Type":"application/gzip","Content-Disposition":`attachment; filename="research-${new Date().toISOString().slice(0,10)}.kb.json.gz"`,"Cache-Control":"no-store"}});}catch(error){return errorResponse(error);}}
export async function POST(request:Request){try{
  assertLocalRequest(request);
  if(!request.headers.get("content-type")?.includes("multipart/form-data"))throw new StoreError("请通过文件上传提交备份",415);
  const reader=request.body?.getReader();if(!reader)throw new StoreError("请求正文为空",400);
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>257*1024*1024){await reader.cancel();throw new StoreError("备份过大",413);}chunks.push(value);}
  const form=await new Request(request.url,{method:"POST",headers:request.headers,body:new Uint8Array(Buffer.concat(chunks))}).formData();const file=form.get("file");
  if(!(file instanceof File)||file.size>256*1024*1024)throw new StoreError("请选择不超过 256 MiB 的完整备份",400);
  return Response.json(restoreBackup(Buffer.from(await file.arrayBuffer()),path.dirname(getStore().dataDir)));
}catch(error){return errorResponse(error);}}
