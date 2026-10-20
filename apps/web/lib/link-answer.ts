/** The remaining wait on a button, in the unit a person reads at a glance. */
export function waitLabel(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)}m`;
}
