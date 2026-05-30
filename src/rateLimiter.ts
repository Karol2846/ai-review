export interface RateLimiterOptions {
  maxRequests: number;
  windowMs: number;
}

export class RateLimiter {
  private requests: Record<string, number[]> = {};
  private options: RateLimiterOptions;

  constructor(options: RateLimiterOptions) {
    this.options = options;
  }

  isAllowed(clientId: string): boolean {
    const now = Date.now();
    if (!this.requests[clientId]) {
      this.requests[clientId] = [];
    }
    this.requests[clientId] = this.requests[clientId].filter(t => t > now - this.options.windowMs);
    if (this.requests[clientId].length >= this.options.maxRequests) {
      return false;
    }
    this.requests[clientId].push(now);
    return true;
  }

  getStats(clientId: string): { count: number; remaining: number; resetIn: number } {
    const now = Date.now();
    const windowStart = now - this.options.windowMs;
    const active = (this.requests[clientId] ?? []).filter(t => t > windowStart);
    const oldest = active[0];
    return {
      count: active.length,
      remaining: this.options.maxRequests - active.length,
      resetIn: oldest ? oldest + this.options.windowMs - now : 0,
    };
  }

  reset(clientId: string): void {
    delete this.requests[clientId];
  }

  resetAll(): void {
    this.requests = {};
  }
}
