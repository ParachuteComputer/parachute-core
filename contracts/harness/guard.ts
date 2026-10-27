// The one door every request from the contracts goes through.
//
// The suite promises it never touches a live Parachute service. Checking the first URL isn't enough: plain fetch()
// follows redirects, so a misconfigured or hostile service could bounce a request (with its cookies, codes or
// tokens) to the live hub on 1939. So:
//   - only origins registered with allowOrigins() may be called (the throwaway hub and vault);
//   - the live install's ports are refused even if someone registers them;
//   - redirects are never followed: a 3xx comes back to the caller, who may read Location but must call
//     safeFetch again to go there, which checks the new origin.

const allowed = new Set<string>();
// The live install: hub 1939, vault 1940, other modules up to 1946.
const LIVE_PORTS = new Set(["1939", "1940", "1941", "1942", "1943", "1944", "1945", "1946"]);

export function allowOrigins(...urls: string[]): void {
  for (const u of urls) allowed.add(new URL(u).origin);
}

export function checkUrl(input: string | URL): URL {
  const url = new URL(input.toString());
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (LIVE_PORTS.has(port)) throw new Error(`refused: ${url.origin} is a live Parachute port`);
  if (!allowed.has(url.origin)) {
    throw new Error(`refused: ${url.origin} is not a throwaway service (allowed: ${[...allowed].join(", ") || "none"})`);
  }
  return url;
}

/** fetch(), restricted to the throwaway services, with redirects returned instead of followed. */
export async function safeFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = checkUrl(input instanceof Request ? input.url : input);
  const req = input instanceof Request ? input : url;
  return fetch(req, { ...init, redirect: "manual" });
}
