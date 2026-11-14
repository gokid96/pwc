import { fileURLToPath } from 'node:url';

export const sourceDirectory = process.env.W07_SOURCE_DIRECTORY ||
  fileURLToPath(new URL('../../01_참가자_배포용/04_원본데이터/', import.meta.url));
