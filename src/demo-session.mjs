import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createWorkflow } from './workflow.mjs';

export function createDemoWorkflow(pool, readData, calculate, secret) {
  const signingKey = secret || randomBytes(32);
  const sign = id => createHmac('sha256', signingKey).update(id).digest('hex');

  return async (request, response) => {
    const cookie = request.headers.cookie?.match(/(?:^|;\s*)w07_demo=([a-f0-9]{32})\.([a-f0-9]{64})(?:;|$)/);
    const valid = cookie && timingSafeEqual(Buffer.from(cookie[2]), Buffer.from(sign(cookie[1])));
    const id = valid ? cookie[1] : randomBytes(16).toString('hex');
    const schema = 'w07_demo_' + id;
    if (!valid) {
      request.headers.cookie = '';
      response.setHeader('Set-Cookie',
        'w07_demo=' + id + '.' + sign(id) + '; Path=/; HttpOnly; Secure; SameSite=Lax');
    }

    let schemaReady;
    const scopedPool = {
      lockScope: schema,
      async connect() {
        const client = await pool.connect();
        try {
          schemaReady ??= (async () => {
            await client.query('BEGIN');
            try {
              await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [schema]);
              await client.query('CREATE SCHEMA IF NOT EXISTS ' + schema);
              await client.query('COMMIT');
            } catch (error) {
              await client.query('ROLLBACK');
              throw error;
            }
          })();
          await schemaReady;
          // 연결 풀(pgbouncer 등)에서 세션 단위 SET은 다른 연결로 새어 나갈 수 있어서,
          // 모든 쿼리를 트랜잭션 안에서 SET LOCAL로 이 브라우저의 스키마에 묶는다.
          const scope = () => client.query('SET LOCAL search_path TO ' + schema);
          let inTransaction = false;
          return {
            async query(sql, values) {
              const head = typeof sql === 'string' ? sql.trim().toUpperCase() : '';
              if (head === 'BEGIN') { const result = await client.query(sql); await scope(); inTransaction = true; return result; }
              if (head === 'COMMIT' || head === 'ROLLBACK') { inTransaction = false; return client.query(sql, values); }
              if (inTransaction) return client.query(sql, values);
              await client.query('BEGIN');
              try {
                await scope();
                const result = await client.query(sql, values);
                await client.query('COMMIT');
                return result;
              } catch (error) {
                await client.query('ROLLBACK').catch(() => {});
                throw error;
              }
            },
            release(error) { client.release(error); },
          };
        } catch (error) {
          client.release(error);
          throw error;
        }
      },
      async query(sql, values) {
        const client = await this.connect();
        try {
          return await client.query(sql, values);
        } finally {
          client.release();
        }
      },
    };

    return createWorkflow(scopedPool, readData, calculate)(request, response);
  };
}
