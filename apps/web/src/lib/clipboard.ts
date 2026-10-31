/**
 * Copy to the clipboard, or say honestly that it did not work.
 *
 * Inside the preview's iframe the document is served under a `permissions-policy` that blocks
 * `clipboard-write`, so `navigator.clipboard.writeText()` rejects with `NotAllowedError`. The old
 * `document.execCommand('copy')` path exists for that case, but it is deprecated and some browsers
 * apply the same policy to it — hence a boolean rather than a thrown error, so the caller can show the
 * link and tell the person to select it.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}
