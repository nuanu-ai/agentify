// Lets Node's own type stripping run the repository's TypeScript, whose
// imports name the compiled `.js` file.
import { register } from "node:module";

register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (specifier.endsWith(".js") && context.parentURL?.endsWith(".ts")) {
      return next(specifier.slice(0, -3) + ".ts", context);
    }
    throw error;
  }
}`)}`,
);
