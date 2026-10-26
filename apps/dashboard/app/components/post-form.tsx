import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Form, useHref, useLocation, useNavigation, useRouteLoaderData } from "react-router";
import { ANSWER_WITHIN_MS } from "../../src/deadlines.js";
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

/** How long a whole-page press waits before it says it is still waiting. */
const STILL_WAITING_AFTER_MS = 3_000;

/**
 * A press sent as a whole page load. The browser carries it out and tells the
 * page nothing when the load is stopped, by the toolbar, by Escape, or on a
 * phone, and a second press of a form unlocked then could send the change
 * twice. So the form stays locked until the next page is drawn. A few seconds
 * on it says it is still waiting. Once the server's own deadline for the press
 * has passed, it says the change cannot be confirmed, with a read of the page
 * as the way to see where it stands; said sooner, it would send the person to
 * look while the change was still being made. A page the browser brings back
 * from its cache after the press is a page as it was before it.
 */
const useWholeLoad = (answeredWithinMs: number) => {
  const [stage, setStage] = useState<"idle" | "sending" | "waiting" | "unconfirmed">("idle");
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) setStage("idle");
    };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, []);
  const pressed = stage !== "idle";
  useEffect(() => {
    if (!pressed) return;
    const still = setTimeout(() => setStage("waiting"), STILL_WAITING_AFTER_MS);
    const late = setTimeout(
      () => setStage("unconfirmed"),
      answeredWithinMs + STILL_WAITING_AFTER_MS,
    );
    return () => {
      clearTimeout(still);
      clearTimeout(late);
    };
  }, [pressed, answeredWithinMs]);
  return { stage, send: () => setStage("sending") };
};

/** Fields a person types into, which stay focusable while locked. */
const TYPED =
  "textarea, input:not([type='hidden'], [type='submit'], [type='button'], [type='reset'], [type='image'], [type='checkbox'], [type='radio'], [type='file'], [type='range'], [type='color'])";

/** Fields a person chooses with, which only `disabled` holds still. */
const CHOSEN =
  "select, input[type='checkbox'], input[type='radio'], input[type='file'], input[type='range'], input[type='color']";

/**
 * The form's fields take no input while its press is on its way, so nothing
 * typed meanwhile is lost when the answer is drawn from what was saved. A box
 * is made read-only, which keeps the focus where it was; a choice is
 * disabled. The lock waits a task after the press, because the browser reads
 * a whole-page form after the submit event and leaves out any field disabled
 * by then.
 */
const useFieldsLocked = (form: RefObject<HTMLFormElement | null>, pending: boolean) => {
  useEffect(() => {
    if (!pending) return;
    const undo: (() => void)[] = [];
    const lock = setTimeout(() => {
      const held = form.current;
      if (held === null) return;
      for (const box of held.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(TYPED)) {
        if (box.readOnly) continue;
        box.readOnly = true;
        undo.push(() => {
          box.readOnly = false;
        });
      }
      for (const choice of held.querySelectorAll<HTMLInputElement | HTMLSelectElement>(CHOSEN)) {
        if (choice.disabled) continue;
        choice.disabled = true;
        undo.push(() => {
          choice.disabled = false;
        });
      }
    });
    return () => {
      clearTimeout(lock);
      for (const one of undo) one();
    };
  }, [pending, form]);
};

/**
 * Every form behind the gate that posts: it carries the address its page was
 * drawn for, which the gate checks before anything reads the form, so a form
 * written without this component is refused rather than done for whoever is
 * signed in.
 *
 * `document` posts with a whole page load, for an action answered with a page
 * at its own address (the settings'); otherwise React Router sends it.
 * `replace={false}` gives the answer a history entry of its own even where it
 * is drawn at the page's own address, so Back returns to the page the press
 * was made on. Either way it is an HTML form that works with no script. With
 * script, its fields and button are locked from the press until the page that
 * answers it is drawn, so a page read again after the press never shows the
 * old state pressable; a page that answers its own press keeps the person
 * where they were on it. A whole-page press with no answer says it is still
 * waiting, and once the server's deadline has passed that the change cannot be
 * confirmed, with a read of this page; the form stays locked. Only the person
 * sends a press again.
 *
 * `autoComplete="off"` because Firefox restores a hidden field's old value on
 * reload, which would put the first address back into a page redrawn for
 * somebody else.
 */
export function PostForm({
  action,
  document = false,
  answeredWithinMs = ANSWER_WITHIN_MS,
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
  /**
   * The server's longest wait for this press's answer, for a whole-page press:
   * by default one gateway call's deadline, so a press that makes several calls
   * in a row passes their sum.
   */
  answeredWithinMs?: number;
}>) {
  const gate = useRouteLoaderData<{ who: string }>("routes/gate");
  if (gate === undefined) {
    throw new Error("a form that posts was drawn outside the gate, where no address is known");
  }
  const navigation = useNavigation();
  const whole = useWholeLoad(answeredWithinMs);
  const location = useLocation();
  const here = useHref(`${location.pathname}${location.search}`);
  const form = useRef<HTMLFormElement>(null);
  const pending = document
    ? whole.stage !== "idle"
    : navigation.state !== "idle" && navigation.formAction?.endsWith(action) === true;
  const pressing = useFocusKept(form, pending);
  useFieldsLocked(form, pending);
  return (
    <Form
      ref={form}
      method="post"
      action={action}
      reloadDocument={document}
      preventScrollReset
      {...(replace === undefined ? {} : { replace })}
      className={className}
      aria-busy={pending ? true : undefined}
      onSubmit={() => {
        pressing();
        if (document) whole.send();
      }}
    >
      <input type="hidden" name={DRAWN_FOR} value={gate.who} autoComplete="off" />
      {children(pending)}
      {whole.stage === "waiting" ? <p role="status">Still waiting for an answer…</p> : null}
      {whole.stage === "unconfirmed" ? (
        <p role="status">
          We could not confirm whether your change was made. <a href={here}>Open this page again</a>{" "}
          to see where it stands; this sends nothing again.
        </p>
      ) : null}
    </Form>
  );
}
