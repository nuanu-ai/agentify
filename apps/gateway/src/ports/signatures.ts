/**
 * The chain's word on a signature no key recovers to its wallet. A wallet that
 * is a contract answers for itself (ERC-1271), and one not deployed yet is
 * judged with the deployment wrapped around its signature (ERC-6492). Nothing
 * here submits a transaction.
 */
export interface SignatureReader {
  /**
   * Whether `wallet` accepts `signature` over the 32-byte `digest`. It throws
   * when the chain could not be asked, which is not an answer about the
   * signature.
   */
  accepts(wallet: string, digest: string, signature: string): Promise<boolean>;
}
