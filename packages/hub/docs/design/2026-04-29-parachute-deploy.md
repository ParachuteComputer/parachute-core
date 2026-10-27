# `parachute deploy`: provisioning one VM per user

**Date:** 2026-04-29
**Status:** Proposal — research + design. Implementation in follow-up PRs.
**Entity:** Open Parachute PBC

## Why this matters

Today Parachute is self-hosted: the user installs hub + their chosen spokes on a Mac or VPS they already operate. That gates adoption hard — you need a machine, and you need the comfort to run a service on it. The cloud-shape sketch ([`parachute.computer/design/2026-04-20-cloud-offering-sketch.md`](https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-04-20-cloud-offering-sketch.md)) imagines a multi-tenant SaaS with shared Postgres + object storage + centralized identity — a real SaaS, eventually. That's the long path.

`parachute deploy` is the **short path**. One command, the user pastes a provider API token, we provision **one VM that belongs to them**, pre-install hub + the spokes they choose, hand back a URL. No multi-tenant control plane to build first. The user's data lives on their VM, durably. We charge nothing — they pay the provider directly.

This preserves Parachute's open-source promise (your data, your machine, even when "your machine" is rented from Fly) while removing the "I have to set up Linux" gate. The migration story (move data off the VM later) is deliberately out of scope for v1 — we stand up new boxes and iterate from there.

## Tiers

Aaron's call (2026-04-29):

> "1GB is enough RAM for hub + vault + scribe which is really the first offering. Paraclaw is probably a larger offering."

This carves the cloud product into two deliberately separate tiers:

- **Tier 1 (~$7.50/mo, 1 GB Fly machine).** Hub + vault + scribe + notes (and any custom UIs the user installs against that hub). The "personal knowledge layer." 1 GB is adequate for these four modules; multiple vaults are supported on one machine; storage scales by enlarging the Fly volume. **This is what `parachute deploy` v1 ships.**
- **Tier 2 (later, ~$15–25/mo).** Paraclaw on its own Fly machine, attached to the Tier 1 hub via the OAuth/services catalog. Keeps the Tier 1 box cheap by isolating agent compute from the knowledge layer. **Paraclaw is *not* part of `parachute deploy` v1** — it ships as a follow-up once Tier 1 is in users' hands.

Aaron's quote names hub + vault + scribe; notes is added here because it's a thin frontend PWA whose backend is hub + vault, and its idle RSS sits within the same 1 GB envelope. The four-module Tier 1 set is consistent with the constraint Aaron called.

The `--modules` default reflects Tier 1: `vault,scribe,notes`. Hub is implicit on every deployment. Paraclaw is intentionally absent from the v1 module set; passing `--modules paraclaw` will fail with a clear "Tier 2, not yet shipped" message.

## 1. Provider comparison: Fly.io vs Render

Both providers were evaluated against the target shape: **one persistent VM, ~1 GB RAM, 1–2 shared vCPU, 10–20 GB persistent disk, always-on, ~$10/mo**. Pricing pulled live from each provider's docs on 2026-04-29.

### Fly.io

**Pricing.** `shared-cpu-1x @ 1 GB` machine = **$5.92/mo** ($0.0082/hr). Volume = **$0.15/GB/mo** → 10 GB = $1.50/mo. Egress NA/EU = **$0.02/GB** (first GB or two free in practice; personal use will be <$0.10/mo). **Realistic always-on bill: ~$7.50/mo** for 1 GB compute + 10 GB volume + small egress. The 2 GB tier (`shared-cpu-1x @ 2 GB`) jumps to ~$12.70/mo and breaks the $10 budget. Whether 1 GB is enough for hub + vault + scribe + Bun needs benchmarking before we commit, but Bun's idle RSS (~50–80 MB/process) suggests it's tight-but-fine.

**Provisioning API.** First-class. Machines API at `https://api.machines.dev` (OpenAPI spec published). Bearer-token auth via `fly auth token`. Three calls to stand up an app:
1. `POST /v1/apps` — `{app_name, org_slug}`
2. `POST /v1/apps/{app}/volumes` — `{name, region, size_gb}`
3. `POST /v1/apps/{app}/machines` — `{config: {image, env, services, mounts, checks}}`

No first-party JS SDK; plain `fetch()` is fine and durable. The docs warn placement can fail under capacity pressure — `parachute deploy` needs **retry-with-backoff and an alternate-region fallback**.

**DNS / TLS.** Every app gets `<app>.fly.dev` with auto-issued TLS — zero DNS work to get a working HTTPS URL. Custom domains (`aaron.parachute.computer`) via `POST /v1/apps/{app}/certificates` + an A/AAAA record at the user's DNS. Wildcards supported but require DNS-01, which means we'd need API access to whoever hosts the apex — out of scope for v1.

