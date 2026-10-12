import { type ReactNode, useState } from "react";
import { Form, useNavigation, useRouteLoaderData } from "react-router";
import { DRAWN_FOR } from "../../src/drawn-for.js";

/**
 * Every form behind the gate that posts: it carries the address its page was
 * drawn for, which the gate checks before anything reads the form, so a form
 * written without this component is refused rather than done for whoever is
 * signed in.
 *
 * `document` posts with a whole page load, for an action still served by a
 * string page or one answered with a page at its own address (the settings');
 * otherwise React Router sends it. Either way it is an HTML form that works
 * with no script, and with script its button shows the press at once and takes
 * no second one until the page that answers it is drawn, so a page read again
 * after the press never shows the old state pressable; a page that answers its
 * own press keeps the person where they were on it.
 *
 * `autoComplete="off"` because Firefox restores a hidden field's old value on
 * reload, which would put the first address back into a page redrawn for
 * somebody else.
 */
export function PostForm({
  action,
  document = false,
  className,
  children,
}: Readonly<{
  /** A path under the dashboard's prefix, without it. */
  action: string;
  document?: boolean;
  className?: string;
  children: (pending: boolean) => ReactNode;
}>) {
  const gate = useRouteLoaderData<{ who: string }>("routes/gate");
  if (gate === undefined) {
    throw new Error("a form that posts was drawn outside the gate, where no address is known");
  }
  const navigation = useNavigation();
  const [sent, setSent] = useState(false);
  const pending =
    sent || (navigation.state !== "idle" && navigation.formAction?.endsWith(action) === true);
  return (
    <Form
      method="post"
      action={action}
      reloadDocument={document}
      preventScrollReset
      className={className}
      onSubmit={document ? () => setSent(true) : undefined}
    >
      <input type="hidden" name={DRAWN_FOR} value={gate.who} autoComplete="off" />
      {children(pending)}
    </Form>
  );
}
