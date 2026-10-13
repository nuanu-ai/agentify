const LEFT = "M50 40 H40 A6 6 0 0 0 34 46 V82 A6 6 0 0 0 40 88 H50";
const RIGHT = "M78 40 H88 A6 6 0 0 1 94 46 V82 A6 6 0 0 1 88 88 H78";

/**
 * The mark, drawn in the page rather than fetched, so it shows on a surface
 * that serves no shared files and inside a picture drawn on the server. It is
 * decoration: whatever it stands beside names the brand.
 */
export function BrandMark({ className, size }: Readonly<{ className?: string; size?: number }>) {
  return (
    <svg
      aria-hidden
      className={className}
      data-agentify-mark="standard"
      fill="none"
      focusable="false"
      height={size}
      viewBox="0 0 128 128"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect fill="#0F736E" height="128" rx={30} width="128" />
      <path d={LEFT} fill="none" stroke="#F6F4EF" strokeLinecap="round" strokeWidth={7} />
      <path d={RIGHT} fill="none" stroke="#F6F4EF" strokeLinecap="round" strokeWidth={7} />
      <circle cx="64" cy="64" fill="#F6F4EF" r={10} />
    </svg>
  );
}
