import type { LimiterState } from '../core/schemas.js';

export interface AcquireConfig {
  algorithm: 'token-bucket' | 'sliding-window';
  ratePerSecond?: number;
  maxConcurrent?: number;
  limit?: number;
  windowSeconds?: number;
}

export interface AcquireResult {
  success: boolean;
  waitMs: number;
  concurrentCount?: number;
  currentCount?: number;
}

export interface RateLimitStore {
  initialize(): Promise<void>;
  acquire(key: string, config: AcquireConfig): Promise<AcquireResult>;
  release(key: string): Promise<void>;
  getState(key: string, config: AcquireConfig): Promise<LimiterState>;
  reset(key: string): Promise<void>;
  close(): Promise<void>;
}
