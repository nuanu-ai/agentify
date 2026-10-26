/** The forty characters after `0x`, in groups of four. */
const groupsOf = (address: string): string[] => address.slice(2).match(/.{1,4}/g) ?? [];

/**
 * An address whole, never with the middle elided: first-few, dots, last-few is
 * the one presentation under which a wrong address and the right one look
 * identical. In groups of four as spans with nothing between them, so the gaps
 * are the stylesheet's and a copied address pastes as an address.
 */
export function Address({ address }: Readonly<{ address: string }>) {
  return (
    <span className="address">
      <span className="lead">{address.slice(0, 2)}</span>
      {groupsOf(address).map((group, at) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the groups of one address never reorder
        <span className="quad" key={at}>
          {group}
        </span>
      ))}
    </span>
  );
}
