/**
 * Atomic Lua script implementing the token bucket algorithm.
 *
 * Handles both rate limiting and optional concurrency limiting in a single
 * round-trip. Returns exact wait time so the client can sleep precisely
 * instead of polling, reducing Redis round-trips.
 *
 * KEYS:
 * - KEYS[1]: rate key (stores last allowed timestamp)
 * - KEYS[2]: concurrent key (stores current concurrency counter)
 *
 * ARGV:
 * - ARGV[1]: now (current time as float seconds)
 * - ARGV[2]: interval (minimum seconds between requests; 0 disables rate check)
 * - ARGV[3]: max_concurrent (concurrency limit; 0 disables concurrency check)
 * - ARGV[4]: ttl (key expiry in seconds)
 *
 * Returns: `[success, waitMs, concurrentCount]`
 * - success: 1 if allowed, 0 if denied
 * - waitMs: milliseconds to wait before retrying (rate limited); -1 for concurrency limited
 * - concurrentCount: current concurrent count after acquisition (-1 if not tracked)
 */
export const TOKEN_BUCKET_SCRIPT = `
local rate_key = KEYS[1]
local concurrent_key = KEYS[2]
local now = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local max_concurrent = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

local wait_ms = 0
if interval > 0 then
    local last_time = redis.call('GET', rate_key)
    if last_time then
        local elapsed = now - tonumber(last_time)
        if elapsed < interval then
            wait_ms = math.ceil((interval - elapsed) * 1000)
            return {0, wait_ms, -1}
        end
    end
end

local current_concurrent = 0
if max_concurrent > 0 then
    current_concurrent = tonumber(redis.call('GET', concurrent_key) or '0')
    if current_concurrent >= max_concurrent then
        return {0, -1, current_concurrent}
    end
end

if interval > 0 then
    redis.call('SET', rate_key, now, 'EX', ttl)
end

if max_concurrent > 0 then
    current_concurrent = redis.call('INCR', concurrent_key)
    redis.call('EXPIRE', concurrent_key, ttl)
end

return {1, 0, current_concurrent}
`;

/**
 * Atomic Lua script implementing the sliding window algorithm.
 *
 * Prunes expired entries from the sorted set, checks the request count against
 * the limit, and optionally enforces a concurrency cap — all in one round-trip.
 * Uses a unique composite member ID to avoid score collisions.
 *
 * KEYS:
 * - KEYS[1]: window key (sorted set of request timestamps)
 * - KEYS[2]: concurrent key (stores current concurrency counter)
 *
 * ARGV:
 * - ARGV[1]: now (current time as float seconds)
 * - ARGV[2]: limit (maximum requests allowed in the window)
 * - ARGV[3]: window_seconds (size of the sliding window)
 * - ARGV[4]: max_concurrent (concurrency limit; 0 disables concurrency check)
 * - ARGV[5]: ttl (key expiry in seconds)
 *
 * Returns: `[success, waitMs, concurrentCount, currentCount]`
 * - success: 1 if allowed, 0 if denied
 * - waitMs: milliseconds until the oldest entry expires (window limited); -1 for concurrency limited
 * - concurrentCount: current concurrent count after acquisition (-1 if not tracked)
 * - currentCount: number of requests in the window after this call
 */
export const SLIDING_WINDOW_SCRIPT = `
local window_key = KEYS[1]
local concurrent_key = KEYS[2]
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local window_seconds = tonumber(ARGV[3])
local max_concurrent = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

local cutoff = now - window_seconds
redis.call('ZREMRANGEBYSCORE', window_key, '-inf', cutoff)

local current_count = redis.call('ZCARD', window_key)

if current_count >= limit then
    local oldest = redis.call('ZRANGE', window_key, 0, 0, 'WITHSCORES')
    local wait_ms = 0
    if oldest and #oldest >= 2 then
        local oldest_time = tonumber(oldest[2])
        local expires_at = oldest_time + window_seconds
        wait_ms = math.ceil((expires_at - now) * 1000)
        if wait_ms < 0 then wait_ms = 1 end
    end
    return {0, wait_ms, -1, current_count}
end

local current_concurrent = 0
if max_concurrent > 0 then
    current_concurrent = tonumber(redis.call('GET', concurrent_key) or '0')
    if current_concurrent >= max_concurrent then
        return {0, -1, current_concurrent, current_count}
    end
end

local unique_id = now .. ':' .. math.random(1000000000) .. ':' .. redis.call('INCR', window_key .. ':seq')
redis.call('ZADD', window_key, now, unique_id)
redis.call('EXPIRE', window_key, ttl)

if max_concurrent > 0 then
    current_concurrent = redis.call('INCR', concurrent_key)
    redis.call('EXPIRE', concurrent_key, ttl)
end

return {1, 0, current_concurrent, current_count + 1}
`;

/**
 * Atomic Lua script that decrements the concurrency counter.
 *
 * Guards against the counter going below zero — a no-op if the key
 * does not exist or is already at zero.
 *
 * KEYS:
 * - KEYS[1]: concurrent key (stores current concurrency counter)
 *
 * Returns: new counter value after decrement, or 0 if already at zero
 */
export const RELEASE_SCRIPT = `
local concurrent_key = KEYS[1]
local current = tonumber(redis.call('GET', concurrent_key) or '0')
if current > 0 then
    return redis.call('DECR', concurrent_key)
end
return 0
`;
