import fs from 'node:fs';
import path from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { recommendEngine } from '@novatex/compiler';
import {
  PathSecurityError,
  isBinaryFilePath,
  isForbiddenLaTeXFile,
  normalizeProjectRelPath,
  resolveInsideWorkspace,
  type AcademicTemplateId,
  type CompileEngine,
  type ProjectFileEntry,
} from '@novatex/shared';

export const MAX_ZIP_COMPRESSED_BYTES = 35 * 1024 * 1024;
export const MAX_ZIP_UNCOMPRESSED_BYTES = 30 * 1024 * 1024;
export const MAX_ZIP_FILES = 500;

export interface ProjectPaths {
  rootDir: string;
  srcDir: string;
  buildDir: string;
}

export function getProjectPaths(dataDir: string, projectId: string): ProjectPaths {
  const safeId = projectId.replace(/[^A-Za-z0-9_-]/g, '');
  if (!safeId || safeId !== projectId) {
    throw new PathSecurityError('INVALID_PROJECT_ID', '非法的项目 ID');
  }
  const rootDir = path.join(path.resolve(dataDir), 'projects', safeId);
  return {
    rootDir,
    srcDir: path.join(rootDir, 'src'),
    buildDir: path.join(rootDir, '_build'),
  };
}

export function ensureProjectDirs(dataDir: string, projectId: string): ProjectPaths {
  const paths = getProjectPaths(dataDir, projectId);
  fs.mkdirSync(paths.srcDir, { recursive: true });
  fs.mkdirSync(paths.buildDir, { recursive: true });
  return paths;
}

export function removeProjectDirs(dataDir: string, projectId: string): void {
  const paths = getProjectPaths(dataDir, projectId);
  if (fs.existsSync(paths.rootDir)) {
    fs.rmSync(paths.rootDir, { recursive: true, force: true });
  }
}

