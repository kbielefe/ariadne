// Host / Origin helpers for the DNS-rebinding guard (localhost and tunnel hostnames).

/** Origin may be http or https against an allowed Host (with or without an explicit port). */
export function originAllowed(origin: string, allowedHosts: string[]): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return allowedHosts.some((h) => h === u.host || h === u.hostname);
}
