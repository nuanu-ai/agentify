/**
 * Asks the browser to download `url` as a file. The page learns nothing of
 * what follows: whether the file arrived is the browser's to show.
 */
export function askBrowserToDownload(url: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "";
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
