export interface AIErrorRecovery {
  kind: "configuration" | "connection" | "source" | "request";
  title: string;
  hint: string;
}

/** Route only explicit configuration failures to settings; keep other recovery in place. */
export function aiErrorRecovery(message: string): AIErrorRecovery {
  if (/请在设置中选择提供方|未配置|未启用|不启用 AI|未登录|未安装|API.?key|api.?密钥|认证|鉴权|unauthori[sz]ed|invalid.?api.?key|authentication|model.?not.?found|模型.{0,20}(?:不存在|不可用|无权限|无权|未设置)|(?:配置|模型).{0,12}(?:缺少|缺失|无效)|(?:401|403)\b/i.test(message)) {
    return { kind: "configuration", title: "需要检查 AI 配置", hint: "检查提供方、登录状态和模型权限，完成后可返回这里重试。" };
  }
  if (/超时|timeout|timed.out|网络|连接|fetch.failed|failed.to.fetch|ECONN|ENOTFOUND|rate.limit|429\b|服务繁忙|限流|额度/i.test(message)) {
    return { kind: "connection", title: "连接或服务暂不可用", hint: "请检查网络或服务状态，稍后在当前页面重试；这不一定需要修改 AI 配置。" };
  }
  if (/PDF.{0,20}(?:读取|解析|损坏|不存在|缺失)|附件.{0,20}(?:不存在|缺失|不可用)|材料|扫描页|未.{0,5}(?:提取|解析).{0,10}(?:文字|文本)|重新选择.{0,20}文字|超出.{0,10}(?:页数|字符|范围)/i.test(message)) {
    return { kind: "source", title: "请检查本次阅读材料", hint: "检查所选 PDF、可解析文字和材料范围，再在当前页面重试。" };
  }
  return { kind: "request", title: "本次请求未完成", hint: "原有内容保留，可在当前页面重试；错误详情显示在上方。" };
}
