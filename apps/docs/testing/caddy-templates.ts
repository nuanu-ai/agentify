/**
 * Caddy's templates as the documentation writes them, filled the way Caddy's
 * `templates` directive fills them from its environment, for whatever stands
 * in for Caddy: the browser tests' edge, the speed budget's and the gallery.
 * Only the forms the documentation writes are understood: `env` with a
 * variable's name, piped through `html` or not, and `if`, `else if`, `else`
 * and `end` on `eq` or `ne` of a variable and a word. Any other template is
 * refused, so a template this does not know cannot pass for a filled one.
 */

export type Environment = Readonly<Record<string, string>>;

const ACTION = /<!--\{\{(.*?)\}\}-->/gs;
const NAME = /^(?:`([^`]*)`|"([^"]*)")$/;

/** As Go's `html` function escapes a value. */
const goHtml = (value: string): string =>
  value
    .replaceAll("\u0000", "�")
    .replaceAll("&", "&amp;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&#34;");

const nameOf = (written: string): string => {
  const found = NAME.exec(written.trim());
  if (found === null) throw new Error(`a template names a variable as ${written}`);
  return found[1] ?? found[2] ?? "";
};

const filledValue = (action: string, environment: Environment): string => {
  const found = /^env\s+(\S+)(\s*\|\s*html)?$/.exec(action.trim());
  if (found === null) throw new Error(`a template this stand-in does not know: ${action}`);
  const value = environment[nameOf(found[1] ?? "")] ?? "";
  return found[2] === undefined ? value : goHtml(value);
};

const holds = (condition: string, environment: Environment): boolean => {
  const found = /^(eq|ne)\s+\(env\s+(\S+)\)\s+"([^"]*)"$/.exec(condition.trim());
  if (found === null) throw new Error(`a condition this stand-in does not know: ${condition}`);
  const equal = (environment[nameOf(found[2] ?? "")] ?? "") === found[3];
  return found[1] === "eq" ? equal : !equal;
};

type Branch = { shown: boolean; taken: boolean; outer: boolean };

/** `text` with every template filled from `environment`. */
export function fillTemplates(text: string, environment: Environment): string {
  const branches: Branch[] = [];
  const showing = (): boolean => branches.every((branch) => branch.shown);
  let filled = "";
  let from = 0;
  for (const found of text.matchAll(ACTION)) {
    const at = found.index ?? 0;
    if (showing()) filled += text.slice(from, at);
    from = at + found[0].length;
    const action = (found[1] ?? "").trim();
    const branch = branches.at(-1);
    if (action.startsWith("if ")) {
      const outer = showing();
      const shown = outer && holds(action.slice(3), environment);
      branches.push({ shown, taken: shown, outer });
    } else if (action.startsWith("else if ")) {
      if (branch === undefined) throw new Error("an else with no if");
      branch.shown = branch.outer && !branch.taken && holds(action.slice(8), environment);
      branch.taken ||= branch.shown;
    } else if (action === "else") {
      if (branch === undefined) throw new Error("an else with no if");
      branch.shown = branch.outer && !branch.taken;
      branch.taken = true;
    } else if (action === "end") {
      if (branches.pop() === undefined) throw new Error("an end with no if");
    } else if (showing()) {
      filled += filledValue(action, environment);
    } else {
      filledValue(action, environment);
    }
  }
  if (branches.length > 0) throw new Error("an if with no end");
  return filled + text.slice(from);
}
