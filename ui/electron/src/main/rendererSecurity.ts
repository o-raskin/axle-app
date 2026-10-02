/** Only the application document may use the desktop preload capabilities. */
export function isTrustedRendererUrl(value: string, rendererUrl: string): boolean {
  try {
    const candidate = new URL(value);
    const expected = new URL(rendererUrl);
    return !candidate.username && !candidate.password
      && candidate.protocol === expected.protocol
      && candidate.host === expected.host
      && candidate.pathname === expected.pathname
      && candidate.search === expected.search;
  } catch {
    return false;
  }
}

/** OS protocol handlers must never receive renderer supplied file or command URLs. */
export function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

type RendererContents = { mainFrame: unknown };
type RendererEvent = { sender: unknown; senderFrame: { url: string } | null };

export function assertTrustedRenderer(
  event: RendererEvent,
  contents: RendererContents | null,
  rendererUrl: string
): void {
  if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame
    || !event.senderFrame || !isTrustedRendererUrl(event.senderFrame.url, rendererUrl)) {
    throw new Error("Desktop IPC is only available to the application renderer");
  }
}
