import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import "./assets.mjs";
const require = createRequire(import.meta.url);
const mode = process.argv[2] === "start" ? "start" : "dev";
const extra = mode === "dev" ? ["--webpack"] : [];
const child = spawn(process.execPath,[require.resolve("next/dist/bin/next"),mode,...extra,"--hostname","127.0.0.1","--port",process.env.PORT || "3000"],{
  stdio:"inherit",env:{...process.env,NEXT_TELEMETRY_DISABLED:"1"}
});
for (const signal of ["SIGINT","SIGTERM"]) process.on(signal,()=>child.kill(signal));
child.on("exit",code=>{process.exitCode=code??1;});
