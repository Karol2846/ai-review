import { describe, it, expect, vi, beforeEach } from "vitest";
import { RateLimiter } from "../src/rateLimiter";

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("allows requests within limit", () => {
    const limiter = new RateLimiter({ maxRequests: 3, windowMs: 1000 });
    expect(limiter.isAllowed("user-1")).toBe(true);
    expect(limiter.isAllowed("user-1")).toBe(true);
    expect(limiter.isAllowed("user-1")).toBe(true);
  });

  it("blocks requests over limit", () => {
    const limiter = new RateLimiter({ maxRequests: 2, windowMs: 1000 });
    limiter.isAllowed("user-1");
    limiter.isAllowed("user-1");
    expect(limiter.isAllowed("user-1")).toBe(false);
  });

  it("allows requests again after window expires", () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 1000 });
    limiter.isAllowed("user-1");
    vi.advanceTimersByTime(1001);
    expect(limiter.isAllowed("user-1")).toBe(true);
  });

  it("tracks clients independently", () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 1000 });
    limiter.isAllowed("user-1");
    expect(limiter.isAllowed("user-2")).toBe(true);
  });
});
