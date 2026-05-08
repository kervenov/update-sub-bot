import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'reservedServers.json');

const VALID_TYPES = new Set(['CDN', 'forward']);

let writeQueue = Promise.resolve();

async function readRaw() {
  try {
    const txt = await fs.readFile(FILE, 'utf8');
    const json = JSON.parse(txt);
    return {
      CDN: Array.isArray(json.CDN) ? json.CDN.filter((x) => typeof x === 'string') : [],
      forward: Array.isArray(json.forward) ? json.forward.filter((x) => typeof x === 'string') : [],
    };
  } catch (err) {
    if (err.code === 'ENOENT') return { CDN: [], forward: [] };
    throw err;
  }
}

async function writeRaw(data) {
  const tmp = `${FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, FILE);
}

function serialise(fn) {
  const next = writeQueue.then(fn, fn);
  writeQueue = next.catch(() => {});
  return next;
}

export function isValidType(type) {
  return VALID_TYPES.has(type);
}

export async function getAll() {
  return readRaw();
}

export async function getPool(type) {
  if (!isValidType(type)) throw new Error(`invalid type: ${type}`);
  const data = await readRaw();
  return data[type];
}

export async function addIp(type, ip) {
  if (!isValidType(type)) throw new Error(`invalid type: ${type}`);
  return serialise(async () => {
    const data = await readRaw();
    if (data[type].includes(ip)) return { added: false, pool: data[type] };
    data[type].push(ip);
    await writeRaw(data);
    return { added: true, pool: data[type] };
  });
}

export async function removeIp(type, ip) {
  if (!isValidType(type)) throw new Error(`invalid type: ${type}`);
  return serialise(async () => {
    const data = await readRaw();
    const idx = data[type].indexOf(ip);
    if (idx === -1) return { removed: false, pool: data[type] };
    data[type].splice(idx, 1);
    await writeRaw(data);
    return { removed: true, pool: data[type] };
  });
}

export async function popNextIp(type) {
  if (!isValidType(type)) throw new Error(`invalid type: ${type}`);
  return serialise(async () => {
    const data = await readRaw();
    if (data[type].length === 0) return null;
    const ip = data[type].shift();
    await writeRaw(data);
    return ip;
  });
}
