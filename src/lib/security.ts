import { ZodError } from "zod";

export function assertLocalRequest(request: Request) {
  const url = new URL(request.url);
  const host = request.headers.get("host") ?? url.host;
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) {
    throw Object.assign(new Error("仅允许本机访问"), {status:403});
  }
  const origin = request.headers.get("origin");
  if ((origin && origin !== `${url.protocol}//${host}`) || request.headers.get("sec-fetch-site") === "cross-site") {
    throw Object.assign(new Error("拒绝跨站请求"), {status:403});
  }
}

export function errorResponse(error: unknown) {
  if (error instanceof ZodError) return Response.json({error:"输入格式不正确",details:error.issues}, {status:400});
  const value = error as {status?:number;message?:string;details?:unknown};
  const status = value?.status && value.status >= 400 && value.status <= 599 ? value.status : 500;
  return Response.json({error:status===500 ? "本地操作失败，请检查数据目录权限和剩余空间。输入尚未保存。" : value?.message || "操作失败，请重试",...(value?.details ? {details:value.details}: {})}, {status});
}

export async function readJson(request: Request, limit = 4 * 1024 * 1024): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > limit) throw Object.assign(new Error("请求过大"),{status:413});
  const reader=request.body?.getReader(); if(!reader) throw Object.assign(new Error("正文为空"),{status:400});
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw Object.assign(new Error("请求过大"),{status:413});}chunks.push(value);}
  const body=Buffer.concat(chunks).toString("utf8");
  try {return JSON.parse(body) as unknown;} catch {throw Object.assign(new Error("JSON 格式无效"),{status:400});}
}
