/**
 * Copy shared type definitions to the web client.
 * Run via: npm run sync:types
 */

import { copyFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const src = resolve(root, 'src/shared/protocol.types.ts');
const dest = resolve(root, 'web/src/lib/shared-protocol.types.ts');

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);

console.log('Synced shared protocol types → web/src/lib/shared-protocol.types.ts');
