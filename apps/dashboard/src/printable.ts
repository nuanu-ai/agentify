/**
 * The account command's output and the process log, which is the only record of
 * who stopped a merchant's selling, both carry text somebody else wrote. A
 * terminal obeys some characters instead of showing them: an escape that clears
 * the line, a carriage return over the row above, a newline that starts a
 * forged line, a direction override. A key named with a newline and a plausible
 * sentence would otherwise write a second line into that record, in the
 * dashboard's voice.
 *
 * They are shown escaped rather than removed, so an odd value looks odd.
 * Anything already printable is left as it is, so a label in any alphabet reads
 * as itself.
 */
export const printable = (line: string): string =>
  line.replaceAll(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (found) => {
    const at = found.codePointAt(0) ?? 0;
    return at <= 0xff ? `\\x${at.toString(16).padStart(2, "0")}` : `\\u{${at.toString(16)}}`;
  });
