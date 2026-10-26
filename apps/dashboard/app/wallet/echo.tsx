import { useEffect, useState } from "react";
import { Address } from "./address.js";

/**
 * What the wallet box holds, under it in groups of four, so a pasted address
 * can be checked against the wallet a group at a time before it is saved; a
 * box shows it in one run, and on a narrow screen only part of it. The server
 * draws it for an address just refused; where the page's script runs, it
 * follows the box as it is typed into or filled.
 */
export function WalletEcho({
  box,
  initial,
  className,
}: Readonly<{ box: string; initial: string; className?: string }>) {
  const [shown, setShown] = useState(initial);
  useEffect(() => {
    const field = document.getElementById(box);
    if (!(field instanceof HTMLInputElement)) return;
    const follow = () => setShown(field.value.trim());
    field.addEventListener("input", follow);
    return () => field.removeEventListener("input", follow);
  }, [box]);
  return shown === "" ? null : (
    <p className={className} id={`${box}-entered`}>
      You entered <Address address={shown} />
    </p>
  );
}
