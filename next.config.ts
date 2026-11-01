import type { NextConfig } from "next";
const contentPolicy = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";
const config: NextConfig = {
  outputFileTracingRoot: process.cwd(),
  serverExternalPackages: ["node:sqlite", "undici", "pdfjs-dist"],
  poweredByHeader: false,
  async headers() {
    return [{source:"/:path*",headers:[
      {key:"X-Content-Type-Options",value:"nosniff"},
      {key:"Referrer-Policy",value:"no-referrer"},
      {key:"X-Frame-Options",value:"DENY"},
      {key:"Cross-Origin-Opener-Policy",value:"same-origin"},
      {key:"Content-Security-Policy",value:`${contentPolicy}; frame-ancestors 'none'`}
    ]}, { source: "/note-window", headers: [
      {key:"X-Frame-Options",value:"SAMEORIGIN"},
      {key:"Content-Security-Policy",value:`${contentPolicy}; frame-ancestors 'self'`}
    ] }];
  }
};
export default config;
