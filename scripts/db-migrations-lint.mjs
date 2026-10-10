#!/usr/bin/env node
/**
 * 迁移文件静态校验：命名、头部注释字段、事务边界、序号唯一且严格递增。
 *
 * 判定规则与运行期共享契约 `services/api/src/db/migrations/migration-boundary.ts` 一致，
 * 且与 `db/migrations/README.md` 的「命名与顺序 / 每个文件必须包含的头部注释」一节对齐：
 * - 文件名 `NNNN_snake_case.sql`（4 位序号 + 小写字母数字下划线）；
 * - 头部前 12 行内必须有独立成行、以字段名开头的 `-- migration:` / `-- description:` / `-- reversible:`；
 * - `BEGIN;` 与 `COMMIT;` 必须同时出现或同时不出现；
 * - 序号唯一且严格递增。
 *
 * 边界：只读 `db/migrations/` 下的文件，不连接数据库、不执行任何 SQL、不写任何文件、
 * 不读取仓库内其它目录（含 docs 内部文档），且只使用 node: 内置模块。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(repoRoot, 'db/migrations');

const FILE_PATTERN = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const REQUIRED_HEADER_FIELDS = ['-- migration:', '-- description:', '-- reversible:'];
/** 头部注释只在前 12 行内查找，与运行期 readHeaderLine 的窗口一致 */
const HEADER_SCAN_LINES = 12;
const README_FILE = 'README.md';

function main() {
  const failures = [];
  const warnings = [];
  const migrations = [];

  if (!existsSync(migrationsDir)) {
    console.error('x 缺少迁移目录: db/migrations');
    process.exitCode = 1;
    return;
  }

  /** 头部字段必须独立成行并以字段名开头（与运行期 readHeaderLine 同一判定语义） */
  function readHeaderLine(content, field) {
    for (const line of content.split('\n').slice(0, HEADER_SCAN_LINES)) {
      const trimmed = line.trim();
      if (trimmed.startsWith(field)) {
        return trimmed.slice(field.length).trim();
      }
    }
    return undefined;
  }

  for (const entry of readdirSync(migrationsDir)) {
    if (entry === README_FILE || entry.startsWith('.')) {
      continue;
    }
    const match = FILE_PATTERN.exec(entry);
    if (!match) {
      failures.push(`文件名不符合 NNNN_snake_case.sql 规范: ${entry}`);
      continue;
    }
    const [, version, name] = match;
    const content = readFileSync(join(migrationsDir, entry), 'utf8');

    for (const field of REQUIRED_HEADER_FIELDS) {
      if (readHeaderLine(content, field) === undefined) {
        failures.push(`${entry} 头部缺少注释字段: ${field}`);
      }
    }

    const hasBegin = /(^|\n)\s*BEGIN;/i.test(content);
    const hasCommit = /(^|\n)\s*COMMIT;/i.test(content);
    if (hasBegin !== hasCommit) {
      failures.push(`${entry} 事务边界不配对（BEGIN/COMMIT 必须同时出现或同时不出现）`);
    }

    if (content.includes('DROP TABLE') && !content.includes('IF EXISTS')) {
      warnings.push(`${entry} 含 DROP TABLE 但未使用 IF EXISTS`);
    }

    migrations.push({ entry, version, name });
  }

  migrations.sort((left, right) => left.version.localeCompare(right.version));

  const seenVersions = new Map();
  let previousVersion = '';
  for (const migration of migrations) {
    const duplicate = seenVersions.get(migration.version);
    if (duplicate !== undefined) {
      failures.push(
        `迁移序号重复: ${migration.version} 同时出现在 ${duplicate} 与 ${migration.entry}`,
      );
      continue;
    }
    seenVersions.set(migration.version, migration.entry);
    if (previousVersion !== '' && migration.version <= previousVersion) {
      failures.push(`迁移顺序非法: ${migration.entry} 出现在 ${previousVersion} 之后但序号不递增`);
    }
    previousVersion = migration.version;
  }

  console.log('数据库迁移静态校验');
  console.log('- 目录: db/migrations');
  console.log(`- 迁移文件: ${migrations.length} 份`);
  for (const migration of migrations) {
    console.log(`  ${migration.version}  ${migration.entry}`);
  }

  if (warnings.length > 0) {
    console.log(`\n提示 (${warnings.length})`);
    for (const warning of warnings) {
      console.log(`  ~ ${warning}`);
    }
  }

  if (failures.length > 0) {
    console.error(`\n失败 (${failures.length})`);
    for (const failure of failures) {
      console.error(`  x ${failure}`);
    }
    process.exitCode = 1;
  } else {
    console.log('\n结果: 通过');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
