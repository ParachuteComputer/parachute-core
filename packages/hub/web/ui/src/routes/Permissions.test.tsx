/**
 * Permissions route smoke tests — loading, ok with rows, empty, error,
 * filter submit, revoke confirm flow (cancel + confirm), revoke failure.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api.ts";
import { Permissions } from "./Permissions.tsx";

vi.mock("../lib/api.ts", async (orig) => {
  const actual = (await orig()) as typeof api;
  return {
    ...actual,
    listGrants: vi.fn(),
    revokeGrant: vi.fn(),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderRoute() {
  return render(
    <MemoryRouter>
      <Permissions />
    </MemoryRouter>,
  );
}

const grant = (clientId: string, name: string | null, scopes: string[]) => ({
  user_id: "u1",
  client_id: clientId,
  client_name: name,
  scopes,
  granted_at: "2026-04-01T12:00:00.000Z",
});

describe("Permissions", () => {
  it("renders the empty state when no grants exist", async () => {
    vi.mocked(api.listGrants).mockResolvedValue([]);
    renderRoute();
    await waitFor(() => expect(screen.getByText(/no grants\./i)).toBeInTheDocument());
  });

  it("renders one row per grant with client_name + scopes", async () => {
    vi.mocked(api.listGrants).mockResolvedValue([
      grant("c1", "App A", ["vault:work:read", "vault:work:write"]),
      grant("c2", null, ["notes:read"]),
    ]);
    renderRoute();
    await waitFor(() => expect(screen.getByText("App A")).toBeInTheDocument());
    expect(screen.getByText("c2")).toBeInTheDocument(); // null name → falls back to client_id
    expect(screen.getByText("vault:work:read")).toBeInTheDocument();
    expect(screen.getByText("notes:read")).toBeInTheDocument();
  });

  it("renders the error banner + retry on listGrants failure", async () => {
    vi.mocked(api.listGrants).mockRejectedValue(new Error("network down"));
    renderRoute();
    await waitFor(() => expect(screen.getByText(/couldn't load grants/i)).toBeInTheDocument());
    expect(screen.getByText("network down")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("Apply filter calls listGrants with the entered vault name", async () => {
    vi.mocked(api.listGrants).mockResolvedValue([]);
    renderRoute();
    // Initial unfiltered call.
    await waitFor(() => expect(api.listGrants).toHaveBeenCalledWith({}));
    const input = screen.getByLabelText(/filter by vault/i);
    fireEvent.change(input, { target: { value: "work" } });
    fireEvent.click(screen.getByRole("button", { name: /apply/i }));
    await waitFor(() => expect(api.listGrants).toHaveBeenCalledWith({ vault: "work" }));
  });

  it("revoke button opens confirm dialog; cancel returns to list without DELETE", async () => {
    vi.mocked(api.listGrants).mockResolvedValue([grant("c1", "App A", ["vault:work:read"])]);
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /^revoke app a$/i }));
    // Confirm dialog visible.
    expect(screen.getByRole("dialog", { name: /confirm revoke app a/i })).toBeInTheDocument();
    // Cancel.
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /confirm revoke/i })).toBeNull(),
    );
    expect(api.revokeGrant).not.toHaveBeenCalled();
  });

  it("confirm revoke calls DELETE then refreshes the list", async () => {
    const listMock = vi.mocked(api.listGrants);
    listMock.mockResolvedValueOnce([grant("c1", "App A", ["vault:work:read"])]);
    listMock.mockResolvedValueOnce([]);
    vi.mocked(api.revokeGrant).mockResolvedValue();

    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /^revoke app a$/i }));
    // Scope the selector to the dialog so we don't pick up the row's own
    // Revoke button (which is hidden while the dialog is open anyway).
    const dialog = screen.getByRole("dialog", { name: /confirm revoke app a/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /^revoke$/i }));

    await waitFor(() => expect(api.revokeGrant).toHaveBeenCalledWith("c1"));
    // Row gone, empty state shows.
    await waitFor(() => expect(screen.getByText(/no grants\./i)).toBeInTheDocument());
  });

  it("surfaces a per-row error banner when revoke fails", async () => {
    vi.mocked(api.listGrants).mockResolvedValue([grant("c1", "App A", ["vault:work:read"])]);
    vi.mocked(api.revokeGrant).mockRejectedValue(new api.HttpError(409, "in flight"));

    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /^revoke app a$/i }));
    const dialog = screen.getByRole("dialog", { name: /confirm revoke app a/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /^revoke$/i }));

    await waitFor(() =>
      expect(screen.getByText(/revoke failed \(409\): in flight/i)).toBeInTheDocument(),
    );
  });
});
