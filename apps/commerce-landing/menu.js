// The phone and tablet menu: the burger opens the list of every masthead
// link; a chosen link, Escape, or growing back to the desktop width closes it.
const burger = document.querySelector(".masthead__burger");
const menu = document.getElementById("site-menu");

function setOpen(open) {
  menu.hidden = !open;
  burger.setAttribute("aria-expanded", String(open));
  burger.setAttribute("aria-label", open ? "Close menu" : "Open menu");
}

burger.addEventListener("click", () => setOpen(menu.hidden));
menu.addEventListener("click", (event) => {
  if (event.target.closest("a")) setOpen(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !menu.hidden) {
    setOpen(false);
    burger.focus();
  }
});
matchMedia("(min-width: 1001px)").addEventListener("change", (event) => {
  if (event.matches) setOpen(false);
});
