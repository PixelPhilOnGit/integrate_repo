import { describe, expect, it } from 'vitest';
import { createFakeRedis } from '../../src/modules/redis/core/fakeRedis';
import type { RedisReply } from '../../src/modules/redis/core/types';

function run(redis: ReturnType<typeof createFakeRedis>, line: string): RedisReply {
  return redis.exec(line.split(' '));
}

describe('假 Redis：字符串', () => {
  it('SET 之后 GET 拿得回来', () => {
    const redis = createFakeRedis();
    expect(run(redis, 'SET k v')).toEqual({ type: 'status', text: 'OK' });
    expect(run(redis, 'GET k')).toEqual({ type: 'bulk', text: 'v', binary: false, bytes: 1 });
  });

  it('GET 不存在的 key 返回 nil', () => {
    const redis = createFakeRedis();
    expect(run(redis, 'GET nope')).toEqual({ type: 'nil' });
  });

  it('APPEND 和 STRLEN 按字节算', () => {
    const redis = createFakeRedis();
    expect(run(redis, 'APPEND k hello')).toEqual({ type: 'integer', value: 5 });
    expect(run(redis, 'APPEND k world')).toEqual({ type: 'integer', value: 10 });
    expect(run(redis, 'GET k')).toEqual({ type: 'bulk', text: 'helloworld', binary: false, bytes: 10 });
    expect(run(redis, 'STRLEN k')).toEqual({ type: 'integer', value: 10 });

    // 中文一个字符三字节
    run(redis, 'SET cn 中文');
    expect(run(redis, 'STRLEN cn')).toEqual({ type: 'integer', value: 6 });
  });

  it('INCR / DECR 从 0 开始，非整数会报错', () => {
    const redis = createFakeRedis();
    expect(run(redis, 'INCR n')).toEqual({ type: 'integer', value: 1 });
    expect(run(redis, 'INCR n')).toEqual({ type: 'integer', value: 2 });
    expect(run(redis, 'DECR n')).toEqual({ type: 'integer', value: 1 });

    run(redis, 'SET s abc');
    const reply = run(redis, 'INCR s');
    expect(reply.type).toBe('error');
    if (reply.type === 'error') expect(reply.message).toContain('not an integer');
  });

  it('DEL 和 EXISTS', () => {
    const redis = createFakeRedis();
    run(redis, 'SET a 1');
    run(redis, 'SET b 2');

    expect(run(redis, 'EXISTS a b nope')).toEqual({ type: 'integer', value: 2 });
    expect(run(redis, 'DEL a nope')).toEqual({ type: 'integer', value: 1 });
    expect(run(redis, 'EXISTS a')).toEqual({ type: 'integer', value: 0 });
  });

  it('MGET 里不存在的 key 位置是 nil，不是空串', () => {
    const redis = createFakeRedis();
    run(redis, 'SET a 1');
    expect(run(redis, 'MGET a nope')).toEqual({
      type: 'array',
      items: [
        { type: 'bulk', text: '1', binary: false, bytes: 1 },
        { type: 'nil' },
      ],
    });
  });
});

