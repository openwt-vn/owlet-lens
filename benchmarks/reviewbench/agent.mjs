// ReviewBench adapter: run Owlet Lens in local+findings-out mode.
// Contract: AGENT_CONTRACT.md in https://github.com/review-bench/ReviewBench
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const env = process.env;
for (const name of ["RB_NWO", "RB_PR_NUMBER", "RB_BASE", "RB_HEAD", "RB_OUT"]) {
  if (!env[name]) {
    console.error(`agent: missing ${name}`);
    process.exit(2);
  }
}

const repo = env.RB_REPO ?? "/work/repo";
const configPath = env.RB_CONFIG_PATH ?? "/agent/ai-review.config.yaml";
const llmKey = env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || env.GEMINI_API_KEY
  || env.DEEPSEEK_API_KEY || env.MODELSTACK_API_KEY;
if (!llmKey) {
  console.error("agent: set an LLM API key (e.g. ANTHROPIC_API_KEY)");
  process.exit(2);
}

mkdirSync(dirname(env.RB_OUT), { recursive: true });

const args = [
  "review",
  "--provider=local",
  `--repo-dir=${repo}`,
  `--base=${env.RB_BASE}`,
  `--head=${env.RB_HEAD}`,
  `--findings-out=${env.RB_OUT}`,
  `--config=${configPath}`,
  "--force-review",
];

console.error(`agent: owlet-lens review of ${env.RB_NWO}#${env.RB_PR_NUMBER}`);

const child = spawn("owlet-lens", args, {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...env, RB_AGENT: env.RB_AGENT || "owlet-lens" },
  cwd: repo,
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => { stdout += d; process.stderr.write(d); });
child.stderr.on("data", (d) => { stderr += d; process.stderr.write(d); });

const status = await new Promise((resolve) => {
  child.on("error", (error) => {
    stderr += `\n${error.message}`;
    resolve(-1);
  });
  child.on("close", (code) => resolve(code ?? 1));
});

// Owlet may exit 0 or 1 depending on activity rules; ReviewBench only needs a
// valid findings file. Treat missing/invalid RB_OUT as failure.
try {
  const { readFileSync } = await import("node:fs");
  JSON.parse(readFileSync(env.RB_OUT, "utf8"));
} catch {
  console.error(`agent: owlet-lens exited ${status}; no valid JSON at RB_OUT`);
  if (stderr) console.error(stderr.slice(-2000));
  process.exit(1);
}

if (status !== 0) {
  console.error(`agent: owlet-lens exited ${status}`);
  process.exit(1);
}

console.error("agent: findings written");
process.exit(0);
