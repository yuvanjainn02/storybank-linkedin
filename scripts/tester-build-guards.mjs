import { existsSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';

/** Unassigned manifests can build for local QA, never identify a hosted target. */
export function assertTesterManifests(source, nested) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(source) || !object(nested)) throw new Error('Tester manifests must be objects.');
  for (const manifest of [source, nested]) {
    if (manifest.static || manifest.d1 !== 'DB' || manifest.r2 !== 'BUCKET') throw new Error('Tester requires its own Worker DB and BUCKET bindings.');
    if (Object.hasOwn(manifest, 'project_id') && (typeof manifest.project_id !== 'string' || !manifest.project_id.trim() || manifest.project_id !== manifest.project_id.trim())) throw new Error('Only a returned, nonempty Site project ID may be assigned.');
  }
  if (source.project_id !== nested.project_id) throw new Error('Root and hosted tester identities must agree.');
  return { registered: typeof source.project_id === 'string', projectId: source.project_id ?? null };
}

/** Fail rather than silently package old browser-global storage or runtime files. */
export function assertTesterPublicAssets(directory) {
  if (!existsSync(directory)) return;
  const walk = current => {
    for (const name of readdirSync(current)) {
      const target = path.join(current, name);
      const info = lstatSync(target);
      if (info.isSymbolicLink()) throw new Error('Public assets must not link outside the reviewed build tree.');
      if (/^(?:legacy|\.wrangler|\.sites-runtime|node_modules)$/i.test(name) || /^\.env(?:\.|$)/i.test(name) || /\.(?:pem|sqlite(?:-.*)?|db(?:-.*)?)$/i.test(name)) throw new Error('Tester public assets contain legacy or runtime-only files.');
      if (info.isDirectory()) walk(target);
    }
  };
  walk(directory);
}

export function assertTesterBuildOutput(directory) {
  const allowed = new Set(['server', 'client', '.openai']);
  for (const name of readdirSync(directory)) {
    if (!allowed.has(name)) throw new Error('Tester archive output includes unexpected root assets.');
  }
  for (const name of allowed) if (!lstatSync(path.join(directory, name)).isDirectory()) throw new Error('Tester Worker output is incomplete.');
  assertTesterPublicAssets(path.join(directory, 'client'));
}
