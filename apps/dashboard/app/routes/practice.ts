import { type LoaderFunctionArgs, redirectDocument } from "react-router";
import { services, signedIn, visit } from "../services.js";

export async function loader({ context }: LoaderFunctionArgs) {
  if (context.get(visit)) await context.get(services).practice(context.get(signedIn));
  return redirectDocument("/docs/#how-to-start");
}
