import { errorResponse } from "../../../../lib/server/http";
import { methods } from "../../../../lib/server/methods";

function upgraded(request: Request): Response {
  return errorResponse(
    request,
    426,
    "registration_contract_upgraded",
    "Use the version 2 registration endpoint, with an email address and, if you like, a phone number.",
  );
}

export const loader = methods({ POST: upgraded });
export const action = loader;
