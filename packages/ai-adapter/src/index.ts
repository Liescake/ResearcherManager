/**
 * @rm/ai-adapter 公共出口：结构化匹配 schema、校验、安全降级与 Provider 端口。
 */
export * from './errors';
export * from './audit/snapshot';
export * from './matching/types';
export * from './matching/schema';
export * from './matching/deidentify';
export * from './matching/prompt';
export * from './matching/validate';
export * from './matching/fallback';
export * from './matching/invoke';
export * from './provider/provider-port';
export * from './provider/timeout';
export * from './provider/mock-provider';
export * from './provider/endpoint';
export * from './provider/http-json-provider';
