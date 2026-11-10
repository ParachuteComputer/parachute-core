// A plain MCP client for the eval's own checks (seeding lives in box-inner.ts; oracles and snapshots use this).
export async function connect(url: string, token: string) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "mcp-tasks", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return {
    client,
    instructions: client.getInstructions(),
    async listTools() {
      return (await client.listTools()).tools;
    },
    /** The raw result (content + isError), as the model would get it. */
    async raw(name: string, args: Record<string, unknown>) {
      return (await client.callTool({ name, arguments: args })) as { content?: { type: string; text?: string }[]; isError?: boolean };
    },
    /** Parsed JSON result, or throws with the tool's error text. */
    async call<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
      const r: any = await client.callTool({ name, arguments: args });
      const text = (r.content ?? []).map((c: any) => c.text ?? "").join("");
      if (r.isError) throw new Error(`${name}: ${text}`);
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as T;
      }
    },
    close: () => client.close(),
  };
}
