/**
 * What the chain says about a payment presented for an order already paid,
 * read and never written: whether a wallet accepts a signature no key
 * recovers to it, and whether an authorization has been used.
 */
export interface PaymentChain {
  /**
   * Whether `wallet` accepts `signature` over the 32-byte `digest`: a wallet
   * that is a contract answers for itself (ERC-1271), and one not deployed yet
   * is judged with the deployment wrapped around its signature (ERC-6492). It
   * throws when the chain could not be asked, which is not an answer.
   */
  accepts(wallet: string, digest: string, signature: string): Promise<boolean>;
  /**
   * Whether `token` has marked `wallet`'s authorization with `nonce` used or
   * cancelled (EIP-3009 `authorizationState`). It throws when the chain could
   * not be asked.
   */
  used(token: string, wallet: string, nonce: string): Promise<boolean>;
}
