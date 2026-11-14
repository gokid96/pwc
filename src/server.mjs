import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import pg from 'pg';
import { createDemoWorkflow } from './demo-session.mjs';
import { calculateW07, loadW07Data } from './w07.mjs';

const env = process.env;
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
// 예전 배포는 원본을 파일 저장소(S3)에 두었다. DB가 비어 있으면 그 원본을 읽어 DB에 한 번 옮긴다.
const s3 = env.STORAGE_BUCKET ? new S3Client({
  endpoint: env.STORAGE_ENDPOINT,
  region: 'auto',
  forcePathStyle: true,
  credentials: { accessKeyId: env.STORAGE_ACCESS_KEY, secretAccessKey: env.STORAGE_SECRET_KEY },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
}) : null;

async function legacySources() {
  if (!s3) return null;
  try {
    const { Body } = await s3.send(new GetObjectCommand({ Bucket: env.STORAGE_BUCKET, Key: 'w07/source-csvs.json' }));
    return await Body.transformToString('utf-8');
  } catch (error) {
    console.error('Legacy source read failed', error.name);
    return null;
  }
}

let sourceSchema;
function ensureSourceTable() {
  sourceSchema ??= pool.query(`CREATE TABLE IF NOT EXISTS public.w07_source_data (
    singleton boolean PRIMARY KEY CHECK (singleton),
    payload jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`).catch(error => {
    sourceSchema = undefined;
    throw error;
  });
  return sourceSchema;
}

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

async function readStoredData() {
  await ensureSourceTable();
  const { rows } = await pool.query('SELECT payload FROM public.w07_source_data WHERE singleton');
  if (rows.length) return readSources(rows[0].payload);
  const legacy = await legacySources();
  if (!legacy) throw new Error('W07 source data has not been loaded');
  const data = await readSources(JSON.parse(legacy));
  await pool.query(`INSERT INTO public.w07_source_data (singleton, payload) VALUES (true, $1)
    ON CONFLICT (singleton) DO NOTHING`, [legacy]);
  return data;
}

const workflow = createDemoWorkflow(pool, readStoredData, calculateW07, env.CONNECTION_CHECK_TOKEN);

const server = createServer(async (request, response) => {
  const path = request.url?.split('?')[0];
  try {
    if (path === '/' && ['GET', 'POST'].includes(request.method)) {
      return await workflow(request, response);
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
      await ensureSourceTable();
      await pool.query(`INSERT INTO public.w07_source_data (singleton, payload) VALUES (true, $1)
        ON CONFLICT (singleton) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`, [body.toString('utf8')]);
      return json(response, 200, { stored: true, ...summary });
    }
    if (request.method === 'GET' && path === '/api/w07/2026-06') {
      return json(response, 200, summarize(await readStoredData()));
    }
    return json(response, 404, { error: 'Not found' });
  } catch (error) {
    console.error('Request failed', path, error.code ?? error.name);
    return json(response, 503, { error: 'Service unavailable' });
  }
});

server.listen(Number(env.PORT ?? 8080), '0.0.0.0');
