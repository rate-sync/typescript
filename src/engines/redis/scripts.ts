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

export const RELEASE_SCRIPT = `
local concurrent_key = KEYS[1]
local current = tonumber(redis.call('GET', concurrent_key) or '0')
if current > 0 then
    return redis.call('DECR', concurrent_key)
end
return 0
`;
