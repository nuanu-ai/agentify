export type FirstPartyImageRole =
  | "commerce-app"
  | "commerce-web"
  | "scanner-web"
  | "scanner-worker"
  | "scanner-privacy";

export type InfrastructureImageRole = "postgres" | "caddy" | "alpine";

export interface ReleaseManifest {
  schemaVersion: 1;
  repository: "nuanu-ai/agentify";
  revision: string;
  configuration: {
    archive: string;
    sha256: string;
  };
  images: {
    firstParty: Record<FirstPartyImageRole, string>;
    infrastructure: Record<InfrastructureImageRole, string>;
  };
}

export interface ReleaseManifestInput {
  repository: string;
  revision: string;
  archive: string;
  firstParty: Record<FirstPartyImageRole, string>;
  infrastructure: Record<InfrastructureImageRole, string>;
}

export interface ReleaseTopologyService {
  image: string;
  command?: string | readonly string[] | null;
  build?: unknown;
}

export interface ReleaseTopology {
  commerce: Record<string, ReleaseTopologyService>;
  scanner: Record<string, ReleaseTopologyService>;
}

export function sha256Of(bytes: Uint8Array): string;
export function createReleaseManifest(input: ReleaseManifestInput): ReleaseManifest;
export function problemsWithReleaseManifest(
  manifest: unknown,
  actualArchiveSha256?: string,
): string[];
export function problemsWithReleaseTopology(
  testTopology: unknown,
  productionTopology: unknown,
  manifest: unknown,
): string[];
