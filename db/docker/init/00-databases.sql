-- ===========================================================================
-- 本地开发库初始化（由 postgres 官方镜像在首次启动时用 psql 执行）
--
-- 只做一件事：额外创建一个**集成测试库**。名字必须包含 test ——
-- `postgres-integration.spec.ts` 会 fail-closed 拒绝在库名不含 test 的目标上执行 DDL。
--
-- 幂等：重复执行不会报错（容器数据卷已存在时该目录不会再次执行，这里只是双保险）。
-- ===========================================================================

\set ON_ERROR_STOP on

SELECT 'CREATE DATABASE researcher_manager_test OWNER ' || quote_ident(current_user)
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'researcher_manager_test')\gexec
