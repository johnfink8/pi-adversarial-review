/**
 * Strict resolution of the configured panel model, against the same registry
 * the child's `--model` flag resolves against.
 *
 * pi resolves `--model` exact-or-fuzzy: a pattern that substring-matches some
 * registry id or name silently runs a different model. The gate therefore
 * resolves the configured `provider/id` itself and refuses anything that would
 * not come back verbatim: an exact registry entry, or a custom id on a known
 * provider (passed through to the provider as typed). Anything pi would reach
 * by fuzzy match, or a provider the registry has never heard of, fails before
 * the panel spends a token.
 *
 * The returned value is the canonical `provider/id` — registry casing — and is
 * the one authority on model identity: it is what gets dispatched, hashed, and
 * compared against the child's own report of the model it ran on.
 */

export interface PanelModelCandidate {
  provider: string;
  id: string;
  name?: string | undefined;
}

export function assertExactPanelModel(configured: string, models: readonly PanelModelCandidate[]): string {
  const target = configured.toLowerCase();
  const canonical = models.filter((m) => `${m.provider}/${m.id}`.toLowerCase() === target);
  if (canonical.length > 1) {
    throw new Error(
      `panel model "${configured}" is ambiguous: the registry lists ${canonical.length} models with that provider/id`,
    );
  }
  if (canonical.length === 1) return `${canonical[0].provider}/${canonical[0].id}`;

  const slash = configured.indexOf("/");
  const provider = configured.slice(0, slash).toLowerCase();
  const pattern = configured.slice(slash + 1);
  const providerModels = models.filter((m) => m.provider.toLowerCase() === provider);
  const fuzzyMatch = (needle: string) => (m: PanelModelCandidate) =>
    m.id.toLowerCase().includes(needle) || m.name?.toLowerCase().includes(needle) === true;
  const substitutionError = (found: PanelModelCandidate) =>
    `panel model "${configured}" is not an exact match; pi's fuzzy match would run "${found.provider}/${found.id}" instead — configure that exact provider/id`;
  // pi's resolution order: the id within the named provider, then the bare-id
  // and whole-string passes across every provider, then a custom-id fallback.
  const inProvider = providerModels.find(fuzzyMatch(pattern.toLowerCase()));
  if (inProvider !== undefined) throw new Error(substitutionError(inProvider));

  // A bare registry id equal to the whole configured string is not "the same
  // model": pi would run it under a different provider than the one named.
  const bare = models.filter((m) => m.id.toLowerCase() === target);
  if (bare.length > 0) {
    const found = bare.map((m) => `${m.provider}/${m.id}`).join(", ");
    throw new Error(`panel model "${configured}" would run ${found}; configure that exact provider/id`);
  }

  const anywhere = models.find(fuzzyMatch(target));
  if (anywhere !== undefined) throw new Error(substitutionError(anywhere));

  if (providerModels.length === 0) {
    throw new Error(
      `panel model "${configured}": provider "${configured.slice(0, slash)}" is not in the registry this session loaded; pi --list-models shows what pi can run`,
    );
  }
  // Known provider, no exact id, no fuzzy hijack: the id reaches the provider
  // verbatim, under the provider's registry casing.
  return `${providerModels[0].provider}/${pattern}`;
}

/**
 * Per-session panel model overrides (`/review-model`). Memory-only by design:
 * a new pi process starts empty, so the configured model resumes on the next
 * instance, and keying by session id keeps concurrently running sessions
 * isolated from each other's choices.
 */
export class PanelModelOverrides {
  private readonly bySession = new Map<string, string>();

  constructor(private readonly maxSessions: number) {}

  set(session: string, model: string): void {
    // Delete first so re-settling a session refreshes its recency: a Map
    // preserves insertion order, so an in-place set would let the oldest
    // session be evicted by the next newcomer.
    this.bySession.delete(session);
    if (this.bySession.size >= this.maxSessions) {
      const oldest = this.bySession.keys().next();
      if (!oldest.done) this.bySession.delete(oldest.value);
    }
    this.bySession.set(session, model);
  }

  /** Has this session stored an override? Drives the report's provenance tag. */
  has(session: string): boolean {
    return this.bySession.has(session);
  }

  clear(session: string): void {
    this.bySession.delete(session);
  }

  /** The session's override wins; the configured model is the fallback. */
  resolve(session: string, configured: string | undefined): string | undefined {
    return this.bySession.get(session) ?? configured;
  }
}
