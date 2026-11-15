/** Bind the local compiler to the current ACTVERO public type artifacts. */
import { cp, mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root = resolve(process.argv[2] ?? '../../..');
const source = join(root, 'packages/actvero/capability-ui');
const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
if (manifest.name !== '@actvero/dsh-capability-ui' || manifest.version !== '0.1.0') throw new Error('请选择此工作台支持的 ACTVERO 源码工具链');
await readFile(join(source, 'lib/types/contracts.d.ts'));
const target = resolve('node_modules/@actvero/dsh-capability-ui');
await mkdir(target, { recursive: true });
await cp(join(source, 'lib'), join(target, 'lib'), { recursive: true });
await cp(join(source, 'package.json'), join(target, 'package.json'));
console.log(`Bound ${manifest.name}@${manifest.version} types from ${source}`);
