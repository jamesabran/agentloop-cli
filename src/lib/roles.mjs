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
 * Value for a role when no agent is launched.
 *
 * The work for that role is done outside ALCLI — by a human, a different
 * tool, or an external process.  ALCLI does not launch an agent for the
 * role when this value is set.
 *
 * Valid for planner, implementer, and auditor.
 */
export const MANUAL_EXTERNAL = 'manual';

/**
 * Which logical roles each supported provider can fill.
 *
 * Every known provider supports every role at the configuration level.
 * The setup experience allows any assignment; the agent-router enforces
 * which combinations have working run functions at runtime.
 *
 * Adding a new provider means adding it here and supplying a run function in
 * the agent-router module.
 */
export const PROVIDER_CAPABILITIES = Object.freeze({
  claude: Object.freeze(['planner', 'implementer', 'auditor']),
  codex: Object.freeze(['planner', 'implementer', 'auditor']),
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

  // Manual / External is not a real provider — it signals that
  // ALCLI does not launch an agent for this role.  It is valid for
  // planner, implementer, and auditor.
  if (provider === MANUAL_EXTERNAL) {
    return { provider: MANUAL_EXTERNAL };
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
