import { describe, expect, test } from "bun:test";
import { type ServeEntry, bringupCommand, teardownCommand } from "../tailscale/commands.ts";

const proxyEntry: ServeEntry = {
  kind: "proxy",
  mount: "/",
  target: "http://127.0.0.1:1940",
  service: "parachute-vault",
};

const fileEntry: ServeEntry = {
  kind: "file",
  mount: "/.well-known/parachute.json",
  target: "/Users/x/.parachute/well-known/parachute.json",
  service: "well-known",
};

const subpathEntry: ServeEntry = {
  kind: "proxy",
  mount: "/notes",
  target: "http://127.0.0.1:5173",
  service: "parachute-notes",
};

describe("tailscale commands", () => {
  test("bringup proxy uses https=443 and --set-path", () => {
    expect(bringupCommand(proxyEntry)).toEqual([
      "tailscale",
      "serve",
      "--bg",
      "--https=443",
      "--set-path=/",
      "http://127.0.0.1:1940",
    ]);
  });

  test("bringup preserves subpath mounts", () => {
    expect(bringupCommand(subpathEntry)).toEqual([
      "tailscale",
      "serve",
      "--bg",
      "--https=443",
      "--set-path=/notes",
      "http://127.0.0.1:5173",
    ]);
  });

  test("bringup file entry passes filesystem path as target", () => {
    expect(bringupCommand(fileEntry)).toEqual([
      "tailscale",
      "serve",
      "--bg",
      "--https=443",
      "--set-path=/.well-known/parachute.json",
      "/Users/x/.parachute/well-known/parachute.json",
    ]);
  });

  test("bringup uses `tailscale funnel` subcommand when funnel=true", () => {
    // Modern tailscale (1.82+) split funnel out of serve. Public mode must
    // route through `tailscale funnel`, not `tailscale serve --funnel`.
    expect(bringupCommand(proxyEntry, { funnel: true })).toEqual([
      "tailscale",
      "funnel",
      "--bg",
      "--https=443",
      "--set-path=/",
      "http://127.0.0.1:1940",
    ]);
  });

  test("bringup honors custom port", () => {
    expect(bringupCommand(proxyEntry, { port: 8443 })).toEqual([
      "tailscale",
      "serve",
      "--bg",
      "--https=8443",
      "--set-path=/",
      "http://127.0.0.1:1940",
    ]);
  });

  test("teardown issues off per mount", () => {
    expect(teardownCommand(proxyEntry)).toEqual([
      "tailscale",
      "serve",
      "--https=443",
      "--set-path=/",
      "off",
    ]);
    expect(teardownCommand(fileEntry)).toEqual([
      "tailscale",
      "serve",
      "--https=443",
      "--set-path=/.well-known/parachute.json",
      "off",
    ]);
  });

  test("teardown routes through `tailscale funnel` when funnel=true", () => {
    // Same subcommand split applies to teardown — `serve … off` doesn't
    // remove a funnel-mounted entry on 1.82+.
    expect(teardownCommand(proxyEntry, { funnel: true })).toEqual([
      "tailscale",
      "funnel",
      "--https=443",
      "--set-path=/",
      "off",
    ]);
  });
});