**SSH.** `fly ssh console -C "command"` works programmatically with `--access-token`. Good enough for backups (`sqlite3 /data/vault.db .dump`) without building our own shell-access layer.

**Volumes.** This is the weak link. Fly volumes are single-host NVMe — **no cross-host replication**. If the host dies, the volume goes with it; recovery is restore-from-snapshot. Snapshots are first-10-GB-free at $0.08/GB/mo over that. Volumes are region-pinned. **Implication for `parachute deploy`: we default-on daily snapshots and document the failure mode honestly. SQLite-on-volume is fine for the personal use case but it's not zero-risk.**

**Regions.** 18, covering all three target geographies: 6 NA, 5 EU, 4 APAC, 1 SA, 1 AF. APAC is well-covered (Tokyo, Singapore, Sydney, Mumbai). User picks region at provision time; can't move later without copy-and-recreate.

**Cold-start.** With `auto_stop_machines = "off"`, machines are hot. Host-maintenance reschedules happen but Fly doesn't publish a public SLA — treat as durable-with-occasional-hiccups.

**Bun.** Standard Linux container, x86_64. `oven/bun` base Docker image, deploy. SQLite via `bun:sqlite` is just a file on the volume. No Fly-specific quirks.

**Watch-outs.** Legacy free tier closed to new signups (Fly is now pure pay-as-you-go). Volume durability rests entirely on snapshots. Placement failures require retry logic in our orchestration.

### Render

**Pricing.** Web service Starter (512 MB RAM, 0.5 vCPU) = **$7/mo**; Standard (2 GB, 1 vCPU) = **$25/mo**. Disk = **$0.25/GB/mo** → 10 GB = $2.50/mo. Workspace plan: Hobby is free for one member with 5 GB included egress; Pro is $25/mo flat with 25 GB included. **Starter at $9.50/mo (instance + 10 GB disk) is in budget but probably undersized** for hub + multiple spokes on Bun. **Standard at $27.50/mo is the safe spec — about 3× over the $10 target.** Free tier is unusable: no persistent disks, 15-minute idle suspend with 30–60 s cold-start.

**Provisioning API.** Full public REST at `https://api.render.com/v1`. Bearer-token auth. `POST /v1/services` with `{type, name, ownerId, repo|image, envVars[], serviceDetails: {plan, region, disk}}`. OpenAPI spec published. Render also ships an MCP server, which suggests the surface is mature. Rate limits not publicly documented — verify before bulk use.

**DNS / TLS.** Auto `<name>.onrender.com` with TLS. Custom domains via API + CNAME/A at user's DNS, then auto-renewed Let's Encrypt. Wildcards supported (require three CNAMEs for ACME validation). Hobby workspace: 2 custom domains; Pro: 15. HTTP→HTTPS redirect is automatic.

**SSH.** Browser shell, `render ssh` via CLI, or direct `ssh` with a per-service connection string. Available on paid web/private services and background workers. Auto-closes on redeploy or platform maintenance. Not API-spawned, but the CLI is scriptable.

