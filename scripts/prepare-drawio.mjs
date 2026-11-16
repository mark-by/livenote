import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const version = '32.6.10';
const checksum = 'a57b06b3b6a876a351dacfe65d027d9509319cd030e9bacf6ae04a034d66a38f';
const target = resolve(dirname(fileURLToPath(import.meta.url)), '../src/web/public/drawio');
const marker = `${version} ${checksum}\n`;
const required = ['index.html', 'js/app.min.js', 'LICENSE', 'img/LICENSE', 'shapes/LICENSE', 'stencils/LICENSE', 'templates/LICENSE'];
const exec = promisify(execFile);

async function ready() {
  try {
    if (await readFile(join(target, '.livenote-version'), 'utf8') !== marker) return false;
    await Promise.all(required.map((file) => access(join(target, file))));
    return true;
  } catch {
    return false;
  }
}

if (await ready()) {
  console.log(`draw.io ${version}: локальные файлы готовы`);
} else {
  const work = await mkdtemp(join(tmpdir(), 'livenote-drawio-'));
  const staging = `${target}.staging-${process.pid}`;
  const backup = `${target}.backup-${process.pid}`;
  let moved = false;
  try {
    const response = await fetch(`https://github.com/jgraph/drawio/releases/download/v${version}/draw.war`);
    if (!response.ok) throw new Error(`Ошибка загрузки draw.war: HTTP ${response.status}`);
    const archive = join(work, 'draw.war');
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    if (hash.digest('hex') !== checksum) throw new Error('Контрольная сумма draw.war не совпадает');
    await rm(staging, { recursive: true, force: true });
    await exec('unzip', ['-q', archive, '-d', staging, '-x', 'WEB-INF/*', 'META-INF/*', '*.jsp', '*.class', '*.jar']);
    const licenseResponse = await fetch(`https://raw.githubusercontent.com/jgraph/drawio/v${version}/LICENSE`);
    if (!licenseResponse.ok) throw new Error(`Ошибка загрузки лицензии: HTTP ${licenseResponse.status}`);
    const license = Buffer.from(await licenseResponse.arrayBuffer());
    if (createHash('sha256').update(license).digest('hex') !== '43070e2d4e532684de521b885f385d0841030efa2b1a20bafb76133a5e1379c1') {
      throw new Error('Контрольная сумма лицензии draw.io не совпадает');
    }
    await writeFile(join(staging, 'LICENSE'), license);
    await Promise.all(required.map((file) => access(join(staging, file))));
    await writeFile(join(staging, '.livenote-version'), marker);
    try {
      await rename(target, backup);
      moved = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      await rename(staging, target);
    } catch (error) {
      if (moved) await rename(backup, target);
      moved = false;
      throw error;
    }
    if (moved) await rm(backup, { recursive: true, force: true });
    console.log(`draw.io ${version}: файлы подготовлены`);
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
}
