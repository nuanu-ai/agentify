/** The cabinet-owned identity seam used by the private production operator. */
export type ApprovalDirectoryEntry =
  | { readonly email: string; readonly binding: "unbound" | "partial" }
  | { readonly email: string; readonly binding: "bound"; readonly merchantId: string };

export interface ApprovalDirectory {
  resolve(rawEmail: string): Promise<readonly ApprovalDirectoryEntry[]>;
}

/** The only gateway authority the private operator receives. */
export interface LiveApprovalPort {
  grant(merchantId: string): Promise<{
    readonly changed: boolean;
    readonly merchant: {
      readonly id: string;
      readonly serviceName: string | null;
      readonly liveApprovedAt: number;
    };
  } | null>;
}

export interface ApprovalTerminal {
  readonly say: (line: string) => void;
}

/** Red-phase application seam. The behavior tests define the implementation. */
export async function runApproval(
  rawEmail: string,
  directory: ApprovalDirectory,
  gateway: LiveApprovalPort,
  terminal: ApprovalTerminal,
): Promise<number> {
  void rawEmail;
  void directory;
  void gateway;
  terminal.say("PRODUCTION approval is not implemented.");
  return 1;
}
