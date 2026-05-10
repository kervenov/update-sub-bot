import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'config.json');

let writeQueue = Promise.resolve();

const DEFAULT = {
  marzban: { username: '', password: '' },
  autoRotate: true,
};

async function readRaw() {
  try {
    const txt = await fs.readFile(FILE, 'utf8');
    const json = JSON.parse(txt);
    return {
      marzban: {
        username: typeof json?.marzban?.username === 'string' ? json.marzban.username : '',
        password: typeof json?.marzban?.password === 'string' ? json.marzban.password : '',
      },
      autoRotate: typeof json?.autoRotate === 'boolean' ? json.autoRotate : true,
    };
  } catch (err) {
    if (err.code === 'ENOENT') return structuredClone(DEFAULT);
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

export async function getMarzbanCredentials() {
  const data = await readRaw();
  return data.marzban;
}

export async function setMarzbanCredentials(username, password) {
  return serialise(async () => {
    const data = await readRaw();
    data.marzban = { username, password };
    await writeRaw(data);
  });
}

export async function clearMarzbanCredentials() {
  return setMarzbanCredentials('', '');
}

export async function hasMarzbanCredentials() {
  const { username, password } = await getMarzbanCredentials();
  return Boolean(username && password);
}

export async function getAutoRotate() {
  const data = await readRaw();
  return data.autoRotate;
}

export async function setAutoRotate(enabled) {
  return serialise(async () => {
    const data = await readRaw();
    data.autoRotate = Boolean(enabled);
    await writeRaw(data);
    return data.autoRotate;
  });
}
