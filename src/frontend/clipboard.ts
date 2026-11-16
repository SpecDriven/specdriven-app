/**
 * Text onto the clipboard, false when neither way works. navigator.clipboard
 * needs a secure context and permission — absent e.g. on a plain-http LAN
 * host — so a selection-based copy stands in for it there.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/**
 * Text that is still on its way (a fetch) onto the clipboard, false when it
 * cannot be copied; a failure of the text itself is thrown. Call it in the
 * click's own turn, before any await: Safari copies only during the click,
 * and a ClipboardItem made then may wait for its text. Where there is no
 * ClipboardItem the text is awaited and copied like copyText.
 */
export async function copyWhenReady(text: Promise<string>): Promise<boolean> {
  const Item = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
  if (Item && typeof navigator !== "undefined" && navigator.clipboard?.write) {
    const blob = text.then((t) => new Blob([t], { type: "text/plain" }));
    // Its failure is the text's, rethrown below; not an unhandled one here.
    blob.catch(() => undefined);
    try {
      await navigator.clipboard.write([new Item({ "text/plain": blob })]);
      return true;
    } catch {
      // The text failed (thrown below), or this browser refused the write.
    }
  }
  return copyText(await text);
}
