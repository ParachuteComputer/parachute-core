import { describe, expect, test } from "bun:test";
import { getTailscaleStatus } from "../tailscale/detect.ts";
import type { CommandResult, Runner } from "../tailscale/run.ts";

function statusRunner(selfJson: Record<string, unknown>, code = 0): Runner {
  return async (cmd) => {
    if (cmd.slice(0, 2).join(" ") === "tailscale status") {
      return {
        code,
        stdout: JSON.stringify({ Self: selfJson }),
        stderr: "",
      } as CommandResult;
    }
    throw new Error(`unexpected runner call: ${cmd.join(" ")}`);
  };
}

describe("getTailscaleStatus funnelCapable", () => {
  test("recognizes bare 'funnel' cap key (tailscaled ≥ 1.96)", async () => {
    // Aaron's tailscaled 1.96.5 emits { funnel: null } — no URL-form key.
    const runner = statusRunner({
      DNSName: "host.example.ts.net.",
      CapMap: { funnel: null },
    });
    const result = await getTailscaleStatus(runner);
    expect(result).toEqual({ loggedIn: true, funnelCapable: true });
  });

  test("recognizes legacy URL-form cap key", async () => {
    const runner = statusRunner({
      DNSName: "host.example.ts.net.",
      CapMap: { "https://tailscale.com/cap/funnel": ["*"] },
    });
    const result = await getTailscaleStatus(runner);
    expect(result).toEqual({ loggedIn: true, funnelCapable: true });
  });

  test("funnel-ports cap alone does not imply funnel capability", async () => {
    // funnel-ports declares *which* ports are allowed; it is not the grant.
    const runner = statusRunner({
      DNSName: "host.example.ts.net.",
      CapMap: {
        "https://tailscale.com/cap/funnel-ports?ports=443,8443,10000": null,
      },
    });
    const result = await getTailscaleStatus(runner);
    expect(result).toEqual({ loggedIn: true, funnelCapable: false });
  });

  test("no funnel cap key → funnelCapable false", async () => {
    const runner = statusRunner({
      DNSName: "host.example.ts.net.",
      CapMap: { "default-auto-update": [true] },
    });
    const result = await getTailscaleStatus(runner);
    expect(result).toEqual({ loggedIn: true, funnelCapable: false });
  });

  test("logged out → both false even with funnel cap", async () => {
    const runner = statusRunner({ CapMap: { funnel: null } });
    const result = await getTailscaleStatus(runner);
    expect(result).toEqual({ loggedIn: false, funnelCapable: false });
  });
});
