#!/usr/bin/env node
/**
 * 匹配推荐契约的静态交叉校验：OpenAPI 片段 ↔ @rm/ai-adapter 手写 JSON Schema 常量。
 *
 * 刻意不引入 YAML 依赖：校验范围只落在缩进稳定、不得漂移的契约片段上。
 *
 * 输入边界（公开脚本，只使用 node: 内置模块，不联网、不写文件）：
 * - `packages/ai-adapter/src/matching/schema.ts` 是随仓库分发的公开源码，缺失即失败；
 * - `docs/P2-openapi.yaml` 是**仅本机保留**的内部契约文档（见 .gitignore，不随仓库分发），
 *   缺失时只提示并跳过这一半交叉校验，并以退出码 0 结束，避免在公开检出（CI / 纯净检出）
 *   里把「内部文档不入库」误报成契约失败；
 * - 无论文档是否存在，都**不会把文档内容写入输出**，输出只包含文件相对路径、固定检查项
 *   名称与判定结论。
 *
 * 行尾无关性：本脚本比对的是缩进结构片段，与行尾无关。Windows 上 core.autocrlf=true
 * （本机为全局配置）的检出 / `git archive` 产物是 CRLF，若直接把 CRLF 文本喂给以 `\n`
 * 锚定的片段正则，即使契约完全一致也会判为「未找到定义」。因此两个输入统一先归一化
 * 行尾（CRLF / 裸 CR → LF，并去掉 BOM）再做校验；这不会放宽任何检查项，只是让
 * LF 与 CRLF 检出得到同一结论。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const openApiRelative = 'docs/P2-openapi.yaml';
const schemaRelative = 'packages/ai-adapter/src/matching/schema.ts';

const failures = [];
const skips = [];
const checkedScopes = [];

/**
 * 读取契约文本并归一化：去掉 BOM、把 CRLF / 裸 CR 统一为 LF。
 * 契约片段正则以 `\n` 锚定缩进，归一化保证 LF 与 CRLF 检出结论一致。
 */
function readContract(relativePath) {
  return readFileSync(join(repoRoot, relativePath), 'utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
}

function requireMatch(label, content, pattern) {
  if (!pattern.test(content)) {
    failures.push(`${label}: 未找到 ${pattern}`);
  }
}

function rejectMatch(label, content, pattern) {
  if (pattern.test(content)) {
    failures.push(`${label}: 不应匹配 ${pattern}`);
  }
}

// 公开源码：手写 JSON Schema 必须声明 advice 且不得回退到旧字段名 suggestion。
// 检查范围限定在 MatchResponse 的 recommendations item，避免误判无关 schema。
if (!existsSync(join(repoRoot, schemaRelative))) {
  failures.push(`缺少公开源码: ${schemaRelative}`);
} else {
  const source = readContract(schemaRelative);
  const jsonSchema = source.match(
    /export const MATCHING_OUTPUT_JSON_SCHEMA[\s\S]*?\n} as const;/,
  )?.[0];
  if (!jsonSchema) {
    failures.push('AI adapter: 缺少 MATCHING_OUTPUT_JSON_SCHEMA 定义');
  } else {
    checkedScopes.push(`公开 JSON Schema (${schemaRelative})`);
    const itemSchema = jsonSchema.match(/items:\s*\{[\s\S]*?\n\s+\},\n\s+\},\n\s+\},/)?.[0];
    if (!itemSchema) {
      failures.push('AI adapter: 缺少 recommendations.items 定义');
    } else {
      requireMatch(
        'AI adapter recommendation required',
        itemSchema,
        /required:\s*\['groupId', 'score', 'reason', 'advice'\]/,
      );
      requireMatch('AI adapter recommendation properties.advice', itemSchema, /\n\s+advice:\s*\{/);
      rejectMatch('AI adapter recommendation suggestion', itemSchema, /\bsuggestion\b/);
    }
  }
}

// 内部 OpenAPI 文档：只在存在时读取，且只比对不得漂移的片段。
if (!existsSync(join(repoRoot, openApiRelative))) {
  skips.push(`跳过 OpenAPI 交叉校验: ${openApiRelative} 不在工作区（内部文档不入库）`);
} else {
  const openApi = readContract(openApiRelative);
  const recommendationItem = openApi.match(
    /recommendations:\n\s+type: array[\s\S]*?\n\s+modelVersion:/,
  )?.[0];
  if (!recommendationItem) {
    failures.push('OpenAPI: 缺少 MatchResponse.data.recommendations 定义');
  } else {
    checkedScopes.push(`内部 OpenAPI (${openApiRelative})`);
    requireMatch(
      'OpenAPI recommendation required',
      recommendationItem,
      /required:\s*\[groupId, score, reason, advice\]/,
    );
    requireMatch(
      'OpenAPI recommendation properties.advice',
      recommendationItem,
      /\n\s+advice:\s*\{\s*type:\s*string/,
    );
    rejectMatch('OpenAPI recommendation suggestion', recommendationItem, /\bsuggestion\b/);
  }
}

console.log('OpenAPI matching contract static lint');
console.log(`- OpenAPI: ${openApiRelative}`);
console.log(`- JSON Schema source: ${schemaRelative}`);

if (skips.length > 0) {
  console.log(`\n提示 (${skips.length})`);
  for (const skip of skips) {
    console.log(`  ~ ${skip}`);
  }
  console.log('  ~ 内部文档不入库属预期：该半边跳过后仍以退出码 0 结束');
}

if (failures.length > 0) {
  console.error(`\n失败 (${failures.length})`);
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exitCode = 1;
} else {
  console.log('\n已校验契约半边:');
  for (const scope of checkedScopes) console.log(`  - ${scope}`);
  console.log('- recommendation advice: required and declared in checked contracts');
  console.log('- recommendation suggestion: absent from checked contracts');
  console.log('\n结果: 通过');
}
