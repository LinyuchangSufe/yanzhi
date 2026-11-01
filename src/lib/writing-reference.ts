export type WritingReferenceCategory = "markdown" | "latex";

export interface WritingReferenceEntry {
  id: string;
  category: WritingReferenceCategory;
  group: string;
  title: string;
  description: string;
  keywords: string[];
  code: string;
}

/** Copyable snippets for the same Markdown + KaTeX renderer used by notes. */
export const writingReferenceEntries: WritingReferenceEntry[] = [
  {
    id: "md-heading",
    category: "markdown",
    group: "文字与段落",
    title: "标题层级",
    description: "用 # 到 ###### 表示一到六级标题；井号后留一个空格。",
    keywords: ["heading", "title", "章节", "小标题", "井号"],
    code: "# 研究主题\n\n## 研究问题\n\n### 关键假设",
  },
  {
    id: "md-emphasis",
    category: "markdown",
    group: "文字与段落",
    title: "加粗与斜体",
    description: "两个星号强调重点，一个星号表示斜体，可组合使用。",
    keywords: ["bold", "italic", "强调", "粗体", "星号"],
    code: "**核心结论**、*术语解释*、***特别重要***。",
  },
  {
    id: "md-paragraph",
    category: "markdown",
    group: "文字与段落",
    title: "分段与空行",
    description: "段落之间空一行。段内普通回车通常仍属于同一段。",
    keywords: ["paragraph", "空白", "段落", "回车", "换行"],
    code: "第一段：这篇文章研究什么问题。\n\n第二段：我对方法的理解。",
  },
  {
    id: "md-line-break",
    category: "markdown",
    group: "文字与段落",
    title: "段内强制换行",
    description: "行尾加两个空格再回车，可在同一段内换行。复制示例会保留空格。",
    keywords: ["break", "newline", "回车", "两个空格", "折行"],
    code: "研究对象：随机梯度下降。  \n关注条件：数据存在时间依赖。",
  },
  {
    id: "md-unordered-list",
    category: "markdown",
    group: "列表与引用",
    title: "无序列表与子列表",
    description:
      "每项以 - 和空格开头，子项缩进两个空格。列表前后空一行更清楚。",
    keywords: ["list", "bullet", "项目符号", "嵌套", "层级"],
    code: "- 研究问题\n- 核心方法\n  - 方法的适用条件\n  - 需要进一步核对的细节",
  },
  {
    id: "md-ordered-list",
    category: "markdown",
    group: "列表与引用",
    title: "有序列表",
    description: "用数字、句点和空格记录阅读步骤或证明顺序。",
    keywords: ["ordered", "numbered", "编号", "步骤", "序号"],
    code: "1. 明确研究问题\n2. 检查假设\n3. 阅读主要结论\n4. 核对证明与证据",
  },
  {
    id: "md-task-list",
    category: "markdown",
    group: "列表与引用",
    title: "任务清单",
    description: "[ ] 表示待办，[x] 表示完成；在编辑模式中修改勾选状态。",
    keywords: ["todo", "checkbox", "checklist", "待办", "勾选", "任务"],
    code: "- [x] 阅读摘要\n- [ ] 核对定理的全部假设\n- [ ] 整理自己的问题",
  },
  {
    id: "md-quote",
    category: "markdown",
    group: "列表与引用",
    title: "引用原文",
    description: "行首加 > 显示引用块；页码与来源说明需自己填写并核对。",
    keywords: ["quote", "blockquote", "摘录", "证据", "引文", "引用"],
    code: "> 此处粘贴需要保留的原文。\n>\n> 来源：论文标题，第 3 页。\n\n我的理解：这里记录自己的解释。",
  },
  {
    id: "md-inline-code",
    category: "markdown",
    group: "代码与表格",
    title: "行内代码",
    description: "用一对反引号原样显示变量名、命令或格式符号。",
    keywords: ["code", "backtick", "反引号", "命令", "变量"],
    code: "设置参数 `learning_rate = 0.01`，并记录随机种子 `seed = 42`。",
  },
  {
    id: "md-code-block",
    category: "markdown",
    group: "代码与表格",
    title: "多行代码块",
    description:
      "用三反引号包围多行内容。代码块中不会解析 Markdown 或数学公式。",
    keywords: ["fence", "code", "python", "代码块", "原样", "反引号"],
    code: "```python\nfor step in range(3):\n    x = x - learning_rate * gradient(x)\n```",
  },
  {
    id: "md-table",
    category: "markdown",
    group: "代码与表格",
    title: "比较表格",
    description: "竖线分列，第二行用短横线分隔表头；冒号控制左、居中或右对齐。",
    keywords: ["table", "对齐", "表头", "比较", "竖线"],
    code: "| 对比项 | 方法 A | 方法 B |\n| :--- | :---: | ---: |\n| 假设 | 待核对 | 待核对 |\n| 局限 | 待记录 | 待记录 |",
  },
  {
    id: "md-link",
    category: "markdown",
    group: "链接与符号",
    title: "文字链接",
    description: "方括号写显示文字，圆括号写地址。示例仅指向当前本地应用。",
    keywords: ["link", "url", "href", "超链接", "地址", "网址"],
    code: "[打开本地知识库](/)",
  },
  {
    id: "md-image",
    category: "markdown",
    group: "链接与符号",
    title: "插入本地图片",
    description:
      "点击笔记的插图按钮，或粘贴、拖入图片，自动生成本地链接并在预览显示。下面演示语法，需换成已上传图片的地址。",
    keywords: ["image", "img", "图片", "插图", "alt", "隐私"],
    code: "![此处填写图片说明](#示意图)",
  },
  {
    id: "md-escape",
    category: "markdown",
    group: "链接与符号",
    title: "转义与原样符号",
    description: "用反斜杠避免星号、井号等被当作格式；复杂格式可放进行内代码。",
    keywords: ["escape", "literal", "反斜杠", "转义", "特殊字符", "星号"],
    code: "\\*这不是斜体\\*，\\# 这不是标题。需要原样显示时使用：`[方括号]`。",
  },
  {
    id: "md-rule",
    category: "markdown",
    group: "文字与段落",
    title: "分隔线",
    description: "在独立一行写三个短横线，前后空行，分隔不同主题。",
    keywords: ["rule", "divider", "horizontal", "横线", "分隔"],
    code: "## 已确认的结论\n\n这里记录证据。\n\n---\n\n## 待验证的想法\n\n这里记录问题。",
  },
  {
    id: "md-strikethrough",
    category: "markdown",
    group: "文字与段落",
    title: "删除线",
    description: "用两对波浪号标记已放弃的判断，同时保留修改痕迹。",
    keywords: ["strike", "strikethrough", "删除线", "修订", "波浪号"],
    code: "~~原先的猜测~~：检查假设后，需要重新表述。",
  },
  {
    id: "tex-inline",
    category: "latex",
    group: "公式基础",
    title: "行内数学公式",
    description:
      "笔记仍是 Markdown；在一对 $ 中嵌入 LaTeX 数学语法，与正文同行。",
    keywords: ["inline", "math", "定界符", "美元符", "行内", "公式"],
    code: String.raw`当 $x > 0$ 时，函数 $f(x)=x^2$ 严格递增。`,
  },
  {
    id: "tex-display",
    category: "latex",
    group: "公式基础",
    title: "独立成行公式",
    description:
      "用两行 $$ 包围公式，公式独占一行。无需 documentclass 或完整 .tex 文档。",
    keywords: ["display", "block", "equation", "定界符", "块级", "公式"],
    code: String.raw`$$
f(x)=\frac{1}{2}x^2
$$`,
  },
  {
    id: "tex-subscript",
    category: "latex",
    group: "公式基础",
    title: "上下标与括号分组",
    description: "_ 表示下标，^ 表示上标；多个字符必须放进花括号。",
    keywords: [
      "subscript",
      "superscript",
      "index",
      "幂",
      "平方",
      "下标",
      "上标",
    ],
    code: String.raw`$x_i$、$x_{t+1}$、$x^2$、$e^{-\lambda t}$、$\theta^{(k)}$`,
  },
  {
    id: "tex-fraction-root",
    category: "latex",
    group: "公式基础",
    title: "分数与根号",
    description: "frac 的两个花括号依次写分子和分母；sqrt 可加可选的根指数。",
    keywords: ["frac", "sqrt", "fraction", "分式", "根号", "平方根", "立方根"],
    code: String.raw`$$
\frac{a+b}{c+d},\qquad \sqrt{x^2+y^2},\qquad \sqrt[3]{x}
$$`,
  },
  {
    id: "tex-greek",
    category: "latex",
    group: "符号与关系",
    title: "常用希腊字母",
    description:
      "反斜杠加英文名称输入希腊字母；大写名称通常表示对应的大写字母。",
    keywords: [
      "greek",
      "alpha",
      "beta",
      "theta",
      "lambda",
      "sigma",
      "希腊",
      "字母",
    ],
    code: String.raw`$\alpha,\beta,\gamma,\delta,\epsilon,\varepsilon,\eta,\theta,\lambda,\mu,\sigma,\omega,\Gamma,\Delta,\Sigma,\Omega$`,
  },
  {
    id: "tex-relations",
    category: "latex",
    group: "符号与关系",
    title: "比较关系与运算",
    description: "输入不等号、近似、正比、乘法与点乘等常用符号。",
    keywords: [
      "leq",
      "geq",
      "neq",
      "approx",
      "times",
      "不等式",
      "约等于",
      "正比",
      "乘号",
    ],
    code: String.raw`$a\leq b$，$a\geq b$，$a\neq b$，$a\approx b$，$a\propto b$，$a\times b$，$a\cdot b$，$a\pm b$。`,
  },
  {
    id: "tex-set-logic",
    category: "latex",
    group: "符号与关系",
    title: "集合、数域与逻辑",
    description: "用 mathbb 表示常见数域，配合集合关系与逻辑量词。",
    keywords: [
      "set",
      "mathbb",
      "forall",
      "exists",
      "implies",
      "集合",
      "实数",
      "属于",
      "逻辑",
      "量词",
    ],
    code: String.raw`$$
x\in\mathbb{R}^d,\quad A\subseteq B,\quad A\cup B,\quad A\cap B,\quad \forall x\in A,\quad \exists y\in B,\quad P\implies Q
$$`,
  },
  {
    id: "tex-vector",
    category: "latex",
    group: "符号与关系",
    title: "向量、粗体与转置",
    description: "mathbf 加粗拉丁字母，boldsymbol 加粗希腊字母，top 表示转置。",
    keywords: [
      "vector",
      "mathbf",
      "boldsymbol",
      "transpose",
      "粗体",
      "向量",
      "转置",
      "矩阵",
    ],
    code: String.raw`$$
\mathbf{x}\in\mathbb{R}^d,\qquad \boldsymbol{\theta},\qquad \vec{v},\qquad \mathbf{x}^{\top}A\mathbf{x}
$$`,
  },
  {
    id: "tex-probability",
    category: "latex",
    group: "概率与分析",
    title: "概率、期望与方差",
    description:
      "用 mathbb 写概率与期望，operatorname 为自定义算子提供正常间距。",
    keywords: [
      "probability",
      "expectation",
      "variance",
      "conditional",
      "mathbb",
      "概率",
      "期望",
      "方差",
      "条件",
    ],
    code: String.raw`$$
\mathbb{P}(X\geq t),\qquad \mathbb{E}[X\mid Y],\qquad \operatorname{Var}(X)=\mathbb{E}[(X-\mathbb{E}[X])^2]
$$`,
  },
  {
    id: "tex-sum-product",
    category: "latex",
    group: "概率与分析",
    title: "求和与连乘",
    description: "用下标和上标指定求和或连乘范围；省略号用 ldots。",
    keywords: ["sum", "prod", "summation", "求和", "连乘", "序列", "省略号"],
    code: String.raw`$$
\sum_{i=1}^{n}x_i,\qquad \prod_{i=1}^{n}p_i,\qquad x_1,\ldots,x_n
$$`,
  },
  {
    id: "tex-integral",
    category: "latex",
    group: "概率与分析",
    title: "积分与重积分",
    description: "int 可加上下限，iint 表示二重积分；微分前用细空格改善阅读。",
    keywords: ["int", "iint", "integral", "积分", "微分", "上下限"],
    code: String.raw`$$
\int_a^b f(x)\,\mathrm{d}x,\qquad \iint_D f(x,y)\,\mathrm{d}x\,\mathrm{d}y
$$`,
  },
  {
    id: "tex-limit",
    category: "latex",
    group: "概率与分析",
    title: "极限与收敛",
    description: "lim 下标说明趋近条件；xrightarrow 可在箭头上标注收敛方式。",
    keywords: ["lim", "infty", "xrightarrow", "limit", "极限", "收敛", "无穷"],
    code: String.raw`$$
\lim_{n\to\infty}a_n=0,\qquad X_n\xrightarrow{\mathbb{P}}X,\qquad a_n\to 0
$$`,
  },
  {
    id: "tex-derivative",
    category: "latex",
    group: "概率与分析",
    title: "导数、偏导与梯度",
    description: "用分数表示导数与偏导，用 nabla 表示梯度或 Hessian。",
    keywords: [
      "derivative",
      "gradient",
      "partial",
      "nabla",
      "导数",
      "偏导",
      "梯度",
      "hessian",
    ],
    code: String.raw`$$
f'(x)=\frac{\mathrm{d}f}{\mathrm{d}x},\qquad \frac{\partial f}{\partial x_i},\qquad \nabla f(\mathbf{x}),\qquad \nabla^2 f(\mathbf{x})
$$`,
  },
  {
    id: "tex-norm",
    category: "latex",
    group: "线性代数与排版",
    title: "范数、绝对值与内积",
    description:
      "用 lVert/rVert 表示范数，lvert/rvert 表示绝对值，langle/rangle 表示内积。",
    keywords: [
      "norm",
      "lVert",
      "absolute",
      "inner",
      "范数",
      "绝对值",
      "内积",
      "距离",
    ],
    code: String.raw`$$
\lVert\mathbf{x}\rVert_2,\qquad \lvert x\rvert,\qquad \langle\mathbf{x},\mathbf{y}\rangle
$$`,
  },
  {
    id: "tex-delimiters",
    category: "latex",
    group: "线性代数与排版",
    title: "自动伸缩括号与空格",
    description:
      "left/right 成对使用，让括号适应分数高度；逗号命令、quad 调整数学间距。",
    keywords: [
      "left",
      "right",
      "quad",
      "bracket",
      "括号",
      "花括号",
      "间距",
      "空格",
    ],
    code: String.raw`$$
\left(\frac{a}{b}\right),\quad \left[\frac{x}{y}\right],\quad \left\{x\in\mathbb{R}:x>0\right\}
$$`,
  },
  {
    id: "tex-matrix",
    category: "latex",
    group: "线性代数与排版",
    title: "矩阵",
    description:
      "bmatrix 使用方括号，pmatrix 使用圆括号；& 分列，两个反斜杠换行。",
    keywords: ["matrix", "bmatrix", "pmatrix", "array", "矩阵", "行列", "换行"],
    code: String.raw`$$
A=\begin{bmatrix}
a & b \\
c & d
\end{bmatrix},\qquad
\mathbf{x}=\begin{pmatrix}x_1\\x_2\end{pmatrix}
$$`,
  },
  {
    id: "tex-cases",
    category: "latex",
    group: "线性代数与排版",
    title: "分段函数",
    description: "cases 自动添加左大括号；每行用 & 分隔表达式和条件。",
    keywords: ["cases", "piecewise", "分段", "条件", "大括号", "函数"],
    code: String.raw`$$
f(x)=\begin{cases}
x^2, & x\geq 0,\\
-x, & x<0.
\end{cases}
$$`,
  },
  {
    id: "tex-aligned",
    category: "latex",
    group: "线性代数与排版",
    title: "多行公式对齐",
    description:
      "在 $$ 内使用 aligned；把 & 放在需要对齐的等号前，用两个反斜杠换行。",
    keywords: ["aligned", "align", "multiline", "推导", "等号", "对齐", "换行"],
    code: String.raw`$$
\begin{aligned}
f(x+h)-f(x) &= 2xh+h^2,\\
\frac{f(x+h)-f(x)}{h} &= 2x+h.
\end{aligned}
$$`,
  },
  {
    id: "tex-annotation",
    category: "latex",
    group: "线性代数与排版",
    title: "公式注释与上下括号",
    description:
      "underbrace/overbrace 给表达式加说明；overset 可在等号上标注理由。",
    keywords: [
      "underbrace",
      "overbrace",
      "overset",
      "注释",
      "说明",
      "上括号",
      "下括号",
    ],
    code: String.raw`$$
\underbrace{a+b}_{\text{已知项}}+\overbrace{c+d}^{\text{待估计项}}\overset{\text{定义}}{=}s
$$`,
  },
  {
    id: "tex-optimization",
    category: "latex",
    group: "研究常用表达",
    title: "优化问题与 argmin",
    description:
      "用 operatorname* 定义带下方条件的 argmin，aligned 排列目标和约束。",
    keywords: [
      "argmin",
      "argmax",
      "min",
      "optimization",
      "最优化",
      "目标",
      "约束",
      "优化",
    ],
    code: String.raw`$$
\begin{aligned}
x^\star &= \operatorname*{arg\,min}_{x\in\mathbb{R}^d} f(x)\\
\text{满足}\quad & g(x)\leq 0.
\end{aligned}
$$`,
  },
  {
    id: "tex-text",
    category: "latex",
    group: "研究常用表达",
    title: "公式中的文字与常用函数",
    description:
      "text 写解释文字；log、exp、sin 等标准命令使用正确的正体与间距。",
    keywords: [
      "text",
      "mathrm",
      "operatorname",
      "log",
      "exp",
      "文字",
      "正体",
      "对数",
      "指数",
    ],
    code: String.raw`$$
\text{当 }x>0\text{ 时},\qquad \log(x),\qquad \exp(-x),\qquad \sin(\theta),\qquad \operatorname{rank}(A)
$$`,
  },
  {
    id: "tex-tag",
    category: "latex",
    group: "研究常用表达",
    title: "手动公式编号",
    description:
      "在独立公式里用 tag 添加编号。编号需要自己维护，不提供完整 LaTeX 的交叉引用。",
    keywords: ["tag", "number", "equation", "公式编号", "编号", "引用"],
    code: String.raw`$$
x_{t+1}=x_t-\eta\nabla f(x_t)\tag{1}
$$`,
  },
];

function normalizedSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

/** Every whitespace-separated word must occur somewhere in the entry. */
export function matchesWritingReference(
  entry: WritingReferenceEntry,
  query: string,
): boolean {
  const terms = normalizedSearchText(query).trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const searchable = normalizedSearchText(
    [
      entry.category,
      entry.group,
      entry.title,
      entry.description,
      ...entry.keywords,
      entry.code,
    ].join("\n"),
  );
  return terms.every((term) => searchable.includes(term));
}

export function searchWritingReference(
  query: string,
  category: WritingReferenceCategory | "all" = "all",
): WritingReferenceEntry[] {
  return writingReferenceEntries.filter(
    (entry) =>
      (category === "all" || entry.category === category) &&
      matchesWritingReference(entry, query),
  );
}
