import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import pg from 'pg';
import { calculateW07, loadW07Data } from './w07.mjs';

const env = process.env;
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const object = { Bucket: env.STORAGE_BUCKET, Key: 'w07/source-csvs.json' };
const s3 = new S3Client({
  endpoint: env.STORAGE_ENDPOINT,
  region: 'auto',
  credentials: {
    accessKeyId: env.STORAGE_ACCESS_KEY,
    secretAccessKey: env.STORAGE_SECRET_KEY,
  },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function authorized(request) {
  if (!env.CONNECTION_CHECK_TOKEN) return false;
  const hash = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(request.headers['x-connection-check-token'] ?? ''), hash(env.CONNECTION_CHECK_TOKEN));
}

function summarize(data) {
  const june = calculateW07(data).requests.filter(request => request.period === '2026-06');
  const executives = june.filter(request => request.exceedsLimit);
  return {
    period: '2026-06',
    sourceRows: june.reduce((total, request) => total + request.rebateRows.length, 0),
    relatedGroups: june.filter(request => request.group.members.length > 1).length,
    salesSupportRequests: june.length - executives.length,
    executiveRequests: executives.length,
    executiveTotalKrw: executives.reduce((total, request) => total + request.totalKrw, 0),
  };
}

function readSources(sources) {
  return loadW07Data(file => {
    if (!Object.hasOwn(sources, file) || typeof sources[file] !== 'string') {
      throw new Error('Missing source CSV');
    }
    return sources[file];
  });
}

const server = createServer(async (request, response) => {
  const path = request.url?.split('?')[0];
  try {
    if (request.method === 'GET' && path === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html lang="ko"><meta charset="utf-8"><title>aurora-ops</title><main>aurora-ops 서버 동작 확인</main></html>');
      return;
    }
    if (request.method === 'POST' && path === '/api/check/db') {
      if (!authorized(request)) return json(response, 401, { error: 'Unauthorized' });
      await pool.query(`CREATE TABLE IF NOT EXISTS connection_check (
        id integer PRIMARY KEY, message text NOT NULL, checked_at timestamptz NOT NULL
      )`);
      await pool.query(`INSERT INTO connection_check VALUES (1, $1, now())
        ON CONFLICT (id) DO UPDATE SET message = EXCLUDED.message, checked_at = EXCLUDED.checked_at`, ['PostgreSQL 연결 확인']);
      const { rows } = await pool.query('SELECT id, message, checked_at FROM connection_check WHERE id = 1');
      return json(response, 200, rows[0]);
    }
    if (request.method === 'PUT' && path === '/api/internal/w07-sources') {
      if (!authorized(request)) return json(response, 401, { error: 'Unauthorized' });
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 256 * 1024) return json(response, 413, { error: 'Source payload too large' });
        chunks.push(chunk);
      }
      let summary;
      const body = Buffer.concat(chunks);
      try {
        summary = summarize(await readSources(JSON.parse(body.toString('utf8'))));
      } catch {
        return json(response, 400, { error: 'Invalid source data' });
      }
      await s3.send(new PutObjectCommand({ ...object, Body: body, ContentType: 'application/json' }));
      return json(response, 200, { stored: true, ...summary });
    }
    if (request.method === 'GET' && path === '/api/w07/2026-06') {
      const { Body } = await s3.send(new GetObjectCommand(object));
      const data = await readSources(JSON.parse(await Body.transformToString('utf-8')));
      return json(response, 200, summarize(data));
    }
    return json(response, 404, { error: 'Not found' });
  } catch (error) {
    console.error('Request failed', path, error.code ?? error.name);
    return json(response, 503, { error: 'Service unavailable' });
  }
});

server.listen(Number(env.PORT ?? 8080), '0.0.0.0');