describe('假 Redis：类型与过期', () => {
  it('TYPE 认得出各种类型', () => {
    const redis = createFakeRedis();
    expect(run(redis, 'TYPE nope')).toEqual({ type: 'status', text: 'none' });

    run(redis, 'SET s v');
    expect(run(redis, 'TYPE s')).toEqual({ type: 'status', text: 'string' });

    run(redis, 'LPUSH l a');
    expect(run(redis, 'TYPE l')).toEqual({ type: 'status', text: 'list' });

    run(redis, 'SADD st a');
    expect(run(redis, 'TYPE st')).toEqual({ type: 'status', text: 'set' });

    run(redis, 'HSET h f v');
    expect(run(redis, 'TYPE h')).toEqual({ type: 'status', text: 'hash' });

    run(redis, 'ZADD z 1 a');
    expect(run(redis, 'TYPE z')).toEqual({ type: 'status', text: 'zset' });
  });

  it('对类型不对的 key 操作会报 WRONGTYPE', () => {
    const redis = createFakeRedis();
    run(redis, 'SET s v');
    const reply = run(redis, 'LPUSH s x');
    expect(reply.type).toBe('error');
    if (reply.type === 'error') expect(reply.message).toContain('WRONGTYPE');
  });

  it('TTL 的三种取值：不存在 -2、没设过期 -1、有过期是剩余秒数', () => {
    const redis = createFakeRedis();
    expect(run(redis, 'TTL nope')).toEqual({ type: 'integer', value: -2 });

    run(redis, 'SET k v');
    expect(run(redis, 'TTL k')).toEqual({ type: 'integer', value: -1 });

    run(redis, 'SET k2 v EX 100');
    const reply = run(redis, 'TTL k2');
    expect(reply.type).toBe('integer');
    if (reply.type === 'integer') {
      expect(reply.value).toBeGreaterThan(95);
      expect(reply.value).toBeLessThanOrEqual(100);
    }
  });

  it('EXPIRE 返回 1，对不存在的 key 返回 0', () => {
    const redis = createFakeRedis();
    run(redis, 'SET k v');
    expect(run(redis, 'EXPIRE k 100')).toEqual({ type: 'integer', value: 1 });
    expect(run(redis, 'EXPIRE nope 100')).toEqual({ type: 'integer', value: 0 });
  });

  it('SET NX / XX 的语义', () => {
    const redis = createFakeRedis();
    expect(run(redis, 'SET k v NX')).toEqual({ type: 'status', text: 'OK' });
    // 已经存在，NX 不覆盖
    expect(run(redis, 'SET k other NX')).toEqual({ type: 'nil' });
    expect(run(redis, 'GET k')).toEqual({ type: 'bulk', text: 'v', binary: false, bytes: 1 });
    // XX 只在存在时写
    expect(run(redis, 'SET k other XX')).toEqual({ type: 'status', text: 'OK' });
    expect(run(redis, 'SET brand-new v XX')).toEqual({ type: 'nil' });
  });

  it('未知的 SET 选项报 syntax error', () => {
    const redis = createFakeRedis();
    const reply = run(redis, 'SET k v BOGUS');
    expect(reply.type).toBe('error');
    if (reply.type === 'error') expect(reply.message).toContain('syntax error');
  });
});

describe('假 Redis：其它结构', () => {
  it('列表：LPUSH 和 RPUSH 从不同端进', () => {
    const redis = createFakeRedis();
    run(redis, 'RPUSH l a');
    run(redis, 'RPUSH l b');
    run(redis, 'LPUSH l z');
    expect(run(redis, 'LRANGE l 0 -1')).toEqual({
      type: 'array',
      items: [
        { type: 'bulk', text: 'z', binary: false, bytes: 1 },
        { type: 'bulk', text: 'a', binary: false, bytes: 1 },
        { type: 'bulk', text: 'b', binary: false, bytes: 1 },
      ],
    });
    expect(run(redis, 'LLEN l')).toEqual({ type: 'integer', value: 3 });
  });

  it('集合：重复添加只算一次', () => {
    const redis = createFakeRedis();
    expect(run(redis, 'SADD s a')).toEqual({ type: 'integer', value: 1 });
    expect(run(redis, 'SADD s a')).toEqual({ type: 'integer', value: 0 });
    expect(run(redis, 'SADD s b')).toEqual({ type: 'integer', value: 1 });
    expect(run(redis, 'SISMEMBER s a')).toEqual({ type: 'integer', value: 1 });
    expect(run(redis, 'SISMEMBER s z')).toEqual({ type: 'integer', value: 0 });
    expect(run(redis, 'SREM s a')).toEqual({ type: 'integer', value: 1 });
  });

  it('哈希：HGETALL 展开成键值交替的数组', () => {
    const redis = createFakeRedis();
    expect(run(redis, 'HSET h f1 v1')).toEqual({ type: 'integer', value: 1 });
    expect(run(redis, 'HGET h f1')).toEqual({ type: 'bulk', text: 'v1', binary: false, bytes: 2 });
    expect(run(redis, 'HGET h nope')).toEqual({ type: 'nil' });
    expect(run(redis, 'HGETALL h')).toEqual({
      type: 'array',
      items: [
        { type: 'bulk', text: 'f1', binary: false, bytes: 2 },
        { type: 'bulk', text: 'v1', binary: false, bytes: 2 },
      ],
    });
  });

  it('有序集合：ZRANGE 按分数升序', () => {
    const redis = createFakeRedis();
    run(redis, 'ZADD z 3 c');
    run(redis, 'ZADD z 1 a');
    run(redis, 'ZADD z 2 b');
    expect(run(redis, 'ZRANGE z 0 -1')).toEqual({
      type: 'array',
      items: [
        { type: 'bulk', text: 'a', binary: false, bytes: 1 },
        { type: 'bulk', text: 'b', binary: false, bytes: 1 },
        { type: 'bulk', text: 'c', binary: false, bytes: 1 },
      ],
    });
  });
});

