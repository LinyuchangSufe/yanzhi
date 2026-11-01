export function supportedNode(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 19);
}

export function requireSupportedNode() {
  if (!supportedNode()) throw new Error(`需要 Node.js >=22.19.0，当前为 ${process.versions.node}。请更新 Node.js 后重试。`);
}
