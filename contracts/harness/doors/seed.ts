// A made-up vault with a bit of everything a move has to carry: types with fields, nested tags, wikilinks and a typed
// link, fields with awkward but supported values, a long title, a non-ASCII path, a note with no path, files of
// three kinds (one linked from a body), and a note that has been edited (so the source holds history).
// Written through a door's REST with a credential, the same way on every door.
import { randomBytes } from "node:crypto";
import { safeFetch } from "../guard.ts";

export async function seedVault(vaultUrl: string, adminToken: string): Promise<{ notes: number; files: number }> {
  const call = async (method: string, path: string, body?: unknown) => {
    const raw = body instanceof FormData;
    const r = await safeFetch(`${vaultUrl}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${adminToken}`, ...(body === undefined || raw ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : raw ? (body as FormData) : JSON.stringify(body),
    });
    const j: any = await r.json().catch(() => null);
    if (r.status >= 300) throw new Error(`seed: ${method} ${path} gave ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    return j;
  };
  const note = (body: Record<string, unknown>) => call("POST", "/notes", body);
  const upload = async (bytes: Uint8Array, name: string, type: string) => {
    const f = new FormData();
    f.set("file", new File([bytes as unknown as BlobPart], name, { type }));
    return call("POST", "/storage/upload", f);
  };

  await call("PUT", "/tags/task", {
    description: "Something to do",
    fields: { status: { type: "string", enum: ["open", "doing", "done", "blocked: waiting"], strict: true }, due: { type: "date" }, points: { type: "integer", indexed: true } },
  });
  await call("PUT", "/tags/person", { description: "Someone in the project", fields: { email: { type: "string" }, role: { type: "string" } } });
  await call("PATCH", "/vault", { description: "Atlas: a made-up project vault for the move proofs." });

  const sam = await note({ path: "People/Sam Rivera", content: "# Sam Rivera\n\nLeads the survey.\n", tags: ["person"], metadata: { email: "sam@example.org", role: "lead" } });
  const ana = await note({ path: "People/Ana Li", content: "# Ana Li\n\nMaps and data.\n", tags: ["person"], metadata: { email: "ana@example.org", role: "cartographer" } });
  const atlas = await note({
    path: "Projects/Atlas",
    content: "# Atlas\n\nA survey of the valley. Lead: [[People/Sam Rivera]]. Maps: [[People/Ana Li|Ana]].\n\nSee also [[Projects/Not written yet]].\n",
    tags: ["project", "area/field-work"],
    metadata: {
      started: "2026-09-01",
      budget: 12500.5,
      active: true,
      urls: ["https://example.org/atlas", "http://example.org:8080/b?c=d#e", "plain"],
      contacts: [{ address: "mailto:sam@example.org", name: "Sam" }, { address: "mailto:ana@example.org", name: "Ana" }],
      nested: { region: { name: "Upper valley", bounds: [46.5, 7.1, 46.9, 7.8] }, phases: ["scout", "survey", "write-up"] },
      note_to_self: "it's \"almost\" done",
      summary: "line one\nline two",
      empty_text: "",
    },
  });
  const tasks = [];
  for (const [i, t] of ["Walk the east ridge", "Collect the water samples", "Draw the first map", "Write up week one"].entries()) {
    tasks.push(await note({ path: `Projects/Atlas/Tasks/${t}`, content: `${t}.\n\nPart of [[Projects/Atlas]].\n`, tags: ["task"], metadata: { status: ["open", "doing", "done", "blocked: waiting"][i], due: `2026-11-${10 + i}`, points: i + 1 } }));
  }
  await call("PATCH", `/notes/${tasks[0].id}`, { links: { add: [{ target: tasks[1].id, relationship: "depends-on" }, { target: sam.id, relationship: "assigned-to" }] }, if_updated_at: tasks[0].updatedAt });
  for (const d of ["2026-11-01", "2026-11-02", "2026-11-03"]) {
    await note({ path: `Journal/${d}`, content: `# ${d}\n\nFog until noon. Talked to [[People/Ana Li]].\n\n- one\n- two\n`, tags: ["journal/daily"], metadata: { weather: "fog", km: 7 } });
  }
  await note({ path: "Reisen/Zürich – 東京", content: "Umlauts stay: Grüße. Emoji too: 🪂.\n", tags: ["area/travel"], metadata: { stadt: "Zürich" } });
  await note({ path: `Reference/${"A very long title that goes on and on about the valley survey ".repeat(2)}and then ends`, content: "A title longer than a tar header's hundred bytes.\n" });
  await note({ content: "A thought with no path yet.\n", tags: ["inbox"] });

  // Files: an image, a PDF-shaped file and a larger binary, each on a note; one is linked from a body.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...randomBytes(180_000)]);
  const pdf = new Uint8Array([...new TextEncoder().encode("%PDF-1.4\n% made up\n"), ...randomBytes(30_000)]);
  const audio = new Uint8Array([0x52, 0x49, 0x46, 0x46, ...randomBytes(420_000)]);
  const map = await upload(png, "valley-map.png", "image/png");
  const report = await upload(pdf, "week-one.pdf", "application/pdf");
  const memo = await upload(audio, "ridge-memo.wav", "audio/wav");
  await call("POST", `/notes/${atlas.id}/attachments`, { path: map.path, mimeType: "image/png" });
  await call("POST", `/notes/${tasks[3].id}/attachments`, { path: report.path, mimeType: "application/pdf" });
  await call("POST", `/notes/${tasks[0].id}/attachments`, { path: memo.path, mimeType: "audio/wav" });
  const withMap = await note({ path: "Projects/Atlas/Map", content: `The map so far:\n\n![valley](/api/storage/${map.path})\n`, tags: ["project"] });
  await call("POST", `/notes/${withMap.id}/attachments`, { path: map.path, mimeType: "image/png" });

  // An edit, so the source holds an earlier version (history stays behind; the proof says so).
  const first = await call("PATCH", `/notes/${ana.id}`, { content: "# Ana Li\n\nMaps, data and the drone.\n", if_updated_at: ana.updatedAt });
  await call("PATCH", `/notes/${ana.id}`, { metadata: { role: "cartographer and pilot" }, if_updated_at: first.updatedAt });
  return { notes: 15, files: 3 };
}
