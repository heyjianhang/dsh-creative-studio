export function templateImageSources(value: string) {
  const urls = [value];
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname === "cdn.jsdelivr.net") {
      const match = url.pathname.match(
        /^\/gh\/([\w.-]+)\/([\w.-]+)@([\w.-]+)\/(.+)$/,
      );
      if (match)
        urls.push(
          `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}/${match[4]}`,
        );
    }
  } catch {}
  return urls;
}
