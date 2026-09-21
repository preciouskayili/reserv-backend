import { getSupabase, isSupabaseConfigured } from "../lib/supabase.js";
import { HttpError, validateState } from "../domain/workspace.js";
import type { AppState } from "../domain/model.js";
export interface Snapshot {
  state: AppState;
  revision: number;
}
export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: string;
}
export function syncOwnerProfile(snapshot: Snapshot): Snapshot {
  const state = structuredClone(snapshot.state);
  const owner = state.staff.find(member => member.id === state.settings.ownerStaffId)
    ?? state.staff.find(member => member.role.toLowerCase() === "owner");
  const name = state.settings.owner.trim() || state.business.owner.trim();
  if (owner && name) {
    owner.name = name;
    owner.initials = name.split(/\s+/).map(part => part[0]).slice(0, 2).join("");
    state.settings.ownerStaffId = owner.id;
    state.business.owner = name;
  }
  return { ...snapshot, state };
}
// Isolated in-memory storage is available only in test runs. Missing live storage never becomes a demo.
const testStore = new Map<string, Snapshot>();
const testMembers = new Map<string, Set<string>>();
const testing = () =>
  process.env.NODE_ENV === "test" && !isSupabaseConfigured();

function db() {
  if (!isSupabaseConfigured())
    throw new HttpError(503, "Workspace storage is not configured");
  return getSupabase();
}

function failure(error: { code?: string; message: string }): never {
  if (error.code === "23505")
    throw new HttpError(
      409,
      "That booking link is already taken. Choose another.",
    );

  if (error.code === "P0001") throw new HttpError(409, error.message);

  if (error.code === "40001")
    throw new HttpError(
      409,
      "This workspace changed in another session. Reload before saving again.",
    );

  console.error(
    "Workspace database error:",
    error.code || "(no code)",
    error.message,
  );
  // supabase-js reports transport failures with no Postgres error code; the schema is not at fault.
  if (!error.code)
    throw new HttpError(
      503,
      "Couldn’t reach workspace storage. Check the connection and try again.",
    );
  throw new HttpError(
    503,
    "Workspace storage is unavailable. Check that the workspace migration has been applied.",
  );
}

