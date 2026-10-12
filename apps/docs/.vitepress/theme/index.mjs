// The default VitePress theme with the site's palette (agentify.css maps the
// theme's variables onto the shared tokens). No component or layout is
// overridden, so an upgrade has one stylesheet to disagree with.
//
// The one addition is a plain link back to the site. The documentation is
// mounted at /docs, so the theme's own title link leads to the docs' front
// page, not the site's. It sits in `nav-bar-content-before` because the slots
// at the title render inside the title's anchor, and a link inside a link
// takes the outer anchor's click.

import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import "./agentify.css";

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      "nav-bar-content-before": () =>
        h(
          "a",
          {
            class: "way-out",
            href: "/",
            // Without a target, VitePress's router intercepts this same-origin
            // link and, knowing only /docs, goes nowhere. `_self`, not `_blank`:
            // leaving the documentation is going back.
            target: "_self",
            // Not `aria-label`: the visible text is the label, and a screen
            // reader would read the longer one instead.
            title: "The Agentify site",
          },
          [
            h("img", {
              class: "brand-mark",
              "aria-hidden": "true",
              src: "/assets/agentify-mark.svg",
              alt: "",
              width: 24,
              height: 24,
            }),
            "Agentify",
          ],
        ),
    });
  },
};
