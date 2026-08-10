/**
 * Agent role and provider abstraction.
 *
 * Three logical roles — planner, implementer, auditor — each mappable to a
 * supported provider ("claude", "codex").  The default mapping preserves the
 * existing Claude-implementer / Codex-auditor workflow so current users see
 * no behavioural regression.
 *
 * Provider-specific behaviour (Claude's permission settings, Codex's read-only
 * sandbox) belongs to provider configuration, not to the generic role.
 */

/** The three logical roles in the implement-and-review loop. */
export const LOGICAL_ROLES = Object.freeze(['planner', 'implementer', 'auditor']);

/**
 * Which logical roles each supported provider can fill.
 *
 * "claude" supports planner and implementer — it is the default workhorse.
 * "codex" supports auditor only — it is purpose-built for read-only review.
 *
 * Adding a new provider means adding it here and supplying a run function in
 * the agent-router module.
 */
export const PROVIDER_CAPABILITIES = Object.freeze({
  claude: Object.freeze(['planner', 'implementer']),
  codex: Object.freeze(['auditor']),
});

/**
 * Provider identity strings used in AGENTLOOP_AGENT_STATUS blocks.
 *
 * These are the values the status-block parser recognises as ROLE, and they
 * are tied to providers, not logical roles — so a status block reported by
 * Claude always says CLAUDE regardless of whether Claude was filling the
 * planner, implementer, or auditor role.
 */
export const PROVIDER_IDENTITIES = Object.freeze({
  claude: 'CLAUDE',
  codex: 'CODEX',
});

/**
 * The default role-to-provider mapping — exactly the existing workflow.
 *
 * @returns {{ planner: 'claude', implementer: 'claude', auditor: 'codex' }}
 */
export function defaultRoleMapping() {
  return Object.freeze({
    planner: 'claude',
    implementer: 'claude',
    auditor: 'codex',
  });
}

/**
 * Resolve a logical role to its provider against a mapping.
 *
 * Validates that the mapping entry is a known provider that actually supports
 * the role before returning, so callers never have to check capabilities
 * downstream.
 *
 * @param {string} role — one of LOGICAL_ROLES
 * @param {Record<string, string>} mapping — role → provider name
 * @returns {{ provider: string }}
 * @throws {Error} when the role has no provider, the provider is unknown, or
 *         the provider does not support the role
 */
export function resolveProvider(role, mapping) {
  const provider = mapping[role];
  if (!provider) {
    throw new Error(
      `No provider configured for role "${role}". ` +
        `Configured roles: ${JSON.stringify(mapping)}.`,
    );
  }

  const capabilities = PROVIDER_CAPABILITIES[provider];
  if (!capabilities) {
    throw new Error(
      `Unknown provider "${provider}" configured for role "${role}". ` +
        `Supported providers: ${Object.keys(PROVIDER_CAPABILITIES).join(', ')}.`,
    );
  }

  if (!capabilities.includes(role)) {
    throw new Error(
      `Provider "${provider}" does not support the "${role}" role. ` +
        `"${provider}" supports: ${capabilities.join(', ')}.`,
    );
  }

  return { provider };
}

/**
 * The status-block ROLE value for a given provider.
 *
 * @param {string} provider
 * @returns {string}
 */
export function getProviderIdentity(provider) {
  return PROVIDER_IDENTITIES[provider] ?? provider.toUpperCase();
}
