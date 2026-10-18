import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Form, useNavigation, useRouteLoaderData } from "react-router";
import { DRAWN_FOR } from "../../src/drawn-for.js";

/** The press's button in a row, the way a keyboard reaches the next one. */
const PRESS = "form button";

/**
 * Where the focus goes once a press made with the focus in the form is
 * answered. The button takes no second press meanwhile, and the browser takes
 * the focus off a button that takes none, so the next Tab would start again
 * from the top of the page. It goes back to the form's button where the form
 * is still on the page; where the answer took the form's row out of the list,
 * a card paused while only the cards on sale are listed, to the row that took
 * its place, else the row before, else the list. Returns what the form calls
 * as it is sent.
 */
const useFocusKept = (form: RefObject<HTMLFormElement | null>, pending: boolean) => {
  const pressed = useRef(false);
  useEffect(() => {
    if (pending || !pressed.current) return;
    pressed.current = false;
    if (document.activeElement === document.body) {
      form.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    }
  }, [pending, form]);
  useLayoutEffect(() => {
    const held = form.current;
    return () => {
      if (held === null || !pressed.current) return;
      const row = held.closest("li");
      const list = row?.closest("ul") ?? null;
      const around: Element[] = [];
      for (let next = row?.nextElementSibling; next; next = next.nextElementSibling) {
        around.push(next);
      }
      for (
        let before = row?.previousElementSibling;
        before;
        before = before.previousElementSibling
      ) {
        around.push(before);
      }
      requestAnimationFrame(() => {
        if (held.isConnected || document.activeElement !== document.body) return;
        const to =
          around
            .filter((one) => one.isConnected)
            .map((one) => one.querySelector<HTMLElement>(PRESS))
            .find((one) => one !== null) ?? (list?.isConnected ? list : null);
        to?.focus({ preventScroll: true });
      });
    };
  }, [form]);
  return () => {
    pressed.current = form.current?.contains(document.activeElement) === true;
  };
};

/**
 * Every form behind the gate that posts: it carries the address its page was
 * drawn for, which the gate checks before anything reads the form, so a form
 * written without this component is refused rather than done for whoever is
 * signed in.
 *
 * `document` posts with a whole page load, for an action answered with a page
 * at its own address (the settings'); otherwise React Router sends it. `replace={false}` gives the answer a history
 * entry of its own even where it is drawn at the page's own address, so Back
 * returns to the page the press was made on. Either way it is an HTML form that
 * works with no script, and with script its button shows the press at once and
 * takes no second one until the page that answers it is drawn, so a page read
 * again after the press never shows the old state pressable; a page that
 * answers its own press keeps the person where they were on it.
 *
 * `autoComplete="off"` because Firefox restores a hidden field's old value on
 * reload, which would put the first address back into a page redrawn for
 * somebody else.
 */
export function PostForm({
  action,
  document = false,
  replace,
  className,
  children,
}: Readonly<{
  /** A path under the dashboard's prefix, without it. */
  action: string;
  document?: boolean;
  replace?: boolean;
  className?: string;
  children: (pending: boolean) => ReactNode;
}>) {
  const gate = useRouteLoaderData<{ who: string }>("routes/gate");
  if (gate === undefined) {
    throw new Error("a form that posts was drawn outside the gate, where no address is known");
  }
  const navigation = useNavigation();
  const [sent, setSent] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const pending =
    sent || (navigation.state !== "idle" && navigation.formAction?.endsWith(action) === true);
  const pressing = useFocusKept(form, pending);
  return (
    <Form
      ref={form}
      method="post"
      action={action}
      reloadDocument={document}
      preventScrollReset
      {...(replace === undefined ? {} : { replace })}
      className={className}
      onSubmit={() => {
        pressing();
        if (document) setSent(true);
      }}
    >
      <input type="hidden" name={DRAWN_FOR} value={gate.who} autoComplete="off" />
      {children(pending)}
    </Form>
  );
}
