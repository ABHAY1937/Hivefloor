// Builds the environment an agent process starts with. Least privilege: an agent
// gets the stored keys its engine needs plus the ones the operator ticked for it,
// and nothing that merely looks like a credential in the app's own environment.
// (specs/002-secret-scoping)

/** Inherited variable names that look like credentials (SR-2). */
const CREDENTIAL_NAME =
  /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_PAT$|^AWS_|^AZURE_|^ARM_CLIENT|^GOOGLE_APPLICATION_CREDENTIALS$|^KUBECONFIG$|^DOCKER_AUTH|^NPM_CONFIG__AUTH|^SSH_AUTH_SOCK$|^GPG_AGENT_INFO$)/i;

export function looksLikeCredential(name: string): boolean {
  return CREDENTIAL_NAME.test(name);
}

export interface AgentEnvInput {
  /** The app's own environment (process.env). */
  inherited: Record<string, string | undefined>;
  /** All stored secrets, decrypted. */
  secrets: Record<string, string>;
  /** Secret names this agent may receive: provider keyEnv ∪ spec.secrets. */
  allowed: Iterable<string>;
  /** Provider-specific launch env (e.g. HIVE_LLM_*). */
  launch?: Record<string, string>;
  /** Harness variables; always win (SR-3). */
  harness: Record<string, string>;
}

export function buildAgentEnv(i: AgentEnvInput): Record<string, string> {
  const allowed = new Set(i.allowed);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(i.inherited)) {
    if (v === undefined) continue;
    if (looksLikeCredential(k) && !allowed.has(k)) continue;
    env[k] = v;
  }
  for (const k of allowed) if (Object.hasOwn(i.secrets, k)) env[k] = i.secrets[k];
  Object.assign(env, i.launch ?? {}, i.harness);
  return env;
}
