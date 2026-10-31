/** Observe the stored job; refresh its result and connection state without disturbing forms. */
const observer = document.querySelector("[data-shop-job-observer]");
if (observer) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const pair = `agentify_zone=${encodeURIComponent(zone)}`;
  let zoneChanged = Boolean(zone) && !document.cookie.split("; ").includes(pair);
  if (zoneChanged) {
    // biome-ignore lint/suspicious/noDocumentCookie: this native page also names its zone for the server.
    document.cookie = `${pair}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
  }
  const page = observer.dataset.shopJobObserver + location.search;
  const endpoint = `${observer.dataset.shopJobObserver}/shop-job${location.search}`;
  const unread = observer.querySelector("[data-shop-job-unread]");
  const connection = document.querySelector("[data-shop-job-connection]");
  let result = observer.querySelector("[data-shop-job-result]");
  let key = observer.dataset.shopJobKey;
  let markup = result.innerHTML;
  let paused = false;
  let generation = 0;
  let timer;
  let controller;
  const read = async () => {
    const turn = generation;
    const current = () => !paused && generation === turn;
    const request = new AbortController();
    controller = request;
    const timeout = setTimeout(() => request.abort(), 10000);
    let delay = 1000;
    const fetchRead = async (address) => {
      const response = await fetch(address, {
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: request.signal,
      });
      if (!response.ok) throw new Error("unread");
      return response;
    };
    try {
      const job = await (await fetchRead(endpoint)).json();
      const nextKey = JSON.stringify(job === null ? null : [job.id, job.revision, job.current]);
      if (nextKey !== key || zoneChanged) {
        // shortcut: active revisions reread the bounded operator page; use a narrow HTML projection if pilot load warrants it.
        const html = await (await fetchRead(page)).text();
        const nextPage = new DOMParser().parseFromString(html, "text/html");
        const next = nextPage.querySelector("[data-shop-job-observer]");
        const nextResult = next?.querySelector("[data-shop-job-result]");
        const nextConnection = nextPage.querySelector("[data-shop-job-connection]");
        if (!nextResult || !next.dataset.shopJobKey || !connection || !nextConnection)
          throw new Error("unread");
        if (!current()) return;
        if (nextResult.innerHTML !== markup) {
          result.replaceWith(nextResult);
          result = nextResult;
          markup = nextResult.innerHTML;
        }
        if (connection.innerHTML !== nextConnection.innerHTML)
          connection.innerHTML = nextConnection.innerHTML;
        key = next.dataset.shopJobKey;
        observer.dataset.shopJobKey = key;
        zoneChanged = false;
      }
      if (current()) unread.hidden = true;
      delay = job === null || job.status === "queued" || job.status === "running" ? 1000 : 5000;
    } catch {
      if (current()) unread.hidden = false;
    } finally {
      clearTimeout(timeout);
      if (current()) timer = setTimeout(read, delay);
    }
  };
  addEventListener("pagehide", () => {
    paused = true;
    generation++;
    clearTimeout(timer);
    controller?.abort();
  });
  addEventListener("pageshow", (event) => {
    if (event.persisted && paused) {
      paused = false;
      void read();
    }
  });
  void read();
}