function escapeLatexSimple(text: string): string {
  return text
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([#$%&_{}])/g, '\\$1')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/~/g, '\\textasciitilde{}');
}

const DEFAULT_REFS_BIB = `@inproceedings{vaswani2017attention,
  title={Attention Is All You Need},
  author={Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob and Jones, Llion and Gomez, Aidan N and Kaiser, {\\L}ukasz and Polosukhin, Illia},
  booktitle={Advances in Neural Information Processing Systems (NeurIPS)},
  year={2017}
}

@book{knuth1984texbook,
  title={The TeXbook},
  author={Knuth, Donald E.},
  publisher={Addison-Wesley},
  year={1984}
}
`;

/**
 * Populate a newly created project workspace with a cleanly compilable starter template.
 */
export function createStarterProjectFiles(
  srcDir: string,
  opts: {
    name: string;
    author: string;
    template: AcademicTemplateId;
  },
): { mainFile: string; recommendedEngine: CompileEngine } {
  const safeTitle = escapeLatexSimple(opts.name.trim() || 'NovaTeX 论文草稿');
  const safeAuthor = escapeLatexSimple(opts.author.trim() || 'NovaTeX Author');

  let mainTex: string;
  let extraFiles: Record<string, string> = {};
  let recommendedEngine: CompileEngine;

  if (opts.template === 'lab-report-en') {
    recommendedEngine = 'pdflatex';
    mainTex = `\\documentclass[11pt,a4paper]{article}
\\usepackage[margin=2.4cm]{geometry}
\\usepackage{amsmath,amssymb}
\\usepackage{booktabs,array}
\\usepackage{graphicx}
\\usepackage{listings}
\\usepackage{xcolor}
\\usepackage[colorlinks=true,linkcolor=blue,citecolor=blue,urlcolor=blue]{hyperref}

\\definecolor{codebg}{RGB}{248,250,252}
\\definecolor{codeframe}{RGB}{226,232,240}
\\definecolor{codekw}{RGB}{29,78,216}
\\definecolor{codecomment}{RGB}{100,116,139}
\\definecolor{codestr}{RGB}{21,128,61}

\\lstset{
  backgroundcolor=\\color{codebg},
  frame=single,
  rulecolor=\\color{codeframe},
  basicstyle=\\ttfamily\\small,
  keywordstyle=\\color{codekw}\\bfseries,
  commentstyle=\\color{codecomment}\\itshape,
  stringstyle=\\color{codestr},
  numbers=left,
  numberstyle=\\tiny\\color{codecomment},
  numbersep=8pt,
  breaklines=true,
  tabsize=2,
  columns=flexible,
  showstringspaces=false
}

\\title{\\Large\\bfseries ${safeTitle}}
\\author{${safeAuthor}}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{center}
\\begin{tabular}{@{}p{0.22\\textwidth}p{0.72\\textwidth}@{}}
\\toprule
\\textbf{Course} & EE / CS 301 -- Applied Systems Laboratory \\\\
\\textbf{Lab \\#} & Lab 01 -- ${safeTitle} \\\\
\\textbf{Author} & ${safeAuthor} \\\\
\\textbf{Date} & \\today \\\\
\\bottomrule
\\end{tabular}
\\end{center}
\\vspace{0.5em}

\\section{Objective}
\\label{sec:objective}
This laboratory report documents the design, implementation, and quantitative evaluation of a reproducible signal-processing and verification pipeline following rigorous technical documentation practices~\\cite{knuth1984texbook}. We measure system accuracy against reference targets and analyze residual measurement error.

\\input{sections/setup}

\\section{Implementation Code}
\\label{sec:implementation}
Listing~\\ref{lst:pipeline} implements the core normalized error evaluation routine used across all experimental trials.

\\begin{lstlisting}[language=Python, caption={Core measurement and RMSE evaluation routine.}, label={lst:pipeline}]
import math

def compute_rmse(reference, measured):
    \"\"\"Compute root-mean-square error across paired samples.\"\"\"
    if len(reference) != len(measured) or not reference:
        raise ValueError("Input sequences must be non-empty and equal length.")
    sq_err = [(r - m) ** 2 for r, m in zip(reference, measured)]
    return math.sqrt(sum(sq_err) / len(sq_err))

ref_vals = [1.000, 2.500, 5.000, 10.000]
meas_vals = [0.992, 2.515, 4.980, 10.040]
print(f"RMSE = {compute_rmse(ref_vals, meas_vals):.4f}")
\\end{lstlisting}

\\section{Measured Results}
\\label{sec:results}
Table~\\ref{tab:measurements} summarizes the four calibration trials recorded under nominal operating conditions.

\\begin{table}[ht]
\\centering
\\caption{Calibration trials comparing reference and measured outputs.}
\\label{tab:measurements}
\\begin{tabular}{ccccc}
\\toprule
Trial & Reference (V) & Measured (V) & Abs. Error (V) & Rel. Error (\\%) \\\\
\\midrule
1 & 1.000 & 0.992 & 0.008 & 0.80 \\\\
2 & 2.500 & 2.515 & 0.015 & 0.60 \\\\
3 & 5.000 & 4.980 & 0.020 & 0.40 \\\\
4 & 10.000 & 10.040 & 0.040 & 0.40 \\\\
\\bottomrule
\\end{tabular}
\\end{table}

\\section{Error Analysis}
\\label{sec:error}
The aggregate root-mean-square error (RMSE) across $N = 4$ paired trials is computed as:
\\begin{equation}
  \\mathrm{RMSE} = \\sqrt{\\frac{1}{N} \\sum_{i=1}^{N} \\left(y_i^{\\mathrm{meas}} - y_i^{\\mathrm{ref}}\\right)^2} \\approx 0.0239\\,\\mathrm{V}.
  \\label{eq:rmse}
\\end{equation}
Relative error stays strictly below $0.80\\%$ across the tested dynamic range, confirming linearity and low systematic drift consistent with modern automated evaluation workflows~\\cite{vaswani2017attention}.

\\section{Conclusion}
\\label{sec:conclusion}
All experimental objectives were met. As shown in Section~\\ref{sec:setup}, Table~\\ref{tab:measurements}, and Equation~(\\ref{eq:rmse}), the pipeline achieves sub-$1\\%$ relative error with reproducible measurements.

\\bibliographystyle{plain}
\\bibliography{refs}
\\end{document}
`;
    extraFiles = {
      'sections/setup.tex': `\\section{Experimental Setup}
\\label{sec:setup}
All experiments were conducted in a deterministic software environment using fixed random seeds and calibrated reference inputs.

\\begin{itemize}
  \\item \\textbf{Hardware Platform}: Workstation CPU with calibrated digital acquisition interface.
  \\item \\textbf{Software Environment}: Python~3.11+ standard library and reproducible NovaTeX build pipeline.
  \\item \\textbf{Sampling Protocol}: Four linearly spaced calibration setpoints with three repeated captures per setpoint.
\\end{itemize}
`,
    };
  } else if (opts.template === 'lab-report-zh') {
    recommendedEngine = 'xelatex';
    mainTex = `\\documentclass[12pt,a4paper]{ctexart}
\\usepackage[margin=2.4cm]{geometry}
\\usepackage{amsmath,amssymb}
\\usepackage{booktabs,array}
\\usepackage{graphicx}
\\usepackage{listings}
\\usepackage{xcolor}
\\usepackage[colorlinks=true,linkcolor=blue,citecolor=blue,urlcolor=blue]{hyperref}

\\definecolor{codebg}{RGB}{248,250,252}
\\definecolor{codeframe}{RGB}{226,232,240}
\\definecolor{codekw}{RGB}{29,78,216}
\\definecolor{codecomment}{RGB}{100,116,139}
\\definecolor{codestr}{RGB}{21,128,61}

\\lstset{
  backgroundcolor=\\color{codebg},
  frame=single,
  rulecolor=\\color{codeframe},
  basicstyle=\\ttfamily\\small,
  keywordstyle=\\color{codekw}\\bfseries,
  commentstyle=\\color{codecomment}\\itshape,
  stringstyle=\\color{codestr},
  numbers=left,
  numberstyle=\\tiny\\color{codecomment},
  numbersep=8pt,
  breaklines=true,
  tabsize=2,
  columns=flexible,
  showstringspaces=false
}

\\title{\\Large\\bfseries ${safeTitle}}
\\author{${safeAuthor}}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{center}
\\begin{tabular}{@{}p{0.20\\textwidth}p{0.74\\textwidth}@{}}
\\toprule
\\textbf{课程名称} & 专业基础实验课程 \\\\
\\textbf{实验名称} & ${safeTitle} \\\\
\\textbf{姓名} & ${safeAuthor} \\\\
\\textbf{实验日期} & \\today \\\\
\\bottomrule
\\end{tabular}
\\end{center}
\\vspace{0.5em}

\\section{实验目的与原理}
\\label{sec:objective}
本实验旨在掌握核心算法建模与定量误差评估方法，并基于规范的科技排版流程~\\cite{knuth1984texbook} 完成可复现的实验报告撰写。实验中我们将对比基线方法与优化方法在相同测试集上的精度与运行开销。

\\input{sections/setup}

\\section{核心实现代码}
\\label{sec:implementation}
核心评估与误差计算脚本如下所示（见代码清单~\\ref{lst:core}）：

\\begin{lstlisting}[language=Python, caption={Core RMSE evaluation script.}, label={lst:core}]
import math

def evaluate_rmse(targets, predictions):
    # Compute root-mean-square error over paired samples
    n = len(targets)
    assert n > 0 and n == len(predictions)
    mse = sum((t - p) ** 2 for t, p in zip(targets, predictions)) / n
    return math.sqrt(mse)

y_true = [1.00, 2.00, 3.00, 4.00]
y_pred = [1.02, 1.97, 3.04, 3.98]
print(f"RMSE = {evaluate_rmse(y_true, y_pred):.4f}")
\\end{lstlisting}

\\section{实验数据与结果对比}
\\label{sec:results}
表~\\ref{tab:results} 汇总了不同方案在相同测试环境下的核心指标对比。

\\begin{table}[ht]
\\centering
\\caption{不同实验方案的精度与延迟对比（三线表）}
\\label{tab:results}
\\begin{tabular}{lccc}
\\toprule
实验方案 & 均方根误差 (RMSE) & 准确率 (\\%) & 平均耗时 (ms) \\\\
\\midrule
基线方法 & 0.0842 & 91.4 & 18.6 \\\\
改进方法（本文） & 0.0292 & 96.5 & 12.1 \\\\
\\bottomrule
\\end{tabular}
\\end{table}

\\section{误差分析与实验总结}
\\label{sec:conclusion}
均方根误差（RMSE）按式~(\\ref{eq:rmse}) 定义：
\\begin{equation}
  \\mathrm{RMSE} = \\sqrt{\\frac{1}{N} \\sum_{i=1}^{N} \\left(y_i - \\hat{y}_i\\right)^2}
  \\label{eq:rmse}
\\end{equation}
结合第~\\ref{sec:setup} 节的实验配置与表~\\ref{tab:results} 的实测数据可见，改进方法在保持更低计算延迟的同时显著降低了预测误差，验证了特征建模思路的有效性~\\cite{vaswani2017attention}。

\\bibliographystyle{plain}
\\bibliography{refs}
\\end{document}
`;
    extraFiles = {
      'sections/setup.tex': `\\section{实验环境}
\\label{sec:setup}
本实验在固定随机种子与统一硬件配置下执行，以确保全部测试数据可重复验证：

\\begin{itemize}
  \\item \\textbf{操作系统与硬件}：64 位桌面工作站，多核处理器与充足内存。
  \\item \\textbf{软件环境}：Python~3.11+ 标准库环境与 XeLaTeX 排版工具链。
  \\item \\textbf{数据划分}：每组实验重复测试 3 次并取平均值作为表~\\ref{tab:results} 中的最终统计结果。
\\end{itemize}
`,
    };
  } else if (opts.template === 'tech-report') {
    recommendedEngine = 'pdflatex';
    mainTex = `\\documentclass[11pt,a4paper]{article}
\\usepackage[margin=2.5cm]{geometry}
\\usepackage{amsmath,amssymb}
\\usepackage{booktabs,array}
\\usepackage{graphicx}
\\usepackage{listings}
\\usepackage{xcolor}
\\usepackage[colorlinks=true,linkcolor=blue,citecolor=blue,urlcolor=blue]{hyperref}

\\definecolor{codebg}{RGB}{248,250,252}
\\definecolor{codeframe}{RGB}{226,232,240}
\\definecolor{codekw}{RGB}{29,78,216}
\\definecolor{codecomment}{RGB}{100,116,139}
\\definecolor{codestr}{RGB}{21,128,61}

\\lstset{
  backgroundcolor=\\color{codebg},
  frame=single,
  rulecolor=\\color{codeframe},
  basicstyle=\\ttfamily\\small,
  keywordstyle=\\color{codekw}\\bfseries,
  commentstyle=\\color{codecomment}\\itshape,
  stringstyle=\\color{codestr},
  numbers=left,
  numberstyle=\\tiny\\color{codecomment},
  numbersep=8pt,
  breaklines=true,
  tabsize=2,
  columns=flexible,
  showstringspaces=false
}

\\title{\\Large\\bfseries ${safeTitle}}
\\author{${safeAuthor}}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
This technical report presents the architecture, core implementation, and benchmark evaluation of our course project, structured for reproducible engineering documentation~\\cite{knuth1984texbook}.
\\end{abstract}

\\tableofcontents
\\vspace{0.8em}

\\input{sections/architecture}

\\section{Core Implementation}
\\label{sec:implementation}
Listing~\\ref{lst:worker} shows the bounded batch scheduler that keeps tail latency predictable under bursty workloads.

\\begin{lstlisting}[language=Python, caption={Bounded batch processing worker.}, label={lst:worker}]
from collections import deque

class BoundedScheduler:
    def __init__(self, max_batch_size=32):
        self.max_batch_size = max_batch_size
        self.queue = deque()

    def enqueue(self, item):
        self.queue.append(item)

    def next_batch(self):
        batch = []
        while self.queue and len(batch) < self.max_batch_size:
            batch.append(self.queue.popleft())
        return batch
\\end{lstlisting}

\\section{Benchmark Comparison}
\\label{sec:benchmark}
We compare throughput, tail latency, and memory footprint across three execution strategies in Table~\\ref{tab:bench}. Speedup relative to the sequential baseline is defined as $S = T_{\\text{base}} / T_{\\text{opt}}$, following standard scalable system evaluation practices~\\cite{vaswani2017attention}.

\\begin{table}[ht]
\\centering
\\caption{End-to-end system benchmark across execution modes.}
\\label{tab:bench}
\\begin{tabular}{lccc}
\\toprule
Configuration & Throughput (req/s) & P95 Latency (ms) & Peak Memory (MB) \\\\
\\midrule
Sequential Baseline & 420 & 48.2 & 128 \\\\
Pooled Workers & 1,180 & 19.5 & 214 \\\\
Bounded Batching (Ours) & 1,640 & 11.8 & 196 \\\\
\\bottomrule
\\end{tabular}
\\end{table}

\\section{Conclusion}
\\label{sec:conclusion}
As demonstrated in Section~\\ref{sec:architecture} and Table~\\ref{tab:bench}, bounded batching delivers a $3.9\\times$ throughput improvement while cutting P95 latency by $75\\%$.

\\bibliographystyle{plain}
\\bibliography{refs}
\\end{document}
`;
    extraFiles = {
      'sections/architecture.tex': `\\section{System Architecture}
\\label{sec:architecture}
The system is organized into three decoupled layers to ensure fault isolation and straightforward testing:

\\subsection{Ingestion Layer}
Incoming requests are validated, normalized, and placed into a bounded ring buffer with explicit backpressure limits.

\\subsection{Execution Engine}
Worker routines pull bounded batches (see Listing~\\ref{lst:worker}) and compute deterministic outputs while recording structured telemetry.
`,
    };
  } else if (opts.template === 'beamer-slides') {
    recommendedEngine = 'pdflatex';
    mainTex = `\\documentclass[aspectratio=169,11pt]{beamer}
\\usetheme{Madrid}
\\usepackage{amsmath,amssymb}
\\usepackage{booktabs,array}
\\usepackage{graphicx}

\\title{${safeTitle}}
\\author{${safeAuthor}}
\\date{\\today}

\\begin{document}

% Slide 1: Title Slide
\\begin{frame}
  \\titlepage
\\end{frame}

% Slide 2: Outline
\\begin{frame}{Outline}
  \\tableofcontents
\\end{frame}

\\section{Method \\& Formulation}
% Slide 3: Method & Key Equation
\\begin{frame}{Method \\& Key Formulation}
  \\begin{itemize}
    \\item Modular local-first pipeline with reproducible parameter sweeps.
    \\item Regularized empirical risk minimization objective:
  \\end{itemize}
  \\begin{equation}
    \\mathcal{L}(\\theta) = \\frac{1}{N} \\sum_{i=1}^{N} \\ell\\big(f_{\\theta}(x_i), y_i\\big) + \\lambda \\|\\theta\\|_2^2
    \\label{eq:objective}
  \\end{equation}
  \\begin{itemize}
    \\item Key benefit: stable convergence and low variance across folds.
  \\end{itemize}
\\end{frame}

\\section{Experimental Summary}
% Slide 4: Experimental Summary
\\begin{frame}{Experimental Summary}
  \\begin{table}
    \\centering
    \\caption{Benchmark summary across evaluated configurations.}
    \\begin{tabular}{lccc}
      \\toprule
      Method & Accuracy (\\%) & F1 Score & Latency (ms) \\\\
      \\midrule
      Baseline & 91.4 & 0.908 & 18.2 \\\\
      Ablation (No Reg.) & 94.1 & 0.937 & 14.6 \\\\
      \\textbf{Proposed} & \\textbf{96.5} & \\textbf{0.962} & \\textbf{11.4} \\\\
      \\bottomrule
    \\end{tabular}
  \\end{table}
\\end{frame}

\\end{document}
`;
    extraFiles = {};
  } else if (opts.template === 'ieee-conf') {
    recommendedEngine = 'pdflatex';
    mainTex = `\\documentclass[10pt,twocolumn,a4paper]{article}
\\usepackage{amsmath}
\\usepackage{booktabs}
\\usepackage{graphicx}

\\title{${safeTitle}}
\\author{${safeAuthor}}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
This paper demonstrates a clean two-column conference manuscript authored in NovaTeX with collaborative editing and reproducible builds.
\\end{abstract}

\\input{sections/intro}

\\section{Methodology}
\\label{sec:method}
Our objective function balances representation fidelity and regularization:
\\begin{equation}
  \\mathcal{L}(\\theta) = \\frac{1}{N} \\sum_{i=1}^{N} \\ell(f_{\\theta}(x_i), y_i) + \\lambda \\|\\theta\\|_2^2
  \\label{eq:loss}
\\end{equation}

\\begin{table}[ht]
\\centering
\\caption{Baseline comparison.}
\\label{tab:results}
\\begin{tabular}{lc}
\\toprule
Method & Accuracy (\\%) \\\\
\\midrule
Baseline & 91.4 \\\\
NovaTeX Pipeline & 95.8 \\\\
\\bottomrule
\\end{tabular}
\\end{table}

\\bibliographystyle{plain}
\\bibliography{refs}
\\end{document}
`;
    extraFiles = {
      'sections/intro.tex': `\\section{Introduction}
\\label{sec:intro}
Modern scientific publishing relies on structured mathematical typesetting~\\cite{knuth1984texbook} and neural sequence modeling~\\cite{vaswani2017attention}.
As shown in Section~\\ref{sec:method} and Equation~(\\ref{eq:loss}), modular sub-files compile seamlessly.
`,
    };
  } else if (opts.template === 'clean-article') {
    recommendedEngine = 'pdflatex';
    mainTex = `\\documentclass[11pt,a4paper]{article}
\\usepackage{amsmath}
\\usepackage{booktabs}
\\usepackage{graphicx}

\\title{${safeTitle}}
\\author{${safeAuthor}}
\\date{\\today}

\\begin{document}
\\maketitle

\\input{sections/intro}

\\section{Method}
\\label{sec:method}
Consider the canonical energy-mass relation:
\\begin{equation}
  E = mc^2
  \\label{eq:energy}
\\end{equation}
See Table~\\ref{tab:summary} for a summary of experimental metrics.

\\begin{table}[ht]
\\centering
\\caption{Experimental summary.}
\\label{tab:summary}
\\begin{tabular}{lc}
\\toprule
Model & Score \\\\
\\midrule
Baseline & 0.88 \\\\
Proposed & 0.94 \\\\
\\bottomrule
\\end{tabular}
\\end{table}

\\bibliographystyle{plain}
\\bibliography{refs}
\\end{document}
`;
    extraFiles = {
      'sections/intro.tex': `\\section{Introduction}
\\label{sec:intro}
This manuscript builds on foundational typesetting~\\cite{knuth1984texbook} and attention architectures~\\cite{vaswani2017attention}.
`,
    };
  } else {
    // Default: chinese-ctex
    recommendedEngine = 'xelatex';
    mainTex = `\\documentclass{ctexart}
\\usepackage{amsmath}
\\usepackage{booktabs}
\\usepackage{graphicx}

\\title{${safeTitle}}
\\author{${safeAuthor}}
\\date{\\today}

\\begin{document}
\\maketitle

\\input{sections/intro}

\\section{方法设计}
\\label{sec:method}
我们定义联合优化目标如下：
\\begin{equation}
  \\mathcal{L}(\\theta) = \\frac{1}{N} \\sum_{i=1}^{N} \\ell(f_{\\theta}(x_i), y_i) + \\lambda \\|\\theta\\|_2^2
  \\label{eq:loss}
\\end{equation}

表~\\ref{tab:results} 展示了基准对比结果。

\\begin{table}[ht]
\\centering
\\caption{模型性能对比实验}
\\label{tab:results}
\\begin{tabular}{lc}
\\toprule
方法 & 准确率 (\\%) \\\\
\\midrule
基准模型 & 91.4 \\\\
本文方法 & 96.2 \\\\
\\bottomrule
\\end{tabular}
\\end{table}

\\bibliographystyle{plain}
\\bibliography{refs}
\\end{document}
`;
    extraFiles = {
      'sections/intro.tex': `\\section{引言}
\\label{sec:intro}
高质量学术写作离不开严谨的数学排版\\cite{knuth1984texbook}与前沿建模方法\\cite{vaswani2017attention}。
本文在第~\\ref{sec:method} 节详细阐述方法设计，并通过公式~(\\ref{eq:loss}) 给出目标函数。
`,
    };
  }

  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'main.tex'), mainTex, 'utf8');
  for (const [relPath, content] of Object.entries(extraFiles)) {
    const absPath = path.join(srcDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf8');
  }
  fs.writeFileSync(path.join(srcDir, 'refs.bib'), DEFAULT_REFS_BIB, 'utf8');

  return { mainFile: 'main.tex', recommendedEngine };
}

export function isLikelyBinaryFile(absPath: string, relPath: string): boolean {
  if (isBinaryFilePath(relPath)) return true;
  try {
    const fd = fs.openSync(absPath, 'r');
    try {
      const probe = Buffer.alloc(512);
      const bytesRead = fs.readSync(fd, probe, 0, 512, 0);
      for (let i = 0; i < bytesRead; i++) {
        if (probe[i] === 0) return true;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // fallback
  }
  return false;
}

/**
 * Safely list all files and directories inside a project's `src` workspace.
 * Skips `.git`, `_build`, `node_modules`, and all symlinks/junctions.
 */
export function listProjectFiles(srcDir: string): ProjectFileEntry[] {
  if (!fs.existsSync(srcDir)) return [];
  const entries: ProjectFileEntry[] = [];

  const walk = (absDir: string, relPrefix: string) => {
    let dirEntries: fs.Dirent[];
    try {
      dirEntries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const item of dirEntries) {
      const lowerName = item.name.toLowerCase();
      if (
        lowerName === '.git' ||
        lowerName === '.gitmodules' ||
        /^git~[0-9]+$/i.test(item.name) ||
        lowerName === '_build' ||
        lowerName === 'node_modules' ||
        item.isSymbolicLink()
      ) {
        continue;
      }

      const relPath = relPrefix ? `${relPrefix}/${item.name}` : item.name;
      const absPath = path.join(absDir, item.name);

      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(absPath);
        if (stat.isSymbolicLink()) continue;
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        entries.push({
          path: relPath,
          name: item.name,
          kind: 'dir',
          size: 0,
          mtimeMs: stat.mtimeMs,
          isBinary: false,
        });
        walk(absPath, relPath);
      } else if (stat.isFile()) {
        entries.push({
          path: relPath,
          name: item.name,
          kind: 'file',
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          isBinary: isLikelyBinaryFile(absPath, relPath),
        });
      }
    }
  };

  walk(srcDir, '');
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

export interface ImportZipResult {
  importedFiles: string[];
  skippedFiles: string[];
  mainFile: string;
  engine: CompileEngine;
  totalBytes: number;
}

function isIgnorableZipJunk(posixPath: string): boolean {
  const segments = posixPath.split('/').filter(Boolean);
  if (segments.length === 0) return true;
  if (
    segments.some((s) => {
      const l = s.toLowerCase();
      return l === '__macosx' || l === '.git' || l === '.gitmodules' || /^git~[0-9]+$/i.test(s);
    })
  ) {
    return true;
  }
  const base = segments[segments.length - 1]!;
  const baseLower = base.toLowerCase();
  if (baseLower === '.ds_store' || baseLower === 'thumbs.db') return true;
  if (isForbiddenLaTeXFile(base)) return true;
  return false;
}

function checkZipEntryTraversalOrAbsolute(rawName: string): void {
  const trimmed = rawName.trim();
  if (!trimmed) return;
  if (trimmed.includes('\0') || /[\x00-\x1f]/.test(trimmed)) {
    throw new PathSecurityError('CONTROL_CHAR', `压缩包条目包含非法控制字符: ${rawName}`);
  }
  if (/^[a-zA-Z]:/.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('\\\\')) {
    throw new PathSecurityError('ABSOLUTE_PATH', `压缩包禁止包含绝对路径: ${rawName}`);
  }
  const parts = trimmed.replace(/\\/g, '/').split('/');
  if (parts.includes('..')) {
    throw new PathSecurityError('PATH_TRAVERSAL', `压缩包禁止包含越界路径 (..): ${rawName}`);
  }
}

/**
 * Safely import an Overleaf or local `.zip` archive into `destDir`.
 * - Rejects zip-slip traversal (`..`), absolute paths, >30MB uncompressed, >500 files.
 * - Strips single common root folder automatically.
 * - Silently strips/skips forbidden files (`.latexmkrc`, `latexmkrc`, `texmf.cnf`, `.env`, `.git/`, `__MACOSX/`).
 * - Auto-detects main `.tex` file and recommended LaTeX engine.
 */
export function importProjectZip(zipBase64: string, destDir: string): ImportZipResult {
  if (typeof zipBase64 !== 'string' || !zipBase64.trim()) {
    throw new PathSecurityError('INVALID_ARCHIVE', '缺少有效的 ZIP 数据');
  }

  const cleaned = zipBase64.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
    throw new PathSecurityError('INVALID_ARCHIVE', 'ZIP base64 编码格式无效');
  }

  const zipBuf = Buffer.from(cleaned, 'base64');
  if (zipBuf.byteLength === 0) {
    throw new PathSecurityError('INVALID_ARCHIVE', 'ZIP 文件为空');
  }
  if (zipBuf.byteLength > MAX_ZIP_COMPRESSED_BYTES) {
    throw new PathSecurityError('ARCHIVE_TOO_LARGE', 'ZIP 压缩包体积超出 35 MB 上限');
  }

  const skippedFiles: string[] = [];
  let declaredFiles = 0;
  let declaredBytes = 0;

  let rawEntries: Record<string, Uint8Array>;
  try {
    rawEntries = unzipSync(new Uint8Array(zipBuf.buffer, zipBuf.byteOffset, zipBuf.byteLength), {
      filter(entry) {
        checkZipEntryTraversalOrAbsolute(entry.name);
        const posix = entry.name.replace(/\\/g, '/').replace(/\/+/g, '/');
        if (posix.endsWith('/')) {
          return false;
        }
        if (isIgnorableZipJunk(posix)) {
          skippedFiles.push(posix);
          return false;
        }
        declaredFiles++;
        if (declaredFiles > MAX_ZIP_FILES) {
          throw new PathSecurityError(
            'TOO_MANY_FILES',
            `压缩包文件数量超出上限（最多 ${MAX_ZIP_FILES} 个文件）`,
          );
        }
        declaredBytes += Math.max(0, entry.originalSize || 0);
        if (declaredBytes > MAX_ZIP_UNCOMPRESSED_BYTES) {
          throw new PathSecurityError(
            'ARCHIVE_UNCOMPRESSED_TOO_LARGE',
            '压缩包解压后总大小超出 30 MB 上限',
          );
        }
        return true;
      },
    });
  } catch (err) {
    if (err instanceof PathSecurityError) throw err;
    throw new PathSecurityError(
      'INVALID_ARCHIVE',
      `无法解压 ZIP 压缩包：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const normalizedPairs: Array<{ posix: string; data: Uint8Array }> = [];
  for (const [rawName, data] of Object.entries(rawEntries)) {
    const posix = rawName.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '');
    if (!posix || posix.endsWith('/')) continue;
    if (isIgnorableZipJunk(posix)) {
      skippedFiles.push(posix);
      continue;
    }
    normalizedPairs.push({ posix, data });
  }

  if (normalizedPairs.length === 0) {
    throw new PathSecurityError('EMPTY_ARCHIVE', '压缩包内未包含可导入的有效文件');
  }
  if (normalizedPairs.length > MAX_ZIP_FILES) {
    throw new PathSecurityError(
      'TOO_MANY_FILES',
      `压缩包文件数量超出上限（最多 ${MAX_ZIP_FILES} 个文件）`,
    );
  }

  // Strip a single common top-level wrapper folder (e.g. `paper-project/main.tex`)
  const firstSegments = new Set<string>();
  let allNested = true;
  for (const item of normalizedPairs) {
    const slash = item.posix.indexOf('/');
    if (slash <= 0) {
      allNested = false;
      break;
    }
    firstSegments.add(item.posix.slice(0, slash));
  }
  const commonRoot = allNested && firstSegments.size === 1 ? `${[...firstSegments][0]!}/` : '';

  fs.mkdirSync(destDir, { recursive: true });

  const importedFiles: string[] = [];
  let totalBytes = 0;

  for (const item of normalizedPairs) {
    const stripped = commonRoot ? item.posix.slice(commonRoot.length) : item.posix;
    if (!stripped) continue;

    if (isIgnorableZipJunk(stripped)) {
      skippedFiles.push(stripped);
      continue;
    }

    totalBytes += item.data.byteLength;
    if (totalBytes > MAX_ZIP_UNCOMPRESSED_BYTES) {
      throw new PathSecurityError(
        'ARCHIVE_UNCOMPRESSED_TOO_LARGE',
        '压缩包解压后实际大小超出 30 MB 上限',
      );
    }

    const safeRel = normalizeProjectRelPath(stripped);
    const { absPath } = resolveInsideWorkspace(destDir, safeRel);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, item.data);
    importedFiles.push(safeRel);
  }

  if (importedFiles.length === 0) {
    throw new PathSecurityError('EMPTY_ARCHIVE', '压缩包内未包含可导入的有效文件');
  }

  // Auto-detect main .tex file
  const texFiles = importedFiles
    .filter((f) => f.toLowerCase().endsWith('.tex'))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));

  let mainFile = 'main.tex';
  if (texFiles.includes('main.tex')) {
    mainFile = 'main.tex';
  } else {
    let foundWithDocClass: string | null = null;
    for (const tf of texFiles) {
      try {
        const content = fs.readFileSync(path.join(destDir, tf), 'utf8');
        if (/\\documentclass(?:\[[^\]]*\])?\{/.test(content)) {
          foundWithDocClass = tf;
          break;
        }
      } catch {
        // ignore
      }
    }
    mainFile = foundWithDocClass ?? texFiles[0] ?? 'main.tex';
  }

  let engine: CompileEngine = 'xelatex';
  try {
    const mainAbs = path.join(destDir, mainFile);
    if (fs.existsSync(mainAbs)) {
      const content = fs.readFileSync(mainAbs, 'utf8');
      engine = recommendEngine(content);
    }
  } catch {
    engine = 'xelatex';
  }

  return {
    importedFiles,
    skippedFiles,
    mainFile,
    engine,
    totalBytes,
  };
}

/**
 * Zip all safe project workspace files (excluding `.git`, `_build`, symlinks) into a Buffer.
 */
export function exportProjectZip(srcDir: string): Buffer {
  const fileEntries = listProjectFiles(srcDir).filter((e) => e.kind === 'file');
  const zipMap: Record<string, Uint8Array> = {};

  for (const entry of fileEntries) {
    if (isForbiddenLaTeXFile(entry.name)) continue;
    const { absPath } = resolveInsideWorkspace(srcDir, entry.path);
    const data = fs.readFileSync(absPath);
    zipMap[entry.path] = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  const zipped = zipSync(zipMap, { level: 6 });
  return Buffer.from(zipped.buffer, zipped.byteOffset, zipped.byteLength);
}

export interface ExtractedBibAndLabels {
  citeKeys: Array<{ key: string; title?: string; author?: string; year?: string }>;
  labels: Array<{ label: string; file?: string; line?: number }>;
}

function readBibField(body: string, fieldName: string): string | undefined {
  const re = new RegExp(`\\b${fieldName}\\s*=\\s*`, 'i');
  const match = re.exec(body);
  if (!match) return undefined;
  let pos = match.index + match[0].length;
  while (pos < body.length && /\s/.test(body[pos]!)) pos++;
  if (pos >= body.length) return undefined;

  const opener = body[pos];
  let raw = '';
  if (opener === '{') {
    let depth = 0;
    pos++;
    const start = pos;
    while (pos < body.length) {
      const ch = body[pos]!;
      if (ch === '{') depth++;
      else if (ch === '}') {
        if (depth === 0) break;
        depth--;
      }
      pos++;
    }
    raw = body.slice(start, pos);
  } else if (opener === '"') {
    pos++;
    const start = pos;
    while (pos < body.length) {
      if (body[pos] === '"' && body[pos - 1] !== '\\') break;
      pos++;
    }
    raw = body.slice(start, pos);
  } else {
    const start = pos;
    while (pos < body.length && body[pos] !== ',' && body[pos] !== '}' && body[pos] !== '\n') {
      pos++;
    }
    raw = body.slice(start, pos);
  }

  const cleaned = raw.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
  return cleaned || undefined;
}

function parseBibFileContent(
  content: string,
): Array<{ key: string; title?: string; author?: string; year?: string }> {
  const results: Array<{ key: string; title?: string; author?: string; year?: string }> = [];
  const entryRe = /@([a-zA-Z]+)\s*[{(]\s*([^,\s{}]+)\s*,/g;
  let match: RegExpExecArray | null;

  while ((match = entryRe.exec(content)) !== null) {
    const entryType = match[1]!.toLowerCase();
    if (entryType === 'comment' || entryType === 'preamble' || entryType === 'string') {
      continue;
    }
    const key = match[2]!.trim();
    if (!key) continue;

    // Extract entry body until matching closing brace
    let depth = 1;
    let cursor = match.index + match[0].length;
    const bodyStart = cursor;
    while (cursor < content.length && depth > 0) {
      const ch = content[cursor]!;
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      cursor++;
    }
    const body = content.slice(bodyStart, Math.max(bodyStart, cursor - 1));
    results.push({
      key,
      title: readBibField(body, 'title'),
      author: readBibField(body, 'author'),
      year: readBibField(body, 'year'),
    });
  }

  return results;
}

/**
 * Scan all `.bib` and `.tex` files in a project workspace for citation keys and `\label{...}` anchors
 * powering CodeMirror 6 autocomplete.
 */
export function extractBibKeysAndLabels(srcDir: string): ExtractedBibAndLabels {
  const files = listProjectFiles(srcDir).filter((f) => f.kind === 'file' && !f.isBinary);
  const citeMap = new Map<string, { key: string; title?: string; author?: string; year?: string }>();
  const labels: Array<{ label: string; file?: string; line?: number }> = [];
  const seenLabels = new Set<string>();

  for (const entry of files) {
    const lower = entry.path.toLowerCase();
    const absPath = path.join(srcDir, entry.path);

    if (lower.endsWith('.bib')) {
      try {
        const text = fs.readFileSync(absPath, 'utf8');
        for (const item of parseBibFileContent(text)) {
          if (!citeMap.has(item.key)) {
            citeMap.set(item.key, item);
          }
        }
      } catch {
        // ignore unreadable bib
      }
    } else if (lower.endsWith('.tex') || lower.endsWith('.ltx')) {
      try {
        const lines = fs.readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n').split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          // Strip unescaped % comments
          let code = line;
          for (let c = 0; c < line.length; c++) {
            if (line[c] === '%') {
              let bs = 0;
              let j = c - 1;
              while (j >= 0 && line[j] === '\\') {
                bs++;
                j--;
              }
              if (bs % 2 === 0) {
                code = line.slice(0, c);
                break;
              }
            }
          }
          for (const m of code.matchAll(/\\label\{([^}]+)\}/g)) {
            const label = (m[1] ?? '').trim();
            if (label && !seenLabels.has(label)) {
              seenLabels.add(label);
              labels.push({ label, file: entry.path, line: i + 1 });
            }
          }
        }
      } catch {
        // ignore unreadable tex
      }
    }
  }

  return {
    citeKeys: Array.from(citeMap.values()),
    labels,
  };
}
