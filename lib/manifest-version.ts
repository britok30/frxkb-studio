/** Bumped when the bundle/manifest shape changes incompatibly.
 *  Shared between server (lib/projects.ts re-exports as MANIFEST_VERSION) and
 *  client (lib/zip-bundle.ts uses MANIFEST_VERSION_CLIENT). */
export const MANIFEST_VERSION_CLIENT = 2;
