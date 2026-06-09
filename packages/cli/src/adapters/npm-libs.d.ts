/**
 * Minimal ambient types for the npm-internal libraries the adapter installer
 * uses. Neither ships its own declarations, and we only touch a tiny, stable
 * surface — declaring just that keeps `strict` happy without pulling `any`
 * across the install path. See packages/cli/src/adapters/installer.ts.
 */
declare module '@npmcli/arborist' {
  interface ArboristOptions {
    /** Project dir to install into; reify writes `<path>/node_modules`. */
    readonly path: string;
    /** Skip lifecycle scripts (install/postinstall). We always pass true. */
    readonly ignoreScripts?: boolean;
    /** Override the registry; omitted means the npm default. */
    readonly registry?: string;
    /** cacache directory; omitted means npm's default (~/.npm/_cacache). */
    readonly cache?: string;
  }
  interface ReifyOptions {
    /** Package specs to add, e.g. `"pkg@1.2.3"`. */
    readonly add?: readonly string[];
    readonly rm?: readonly string[];
  }
  export default class Arborist {
    constructor(options: ArboristOptions);
    reify(options?: ReifyOptions): Promise<unknown>;
  }
}

declare module 'pacote' {
  interface PacoteOptions {
    readonly fullMetadata?: boolean;
    readonly registry?: string;
  }
  interface Manifest {
    readonly name: string;
    readonly version: string;
  }
  interface Packument {
    readonly versions: Readonly<Record<string, unknown>>;
    readonly 'dist-tags': Readonly<Record<string, string>>;
  }
  export function manifest(spec: string, options?: PacoteOptions): Promise<Manifest>;
  export function packument(spec: string, options?: PacoteOptions): Promise<Packument>;
}