**Disks.** Mounted at a chosen path; survives deploys/restarts. **Critical caveat: attaching a disk disables zero-downtime deploys** — Render stops the old instance before starting the new one (30–90 s gap per deploy). Daily automatic snapshots, retained ≥7 days. Region-local; no cross-region failover. Single-writer constraint (can't horizontally scale a disked service) — fine for our one-VM-per-user model.

**Regions.** Five: Oregon, Ohio, Virginia, Frankfurt, Singapore. **No Tokyo, Sydney, Mumbai, LATAM, or Africa.** Adequate for US/EU/APAC if Singapore covers all of APAC for our purposes; thinner than Fly. Region cannot be changed post-creation.

**Cold-start.** Paid tiers stay hot. Disk-attached deploys cause 30–90 s gaps. Maintenance can restart; frequency not published.

**Bun.** Native runtime — no Dockerfile required. Render lists Bun explicitly alongside Node, Python, Ruby etc. This is the cleanest DX advantage Render has over Fly: build command runs in a separate environment, then start command launches the runtime against the persistent disk.

**Watch-outs.** April 2026 plan changes (per-seat → flat-fee workspaces) auto-migrate by August 2026 — pricing is in flux. Pre-deploy commands run on a discarded filesystem, so vault SQLite migrations need to happen at start time, not pre-deploy.

### Side-by-side

| Dimension | Fly.io | Render |
|---|---|---|
| **Realistic monthly cost** | **~$7.50** (1 GB / 10 GB volume) | $27.50 (Standard / 10 GB disk) — Starter $9.50 is undersized |
| **API** | Machines API, fully programmatic | REST API, fully programmatic |
| **Free auto-domain + TLS** | `*.fly.dev` ✓ | `*.onrender.com` ✓ |
| **Custom domain** | Via certs API | Via API |
| **SSH** | `fly ssh console` (token-auth) | `render ssh` or per-service connection string |
| **Persistent storage** | Volume, single-host NVMe, snapshot-only durability | Disk, daily snapshots, 30–90 s deploy downtime |
| **Regions** | 18 — full APAC + SA + AF | 5 — US, Frankfurt, Singapore only |
| **Bandwidth** | $0.02/GB egress NA/EU; inbound free | 5 GB free (Hobby) / 25 GB (Pro), then $0.15/GB |
| **Bun runtime** | Linux container, `oven/bun` Docker base | Native — no Dockerfile required |
| **Operational gotcha** | Volume durability = snapshots only; placement failures need retry | Disk-attached deploys are not zero-downtime |
| **$10 budget fit** | **Yes, with headroom** | No, ~3× over for realistic spec |

## 2. The `parachute deploy` command shape

The CLI surface — sketch, not the implementation:

```
parachute deploy --provider=fly [options]

Options:
  --provider <fly|render>     Cloud provider. Default: fly.
  --region <id>               Provider region code (fly: ord, ams, syd…). Default: nearest by ping or US-East.
  --size <small|medium>       small = 1 GB (Fly default), medium = 2 GB. Default: small.
  --domain <fqdn>             Custom domain. If omitted, use provider's default subdomain.
  --modules <list>            Comma-separated spokes to install. Default: vault,scribe,notes (Tier 1).
  --token <provider-token>    Provider API token. If omitted, prompt interactively.
  --name <slug>               Deployment name. Default: parachute-<random>.
```

**What it does, end to end:**

1. **Validate inputs.** Check the provider token works (calls `GET /v1/apps` or equivalent). Resolve module list against the user's installed `parachute.json` definitions.
2. **Provision the VM.** Provider-specific calls: create app, create volume/disk, create machine/service with the right env vars and the Parachute base image.
3. **Wait for boot.** Poll the provider's machine-state endpoint until the VM is "started," then poll the deployed hub's `/health` until it returns 200.
4. **Bootstrap.** Over the provider's SSH or via a Parachute-shipped first-boot script baked into the image, run the equivalent of `parachute init` + install the requested modules. The vault gets a fresh DB and a generated `pvt_*` operator token.
5. **Hand back credentials.** Print the deployment URL (`https://<name>.fly.dev` or `https://<domain>` if custom), the operator token (only shown once), and the SSH command for backups.
6. **Persist deployment record.** Write a row to `~/.parachute/deployments.json` with `{provider, app_name, region, created_at, url}` so subsequent commands (`parachute upgrade --on=<name>`, `parachute deploy logs --on=<name>`, `parachute deploy destroy --on=<name>`) can target it.

**Provider token storage.** The provider token is the most sensitive thing in this flow. Three options:
- **Paste-per-deploy** (simplest, most secure): user pastes the token interactively, we use it once, never write it. Subsequent operations re-prompt or use the per-deployment SSH key only.
- **Encrypted in hub config**: paraclaw already has a paste-token-and-encrypt pattern via `parachute auth set-secret`; reuse it. Token decrypts on demand using the operator-token-protected secret store.
- **OS keychain**: macOS Keychain / Linux Secret Service. Most user-friendly, most platform-specific.

**Recommendation: paste-per-deploy for v1.** Migration to encrypted storage is a follow-up if users complain. Keeps the threat model small.

**Subsequent operations.** Once a deployment exists, name-targeted commands work against it:

```
parachute deploy list                    # show all my deployments + status
parachute deploy logs --on <name>        # streams from provider
parachute upgrade --on <name>            # bumps the Parachute version on the VM
parachute deploy ssh --on <name>         # opens shell
parachute deploy destroy --on <name>     # tears down (confirmation required)
```

`--on <name>` resolves to a deployment record and dispatches to the right provider client. Default `--on` is the most-recent deployment when only one exists.

## 3. Recommendation: Fly.io as the preferred path

**Pick Fly.** The $10/mo budget is the dominating constraint, and Fly clears it at $7.50/mo with $2.50 of headroom for snapshot growth and bandwidth. Render is the cleaner DX (native Bun runtime, no Dockerfile) but at 3× over budget for the realistic spec it's wrong on the load-bearing axis.

Beyond cost, Fly is also stronger on:
- **Region coverage** (18 vs 5) — APAC users get Tokyo, Sydney, Mumbai instead of Singapore-only.
- **Programmatic surface** — Machines API is purpose-built for the orchestration we want to do; Render's API is web-service-shaped and we'd be bending it to fit.
- **Volume model** — Fly's volume-on-machine maps cleanly to "one VM owns its data." Render's disk-with-non-zero-downtime-deploys is a UX papercut every time the user upgrades.

Render becomes `--provider=render` for power users. We don't ship the Render adapter in the first PR, but the abstraction (provider-client interface) is built so adding it later is mechanical, not architectural.

**Caveats.** Two things we have to handle in the Fly orchestration that Render would handle for us:
1. **Placement retry.** Fly create-machine can fail on capacity; orchestration retries with exponential backoff and falls back to a nearby region after N attempts.
2. **Snapshot policy.** Default-on daily snapshots, surfaced in the deploy success output ("Backups: enabled, daily, 7-day retention").

## 4. Implementation outline

Order of work, not the work itself.

1. **Provider-client interface** (`packages/provider-clients/` or `src/providers/`). Abstract interface — `createDeployment(opts)`, `getDeployment(name)`, `streamLogs(name)`, `executeCommand(name, cmd)`, `destroyDeployment(name)`. Two implementations: `FlyClient` (first), `RenderClient` (later). Mocked-API tests verify each client's request shaping.
2. **Provisioning script — the "first boot" bake.** A small shell or TypeScript script that runs on the provisioned VM at start. Pulls hub + the requested modules from npm, runs the equivalent of `parachute init`, generates the operator token, starts services. This is what gets baked into the Parachute Docker image (Fly) or shipped as a build/start command (Render). Lives in `parachute-hub/deploy/first-boot/`.
3. **`parachute deploy` command** (`src/commands/deploy.ts`). Argument parsing → provider-client dispatch → boot polling → bootstrap call → success output. Reuses existing CLI patterns (interactive prompts, output formatting). Writes `~/.parachute/deployments.json`.
4. **`parachute deploy list / logs / ssh / destroy / upgrade`** as sibling subcommands. Each reads `deployments.json`, looks up provider, dispatches.
5. **Tests.**
   - **Unit:** mocked provider API responses for FlyClient — happy path, placement failure + retry, region fallback, token rejection.
   - **Integration:** end-to-end test against Fly's API in a sandbox app, gated behind a `FLY_TEST_TOKEN` env var so it only runs on demand. Provisions, asserts hub `/health` responds, destroys.
   - **CLI smoke:** `parachute deploy --provider=fly --dry-run` prints the planned API calls without executing.
6. **Docs.** README section, a docs/cloud-deploy.md walkthrough, and an example `parachute deploy` recording for the marketing site.

**What we explicitly defer:**
- Render adapter (build interface so it slots in later, ship Fly only).
- Migration tooling (export from VM A, import to VM B).
- Multi-user shared deployments (`parachute deploy` is one-VM-one-user; teams come later).
- Encrypted provider-token storage (paste-per-deploy v1).
- Custom-domain DNS automation (user does their own DNS for v1).

**Sequencing.** PR1 = provider-client interface + FlyClient. PR2 = first-boot script + Parachute deploy image (Tier 1: hub + vault + scribe + notes only). PR3 = `parachute deploy` command + deployment record. PR4 = sibling subcommands. Each PR is gated on its predecessor; the whole sequence is ~2 weeks of focused work. Paraclaw (Tier 2) is excluded from this sequence and ships separately.

## Open questions

- **Image distribution.** Do we publish a single Parachute Docker image (`openparachute/parachute:0.4.0`) and the first-boot script picks modules from it, or do we build a per-user image at provision time? Single image is simpler; per-user lets us bake module choices in but adds a build step. Default: single image.
- **Operator token recovery.** Token is shown once; if the user loses it they SSH in and run `parachute auth rotate-key`. Worth surfacing in the success output.
- **`shared-cpu-1x @ 1 GB` benchmark.** Need to confirm hub + vault + scribe + Bun fit before committing the budget. If 1 GB doesn't fit, the budget conversation reopens.
- **DNS apex automation.** `<name>.parachute.computer` requires Parachute to manage the apex and write A records on the user's behalf. Out of scope for v1 (user gets `<name>.fly.dev` or brings their own domain). Worth designing in a follow-up.
- **Billing relationship.** User pays Fly directly via their Fly account. Parachute (Open Parachute PBC) takes nothing in this model. If we later offer "Parachute-managed billing" we'd need a Fly org we own + per-tenant cost attribution.

## References

- Cloud-shape sketch: [`parachute.computer/design/2026-04-20-cloud-offering-sketch.md`](https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-04-20-cloud-offering-sketch.md)
- Fly Machines API: https://fly.io/docs/machines/api/ · OpenAPI: https://docs.machines.dev/
- Fly pricing: https://fly.io/docs/about/pricing/
- Fly volumes: https://fly.io/docs/volumes/
- Fly regions: https://fly.io/docs/reference/regions/
- Render API: https://render.com/docs/api · https://api-docs.render.com/
- Render pricing structure: https://render.com/pricing
- Render disks: https://render.com/docs/disks
- Render regions: https://render.com/docs/regions