describe('假 Redis：键空间与库', () => {
  it('KEYS 支持 * 和 ? 通配', () => {
    const redis = createFakeRedis();
    run(redis, 'SET user:1 a');
    run(redis, 'SET user:2 b');
    run(redis, 'SET other c');

    expect(run(redis, 'KEYS *')).toEqual({
      type: 'array',
      items: [
        { type: 'bulk', text: 'user:1', binary: false, bytes: 6 },
        { type: 'bulk', text: 'user:2', binary: false, bytes: 6 },
        { type: 'bulk', text: 'other', binary: false, bytes: 5 },
      ],
    });
    expect(run(redis, 'KEYS user:*')).toEqual({
      type: 'array',
      items: [
        { type: 'bulk', text: 'user:1', binary: false, bytes: 6 },
        { type: 'bulk', text: 'user:2', binary: false, bytes: 6 },
      ],
    });
    expect(run(redis, 'KEYS user:?')).toEqual({
      type: 'array',
      items: [
        { type: 'bulk', text: 'user:1', binary: false, bytes: 6 },
        { type: 'bulk', text: 'user:2', binary: false, bytes: 6 },
      ],
    });
  });

  it('SCAN 返回 [游标, 键数组] 的形状', () => {
    const redis = createFakeRedis();
    run(redis, 'SET a 1');
    expect(run(redis, 'SCAN 0')).toEqual({
      type: 'array',
      items: [
        { type: 'bulk', text: '0', binary: false, bytes: 1 },
        {
          type: 'array',
          items: [{ type: 'bulk', text: 'a', binary: false, bytes: 1 }],
        },
      ],
    });
  });

  it('SELECT 换库之后互相看不见', () => {
    const redis = createFakeRedis();
    run(redis, 'SET k in-db0');

    expect(run(redis, 'SELECT 1')).toEqual({ type: 'status', text: 'OK' });
    expect(run(redis, 'GET k')).toEqual({ type: 'nil' });
    expect(run(redis, 'DBSIZE')).toEqual({ type: 'integer', value: 0 });

    run(redis, 'SET k in-db1');
    run(redis, 'SELECT 0');
    expect(run(redis, 'GET k')).toEqual({ type: 'bulk', text: 'in-db0', binary: false, bytes: 6 });
  });

  it('越界的库号报错，和真 Redis 一样', () => {
    const redis = createFakeRedis();
    const reply = run(redis, 'SELECT -1');
    expect(reply.type).toBe('error');
    if (reply.type === 'error') expect(reply.message).toContain('out of range');
  });

  it('FLUSHDB 只清当前库，FLUSHALL 清所有库', () => {
    const redis = createFakeRedis();
    run(redis, 'SET a 1');
    run(redis, 'SELECT 1');
    run(redis, 'SET b 2');

    run(redis, 'FLUSHDB');
    expect(run(redis, 'DBSIZE')).toEqual({ type: 'integer', value: 0 });
    run(redis, 'SELECT 0');
    expect(run(redis, 'DBSIZE')).toEqual({ type: 'integer', value: 1 });

    run(redis, 'FLUSHALL');
    expect(run(redis, 'DBSIZE')).toEqual({ type: 'integer', value: 0 });
  });
});

describe('假 Redis：会话命令', () => {
  it('PING 和 ECHO', () => {
    const redis = createFakeRedis();
    expect(run(redis, 'PING')).toEqual({ type: 'status', text: 'PONG' });
    expect(run(redis, 'PING hello')).toEqual({ type: 'bulk', text: 'hello', binary: false, bytes: 5 });
    expect(run(redis, 'ECHO hi')).toEqual({ type: 'bulk', text: 'hi', binary: false, bytes: 2 });
  });

  it('AUTH 一律成功（假 Redis 不设密码）', () => {
    const redis = createFakeRedis();
    expect(run(redis, 'AUTH anything')).toEqual({ type: 'status', text: 'OK' });
  });

  it('INFO 里有 redis_version，前端才拿得到版本号', () => {
    const redis = createFakeRedis();
    const reply = run(redis, 'INFO');
    expect(reply.type).toBe('bulk');
    if (reply.type === 'bulk') expect(reply.text).toContain('redis_version:');
  });

  it('未知命令报 unknown command，带上是哪个命令', () => {
    const redis = createFakeRedis();
    const reply = run(redis, 'FLY_TO_MARS');
    expect(reply.type).toBe('error');
    if (reply.type === 'error') {
      expect(reply.message).toContain('unknown command');
      expect(reply.message).toContain('FLY_TO_MARS');
    }
  });

  it('命令名大小写不敏感', () => {
    const redis = createFakeRedis();
    expect(run(redis, 'set k v')).toEqual({ type: 'status', text: 'OK' });
    expect(run(redis, 'GeT k')).toEqual({ type: 'bulk', text: 'v', binary: false, bytes: 1 });
  });
});
