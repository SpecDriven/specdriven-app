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
