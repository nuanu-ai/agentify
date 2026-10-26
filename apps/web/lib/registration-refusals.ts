/**
 * How the report request is refused when a field the person fills in is
 * wrong: each such field has its own code and words, so the form can show the
 * refusal at the field it names. A refusal of anything else carries the
 * general code, since the form never sends that wrong and the person cannot
 * fix it there.
 */

export const REGISTRATION_FIELD_REFUSALS = {
  email: {
    code: "invalid_email",
    message: "Enter the email address the report link should go to, such as name@example.com.",
  },
  phone: {
    code: "invalid_phone",
    message:
      "Give the phone with its country code, such as +1 415 555 0123: a plus and 8 to 15 digits. Or leave it empty.",
  },
  dataset_reuse_acknowledged: {
    code: "data_notice_unacknowledged",
    message: "Tick the box that acknowledges the scanner data notice to ask for the report.",
  },
} as const;

export type RegistrationField = keyof typeof REGISTRATION_FIELD_REFUSALS;

const FIELDS = Object.keys(REGISTRATION_FIELD_REFUSALS) as RegistrationField[];

const isField = (value: unknown): value is RegistrationField =>
  FIELDS.some((field) => field === value);

const GENERAL_REGISTRATION_REFUSAL = {
  code: "invalid_registration",
  message: "This ask could not be read. Reload the page and ask again.",
} as const;

/**
 * The refusal for an ask's problems: the general one when any of them lies
 * outside the fields a person fills in, and otherwise the first such field's.
 */
export function registrationRefusal(
  problems: readonly Readonly<{ path: readonly PropertyKey[] }>[],
): Readonly<{ code: string; message: string }> {
  const named = problems.map(({ path }) => path[0]);
  const field = FIELDS.find((one) => named.includes(one));
  if (field === undefined || named.some((key) => !isField(key)))
    return GENERAL_REGISTRATION_REFUSAL;
  return REGISTRATION_FIELD_REFUSALS[field];
}

/** The field a refusal's code names, if it names one. */
export function refusedField(code: string): RegistrationField | undefined {
  return FIELDS.find((field) => REGISTRATION_FIELD_REFUSALS[field].code === code);
}
