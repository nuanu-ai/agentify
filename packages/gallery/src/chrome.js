/*
 * The gallery's script: each state's frame is composed here from the shared
 * fonts, its surface's stylesheet and its own markup, as the frame scrolls
 * near; the chosen width sets every frame's own width, so a screen's media
 * queries answer as on that device, and a window narrower than that scales
 * the frame down rather than narrowing it. Nothing inside a frame goes
 * anywhere: links are held and forms are not sent.
 */

(() => {
  const DEVICES = {
    phone: { width: 390, height: 844 },
    tablet: { width: 768, height: 1024 },
    desktop: { width: 1440, height: 900 },
  };
  const REMEMBERED = "agentify-gallery-device";

  const gallery = document.querySelector(".gallery");
  const data = JSON.parse(document.getElementById("gallery-data").textContent);
  const fonts = document.getElementById("gallery-fonts").textContent;
  const frames = [...document.querySelectorAll(".gallery-frame")];

  const remembered = () => {
    try {
      return localStorage.getItem(REMEMBERED);
    } catch {
      return null;
    }
  };
  const remember = (name) => {
    try {
      localStorage.setItem(REMEMBERED, name);
    } catch {
      // A viewer whose browser keeps nothing chooses again next time.
    }
  };

  let device = Object.hasOwn(DEVICES, remembered())
    ? remembered()
    : window.innerWidth < DEVICES.tablet.width
      ? "phone"
      : "desktop";

  // The doctype keeps the frame out of quirks mode. It is written in two parts
  // so the published file holds no document markup of its own, which its host
  // adds; the parser supplies the rest of the frame's document.
  const documentOf = (state) =>
    `<!${"doctype"} html><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<style>${fonts}</style><style>${data.css[state.surface]}</style>${state.html}`;

  /** The frame's document runs no script of its own, so it is held from here. */
  const hold = (inside) => {
    inside.addEventListener(
      "click",
      (event) => {
        const target = event.target;
        if (typeof target?.closest === "function" && target.closest("a[href], area[href]")) {
          event.preventDefault();
        }
      },
      true,
    );
    inside.addEventListener("submit", (event) => event.preventDefault(), true);
  };

  const size = (frame) => {
    const { width, height } = DEVICES[device];
    const scale = Math.min(1, frame.clientWidth / width);
    frame.style.height = `${Math.round(height * scale)}px`;
    const iframe = frame.querySelector("iframe");
    if (iframe !== null) {
      iframe.style.width = `${width}px`;
      iframe.style.height = `${height}px`;
      iframe.style.transform = scale === 1 ? "" : `scale(${scale})`;
    }
  };

  const open = (frame) => {
    const id = frame.dataset.state;
    const iframe = document.createElement("iframe");
    iframe.title = `The screen in state ${id}`;
    iframe.setAttribute("sandbox", "allow-same-origin");
    iframe.addEventListener("load", () => {
      if (iframe.contentDocument !== null) hold(iframe.contentDocument);
    });
    iframe.srcdoc = documentOf(data.states[id]);
    frame.replaceChildren(iframe);
    size(frame);
  };

  const choose = (name) => {
    device = name;
    gallery.dataset.device = name;
    gallery.style.setProperty("--g-device-width", `${DEVICES[name].width}px`);
    for (const button of document.querySelectorAll(".gallery-widths button")) {
      button.setAttribute("aria-pressed", String(button.value === name));
    }
    for (const frame of frames) size(frame);
  };

  const states = [...document.querySelectorAll(".gallery-state")];

  /**
   * The state being read: the last whose top has reached the line a jump to a
   * state puts its top on, just under the bar. A state shorter than the window
   * leaves the next one in view below it, so "in view" would name the wrong one.
   */
  const reading = () => {
    const line = Number.parseFloat(getComputedStyle(states[0]).scrollMarginTop) + 8;
    return states.findLast((state) => state.getBoundingClientRect().top <= line) ?? states[0];
  };

  for (const button of document.querySelectorAll(".gallery-widths button")) {
    button.addEventListener("click", () => {
      const place = reading();
      choose(button.value);
      remember(button.value);
      place?.scrollIntoView({ block: "start", behavior: "instant" });
    });
  }

  const toggle = document.querySelector(".gallery-nav-toggle");
  const nav = document.getElementById("gallery-nav");
  const showNav = (shown) => {
    gallery.classList.toggle("nav-open", shown);
    toggle.setAttribute("aria-expanded", String(shown));
  };
  toggle.addEventListener("click", () => showNav(!gallery.classList.contains("nav-open")));
  nav.addEventListener("click", (event) => {
    if (event.target.closest("a") !== null) showNav(false);
  });

  const near = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        near.unobserve(entry.target);
        open(entry.target);
      }
    },
    { rootMargin: "1200px 0px" },
  );

  const links = new Map(
    [...nav.querySelectorAll("a[href^='#']")].map((link) => [link.hash.slice(1), link]),
  );
  const mark = (id) => {
    const link = links.get(id);
    if (link === undefined || link.getAttribute("aria-current") === "true") return;
    for (const other of links.values()) other.removeAttribute("aria-current");
    link.setAttribute("aria-current", "true");
    // The list scrolls on its own beside the page, so the state being read
    // is kept in its view; a scroll of the page itself would lose the place.
    const top = link.offsetTop - nav.scrollTop;
    if (top < 0 || top > nav.clientHeight - link.offsetHeight) {
      nav.scrollTop = link.offsetTop - nav.clientHeight / 3;
    }
  };

  // A state chosen from the list stays marked until the reader scrolls on
  // their own: the last states cannot reach the top of a page that ends.
  let chosen = false;
  nav.addEventListener("click", (event) => {
    const link = event.target.closest("a[href^='#']");
    if (link === null) return;
    chosen = true;
    mark(link.hash.slice(1));
  });
  for (const own of ["wheel", "touchmove", "keydown", "pointerdown"]) {
    window.addEventListener(own, () => {
      chosen = false;
    });
  }
  let pending = false;
  window.addEventListener(
    "scroll",
    () => {
      if (chosen || pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        mark(reading().id);
      });
    },
    { passive: true },
  );

  choose(device);
  for (const frame of frames) near.observe(frame);
  new ResizeObserver(() => {
    for (const frame of frames) size(frame);
  }).observe(document.querySelector(".gallery-main"));

  // The frames above an opened state have their heights only now.
  const asked = decodeURIComponent(location.hash.slice(1));
  const opened = asked === "" ? null : document.getElementById(asked);
  if (opened !== null) {
    chosen = true;
    opened.scrollIntoView({ block: "start" });
  }
  mark(opened?.id ?? reading().id);
})();
