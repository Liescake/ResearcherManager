import { Module } from '@nestjs/common';

/**
 * 特征最小化、候选召回、AI 排序、校验与降级 模块占位（阶段：P7）。
 * 当前不包含任何业务实现，仅声明模块边界，避免后续跨模块直接调用导致边界腐化。
 * 参考：docs/P2-架构与数据设计.md §2 服务模块边界。
 */
@Module({})
export class MatchingModule {}