export const workspaces = {
  async list(userId: string): Promise<WorkspaceSummary[]> {
    if (testing())
      return [...(testMembers.get(userId) ?? [])].map((id) => ({
        id,
        name: testStore.get(id)!.state.business.name,
        slug: testStore.get(id)!.state.business.slug,
        role: "owner",
      }));
    const { data, error } = await db()
      .from("workspace_members")
      .select("business_id,role,businesses!inner(name,slug)")
      .eq("user_id", userId);
    if (error) failure(error);
    return (data ?? []).map((row: any) => ({
      id: row.business_id,
      role: row.role,
      name: row.businesses.name,
      slug: row.businesses.slug,
    }));
  },

  async authorize(userId: string, workspaceId: string, write = false) {
    if (testing()) {
      if (!testMembers.get(userId)?.has(workspaceId))
        throw new HttpError(404, "Workspace not found");
      return;
    }

    const { data, error } = await db()
      .from("workspace_members")
      .select("role")
      .eq("user_id", userId)
      .eq("business_id", workspaceId)
      .maybeSingle();
    if (error) failure(error);
    if (!data) throw new HttpError(404, "Workspace not found");
    if (write && !["owner", "admin"].includes(data.role))
      throw new HttpError(
        403,
        "Only workspace owners and admins can make this change",
      );
  },

  async isSlugTaken(slug: string): Promise<boolean> {
    if (!slug) return false;
    if (testing()) {
      return [...testStore.values()].some(
        (s) => s.state.business.slug.toLowerCase() === slug.toLowerCase(),
      );
    }
    try {
      const { data, error } = await db()
        .from("businesses")
        .select("id")
        .eq("slug", slug.toLowerCase())
        .maybeSingle();
      if (error) return false;
      return Boolean(data);
    } catch {
      return false;
    }
  },

  async resolveUniqueSlug(baseSlug: string): Promise<string> {
    let clean = baseSlug
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!clean || clean.length < 2) clean = "studio";

    let candidate = clean;
    let taken = await this.isSlugTaken(candidate);
    let counter = 2;
    while (taken && counter <= 100) {
      candidate = `${clean}-${counter}`;
      taken = await this.isSlugTaken(candidate);
      counter++;
    }
    if (taken) {
      candidate = `${clean}-${Math.random().toString(36).substring(2, 6)}`;
    }
    return candidate;
  },

  async checkSlug(
    slug: string,
  ): Promise<{ available: boolean; suggestedSlug?: string }> {
    const clean = slug
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!clean || clean.length < 2) return { available: false };

    const taken = await this.isSlugTaken(clean);
    if (!taken) {
      return { available: true, suggestedSlug: clean };
    }
    const unique = await this.resolveUniqueSlug(clean);
    return { available: false, suggestedSlug: unique };
  },

  async create(userId: string, state: AppState): Promise<Snapshot> {
    if (await this.isSlugTaken(state.business.slug)) {
      state.business.slug = await this.resolveUniqueSlug(state.business.slug);
    }
    validateState(state, state.business.id);
    if (testing()) {
      const result = { state: structuredClone(state), revision: 1 };
      testStore.set(state.business.id, result);
      const memberships = testMembers.get(userId) ?? new Set();
      memberships.add(state.business.id);
      testMembers.set(userId, memberships);
      return syncOwnerProfile(result);
    }

    const { data, error } = await db().rpc("create_workspace", {
      p_user: userId,
      p_state: state,
    });
    if (error) failure(error);
    return data;
  },

  async read(id: string): Promise<Snapshot> {
    if (testing()) {
      const result = testStore.get(id);
      if (!result) throw new HttpError(404, "Workspace not found");
      return syncOwnerProfile(result);
    }
    const { data, error } = await db()
      .from("workspace_state")
      .select("state,revision")
      .eq("business_id", id)
      .maybeSingle();
    if (error) failure(error);
    if (!data) throw new HttpError(404, "Workspace not found");
    return syncOwnerProfile(data as Snapshot);
  },
  async bySlug(slug: string): Promise<Snapshot> {
    if (testing()) {
      const result = [...testStore.values()].find(
        (s) => s.state.business.slug === slug,
      );
      if (!result) throw new HttpError(404, "Business not found");
      return syncOwnerProfile(result);
    }
    const { data, error } = await db()
      .from("businesses")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    if (error) failure(error);
    if (!data) throw new HttpError(404, "Business not found");
    return this.read(data.id);
  },
  async byCode(code: string): Promise<Snapshot> {
    if (!/^[A-Z0-9]{12}$/.test(code))
      throw new HttpError(404, "Reservation not found");
    if (testing()) {
      const result = [...testStore.values()].find((s) =>
        s.state.bookings.some((b) => b.code === code),
      );
      if (!result) throw new HttpError(404, "Reservation not found");
      return syncOwnerProfile(result);
    }
    const { data, error } = await db()
      .from("reservation_links")
      .select("business_id")
      .eq("code", code)
      .maybeSingle();
    if (error) failure(error);
    if (!data) throw new HttpError(404, "Reservation not found");
    return this.read(data.business_id);
  },
  async save(id: string, revision: number, input: unknown): Promise<Snapshot> {
    const state = validateState(input, id);
    if (testing()) {
      const previous = testStore.get(id);
      if (!previous) throw new HttpError(404, "Workspace not found");
      if (previous.revision !== revision)
        throw new HttpError(
          409,
          "This workspace changed in another session. Reload before saving again.",
        );
      if (
        [...testStore.values()].some(
          (s) =>
            s.state.business.id !== id &&
            s.state.business.slug === state.business.slug,
        )
      )
        throw new HttpError(409, "That booking link is already taken");
      const next = { state: structuredClone(state), revision: revision + 1 };
      testStore.set(id, next);
      return structuredClone(next);
    }
    const { data, error } = await db().rpc("replace_workspace_state", {
      p_id: id,
      p_revision: revision,
      p_state: state,
    });
    if (error) failure(error);
    return data;
  },

  async all(): Promise<Snapshot[]> {
    if (testing()) return structuredClone([...testStore.values()]);
    const { data, error } = await db()
      .from("workspace_state")
      .select("state,revision");
    if (error) failure(error);
    return data as Snapshot[];
  },
};

export function publicState(snapshot: Snapshot, code?: string): Snapshot {
  const state = syncOwnerProfile(snapshot).state;
  const booking = code
    ? state.bookings.find((b) => b.code === code)
    : undefined;
  // Availability carries no names, notes, codes, or customer identifiers.
  const availability = state.bookings
    .filter(
      (b) =>
        !["Cancelled", "Completed"].includes(b.status) && b.id !== booking?.id,
    )
    .map((b) => ({
      id: b.id,
      staffId: b.staffId,
      startTime: b.startTime,
      endTime: b.endTime,
      status: b.status,
    }));

  state.bookings = booking
    ? [
        {
          ...booking,
          notes: "",
          activity: booking.activity
            .filter((a) => a.actor !== "owner")
            .map((a) => ({ ...a, detail: undefined })),
        },
      ]
    : [];

  state.customers = booking
    ? state.customers
        .filter((c) => c.id === booking.customerId)
        .map((c) => ({ ...c, notes: "" }))
    : [];

  state.payments = booking
    ? (state.payments ?? [])
        .filter((p) => p.bookingId === booking.id)
        .map((p) => ({ ...p, receiptId: undefined, receiptName: undefined }))
    : [];

  if (state.business.voice) {
    const voice = state.business.voice;
    state.business.voice = { country: voice.country, status: voice.status, number: voice.status === "active" ? voice.number : undefined };
  }
  state.agentActivity = [];
  state.settings = { reminders: false, confirmations: false, owner: "" };
  state.business.owner = "";

  return {
    state: { ...state, availability } as AppState,
    revision: snapshot.revision,
  };
}
