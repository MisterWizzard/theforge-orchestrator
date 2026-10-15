/**
 * Model routing.
 *
 * Cost minimisation is a routing goal, not an afterthought. The full cloud
 * pipeline runs about $2.50 per task, and most of what an agent system does all
 * day - triage, summarising a failure, reading a log, writing a commit message -
 * is nowhere near that hard. Routing exists to send each piece of work to the
 * cheapest tier that can actually do it.
 *
 * Four tiers, cheapest first:
 *
 *   0  deterministic   no model at all. A dependency bump is a package manager
 *                      command and a test run. Free, and more reliable than any
 *                      model because it cannot hallucinate a result.
 *   1  local fast      qwen3:8b at ~130 tok/s. Triage, classification, log
 *                      reading, summarisation, commit messages.
 *   2  local coding    devstral-small-2 at ~54 tok/s. Tightly specified edits:
 *                      single-file transforms, known codemods, one lint class.
 *   3  cloud           Claude. Open-ended repository work: architecture, real
 *                      debugging, multi-file features, anything requiring
 *                      exploration.
 *
 * Escalation is one-way and only on failure, so a task that a cheap tier can
 * finish never reaches an expensive one. Measured tier throughput and the
 * reasoning behind the model choices are recorded in ADR-018; the pipeline-role
 * policy (`routeRole`) in ADR-022.
 */

import {
  canStartCloudCall,
  DEFAULT_CEILING,
  roleEstimateUsd,
  type CeilingConfig,
  type CeilingVerdict,
  type UsageRecord,
} from './spend.js';

export type Tier = 0 | 1 | 2 | 3;

export const TIER_NAMES: Record<Tier, string> = {
  0: 'deterministic',
  1: 'local-fast',
  2: 'local-coding',
  3: 'cloud',
};

/** Models backing each tier. Tier 0 uses none. */
export const TIER_MODELS: Record<Tier, string | null> = {
  0: null,
  1: 'qwen3:8b',
  2: 'devstral-small-2:latest',
  3: 'claude',
};

/**
 * Cold-load time per local model, in seconds: the upper bound of what was
 * measured (docs/evidence-local-model-benchmark-2-2026-09-26.txt, legs 4 and
 * 4b: qwen3:8b 2.5-6.7 s across num_ctx and re-loads, devstral-small-2
 * 5.0-10.6 s). The two are never co-resident on the 24 GB card, so every tier
 * switch pays one of these. The figure annotates a decision; it never changes
 * a tier, because a ten-second reload is still cheaper than a cloud call.
 */
export const MODEL_LOAD_SECONDS: Readonly<Record<string, number>> = {
  'qwen3:8b': 6.7,
  'devstral-small-2:latest': 10.6,
};

/** What Ollama currently has loaded, as `listLoadedModels` reports it. */
export type Residency = { loadedModels: readonly string[] };

/**
 * Work classes, mapped to the cheapest tier that can do them.
 *
 * Keep this list concrete. A vague class invites everything to be routed to
 * tier 3 "to be safe", which is how a cost control quietly stops working.
 */
export type WorkClass =
  | 'dependency_bump'
  | 'lint_fix'
  | 'format_fix'
  | 'lockfile_regen'
  | 'known_codemod'
  | 'triage'
  | 'classify'
  | 'summarise'
  | 'read_logs'
  | 'commit_message'
  | 'pr_description'
  | 'interpret_test_failure'
  | 'single_file_edit'
  | 'mechanical_refactor'
  | 'architecture'
  | 'debugging'
  | 'multi_file_feature'
  | 'security_review'
  | 'code_review';

export const WORK_CLASS_TIER: Record<WorkClass, Tier> = {
  // Tier 0 - no model can beat running the command.
  dependency_bump: 0,
  lint_fix: 0,
  format_fix: 0,
  lockfile_regen: 0,
  known_codemod: 0,
  // Tier 1 - frequent, cheap, and local handles it well.
  triage: 1,
  classify: 1,
  summarise: 1,
  read_logs: 1,
  commit_message: 1,
  pr_description: 1,
  interpret_test_failure: 1,
  // Tier 2 - narrow, well-specified edits.
  single_file_edit: 2,
  mechanical_refactor: 2,
  // Tier 3 - open-ended, where the quality difference is real.
  architecture: 3,
  debugging: 3,
  multi_file_feature: 3,
  security_review: 3,
  code_review: 3,
};

export type RouteRequest = {
  workClass: WorkClass;
  /** How many times this task has already failed. Each failure escalates. */
  priorFailures?: number;
  /** Usage so far today, for the ceiling check. */
  usage?: readonly UsageRecord[];
  ceiling?: CeilingConfig;
  /**
   * What this call is expected to cost on the cloud, in USD. With `usage`
   * present, a projected crossing (`spent + estimatedUsd > dailyUsd`) demotes
   * tier 3 exactly as a reached ceiling does (ADR-028); exactly the ceiling is
   * allowed, as the dispatch guard allows it. Without it only recorded spend
   * counts.
   */
  estimatedUsd?: number;
  now?: Date;
  /** IANA zone that defines the ceiling's day; defaults to the operator's (Australia/Sydney). */
  timeZone?: string;
  /** Force a floor, e.g. the operator marked a task as hard. */
  minimumTier?: Tier;
  /** What is loaded right now. Annotates the decision; never moves it. */
  residency?: Residency;
};

export type RouteDecision = {
  tier: Tier;
  tierName: string;
  model: string | null;
  /** Why this tier, in a form worth reading in a log. */
  reason: string;
  /** True when the decision was changed by the spend ceiling. */
  ceilingApplied: boolean;
  /**
   * True when the chosen model is not resident and Ollama will load it first.
   * Without residency information a local model is assumed cold, which is the
   * estimate that errs on the side of the wait actually observed.
   */
  requiresLoad: boolean;
  /** Seconds the load is expected to take; zero when nothing loads. */
  estimatedLoadSeconds: number;
};

/**
 * Choose a tier.
 *
 * Every escalation is logged with its reason, so the routing table can be tuned
 * from evidence rather than from opinion about what models are good at.
 */
export function route(request: RouteRequest): RouteDecision {
  const base = WORK_CLASS_TIER[request.workClass];
  const failures = Math.max(0, request.priorFailures ?? 0);

  // One tier per failure. A task that a cheap tier can finish never reaches an
  // expensive one; a task that keeps failing climbs until it runs out of tiers.
  let tier = Math.min(3, base + failures) as Tier;
  let reason =
    failures === 0
      ? `${request.workClass} routes to ${TIER_NAMES[base]} by default`
      : `${request.workClass} escalated ${failures} tier(s) after ${failures} failure(s)`;

  if (request.minimumTier !== undefined && request.minimumTier > tier) {
    tier = request.minimumTier;
    reason = `${request.workClass} raised to ${TIER_NAMES[tier]} because the task was marked harder than its class`;
  }

  // The ceiling only ever pushes work down, never up. Tier 0 work is unaffected
  // because it costs nothing to begin with. The check is the same one the
  // coordinator's dispatch guard makes before a cloud call, with the same
  // estimate, so a stage the router sends to the cloud is one the guard will
  // let through: a reached ceiling and a projected crossing both demote.
  let ceilingApplied = false;
  if (tier === 3 && request.usage) {
    const config = request.ceiling ?? DEFAULT_CEILING;
    const estimatedUsd = Math.max(0, request.estimatedUsd ?? 0);
    const call = canStartCloudCall(
      request.usage,
      estimatedUsd,
      request.now ?? new Date(),
      config,
      request.timeZone,
    );
    if (!call.allowed) {
      tier = 2;
      ceilingApplied = true;
      reason = `would route to cloud, but ${
        call.ceiling.routing === 'local-only'
          ? call.ceiling.message
          : projectedCrossing(call.ceiling, estimatedUsd, config)
      }`;
    }
  }

  const model = TIER_MODELS[tier];
  return {
    tier,
    tierName: TIER_NAMES[tier],
    model,
    reason,
    ceilingApplied,
    ...loadAnnotation(tier, model, request.residency),
  };
}

/**
 * The reason for a demotion the day has not yet earned: the ceiling stands, but
 * this call's estimate would carry the total past it. Worded apart from the
 * guard's own refusal ("estimated $x would take today's total to ...") so a
 * log reader can tell a routing decision from a dispatch refusal.
 */
function projectedCrossing(
  ceiling: CeilingVerdict,
  estimatedUsd: number,
  config: CeilingConfig,
): string {
  const projected = ceiling.spentTodayUsd + estimatedUsd;
  return `projected $${projected.toFixed(2)} ($${ceiling.spentTodayUsd.toFixed(2)} spent on ${ceiling.day} ${ceiling.timeZone} + $${estimatedUsd.toFixed(2)} estimated) would pass the $${config.dailyUsd.toFixed(2)} ceiling; routing to local models only`;
}

function loadAnnotation(
  tier: Tier,
  model: string | null,
  residency: Residency | undefined,
): Pick<RouteDecision, 'requiresLoad' | 'estimatedLoadSeconds'> {
  // Tier 0 has no model, and the cloud loads nothing on this machine.
  if (model === null || tier === 3) return { requiresLoad: false, estimatedLoadSeconds: 0 };
  const resident = residency?.loadedModels.some((loaded) => sameModel(loaded, model)) ?? false;
  if (resident) return { requiresLoad: false, estimatedLoadSeconds: 0 };
  return {
    requiresLoad: true,
    // An unlisted local model gets the slowest known load rather than zero.
    estimatedLoadSeconds:
      MODEL_LOAD_SECONDS[model] ?? Math.max(...Object.values(MODEL_LOAD_SECONDS)),
  };
}

/** `devstral-small-2` and `devstral-small-2:latest` are the same model to Ollama. */
function sameModel(a: string, b: string): boolean {
  const strip = (name: string) => (name.endsWith(':latest') ? name.slice(0, -7) : name);
  return strip(a) === strip(b);
}

/**
 * Pipeline roles and the policy that places them (ADR-022).
 *
 * All four roles are cloud work by default. When the daily ceiling says
 * local-only - the day has reached it, or the stage's own estimate would carry
 * the day past it (ADR-028) - the planner and the critic may drop to tier 2:
 * they read and write text, which devstral can do in a worktree it never
 * touches. The builder and the reviewer never run locally. The builder needs
 * an agentic, file-editing CLI that no local model has; a local reviewer would
 * weaken the merge gate, which is the one place a cheaper model must not be
 * substituted. Tier 1 is for the light work classes above and is never a
 * pipeline role's tier - `routeRole` fixes tier 2 as the floor, so a future
 * edit to the class table cannot quietly send a role to qwen3.
 */
export type PipelineRole = 'planner' | 'critic' | 'builder' | 'reviewer';

export const ROLE_WORK_CLASS: Readonly<Record<PipelineRole, WorkClass>> = {
  planner: 'architecture',
  critic: 'code_review',
  builder: 'multi_file_feature',
  reviewer: 'code_review',
};

/** Roles the ceiling may move to tier 2. Every other role stops the run instead. */
export const LOCAL_FALLBACK_ROLES: readonly PipelineRole[] = ['planner', 'critic'];

/** Adapter ids that are cloud providers, in the order preferred for a substitute. */
export const CLOUD_PROVIDER_IDS = ['claude', 'codex'] as const;
/** The adapter id that fronts Ollama. */
export const LOCAL_PROVIDER_ID = 'ollama';

export type CloudProviderId = (typeof CLOUD_PROVIDER_IDS)[number];

/**
 * The cloud provider every pipeline role runs on unless the run pins the role
 * to another one (ADR-024). Codex is an explicit choice for evidence runs,
 * never a default; the pipeline falls back to the first authenticated cloud
 * adapter only when this one is not authenticated.
 */
export const DEFAULT_CLOUD_PROVIDER_ID: CloudProviderId = 'claude';
export type RoutedProviderId = CloudProviderId | typeof LOCAL_PROVIDER_ID;

export function isCloudProviderId(value: string): value is CloudProviderId {
  return (CLOUD_PROVIDER_IDS as readonly string[]).includes(value);
}

export type RoleRouteRequest = {
  role: PipelineRole;
  /** Providers that already failed this stage. Each failure escalates. */
  priorFailures?: number;
  usage?: readonly UsageRecord[];
  ceiling?: CeilingConfig;
  timeZone?: string;
  now?: Date;
  residency?: Residency;
  /**
   * What the stage is expected to cost on the cloud; defaults to the role's
   * figure in ROLE_ESTIMATES_USD, the table the dispatch guard checks against.
   */
  estimatedUsd?: number;
  /** Ids of the adapters that diagnosed as available and authenticated. */
  availableProviderIds: readonly string[];
  /** The role's configured cloud provider, from the run configuration. */
  cloudProviderId?: CloudProviderId;
  /** Providers that already failed this stage; never chosen for it again. */
  excludeProviderIds?: readonly string[];
};

export type RoleRouteDecision = RouteDecision & {
  role: PipelineRole;
  workClass: WorkClass;
  /**
   * The adapter to call, or null when the stage must not run. For a cloud
   * decision `model` is null too: the cloud adapter picks its own model, and
   * the tier's `claude` label is not a model name to put on a request.
   */
  providerId: RoutedProviderId | null;
  allowed: boolean;
  /**
   * The cloud estimate the decision was made with. For a cloud decision it is
   * what the dispatch guard will check the call against; for a demoted one it
   * is what would have been spent.
   */
  estimatedUsd: number;
};

/**
 * Place one pipeline stage.
 *
 * Tier 3 goes to the role's configured cloud provider, or to another available
 * cloud provider when that one is unavailable or has already failed the stage.
 * Tier 2 goes to Ollama, and only for a role in LOCAL_FALLBACK_ROLES; any
 * other role, or a missing local adapter, yields `allowed: false` with a reason
 * that names the policy, so the pipeline ends the run as a policy stop before
 * a dispatch the guards would refuse anyway.
 */
export function routeRole(request: RoleRouteRequest): RoleRouteDecision {
  const workClass = ROLE_WORK_CLASS[request.role];
  const estimatedUsd = Math.max(0, request.estimatedUsd ?? roleEstimateUsd(request.role));
  const decision = route({
    workClass,
    minimumTier: 2,
    estimatedUsd,
    ...(request.priorFailures !== undefined ? { priorFailures: request.priorFailures } : {}),
    ...(request.usage ? { usage: request.usage } : {}),
    ...(request.ceiling ? { ceiling: request.ceiling } : {}),
    ...(request.timeZone ? { timeZone: request.timeZone } : {}),
    ...(request.now ? { now: request.now } : {}),
    ...(request.residency ? { residency: request.residency } : {}),
  });
  const excluded = new Set(request.excludeProviderIds ?? []);
  const usable = request.availableProviderIds.filter((id) => !excluded.has(id));
  const placed = { ...decision, role: request.role, workClass, estimatedUsd };

  if (decision.tier === 3) {
    const cloud = usable.filter(isCloudProviderId);
    const configured = request.cloudProviderId;
    const chosen = configured && cloud.includes(configured) ? configured : cloud[0];
    if (!chosen) {
      const tried = [...excluded].join(', ') || 'none';
      const listed = request.availableProviderIds.join(', ') || 'none';
      return {
        ...placed,
        model: null,
        providerId: null,
        allowed: false,
        reason: `no cloud provider remains for ${request.role} (failed: ${tried}; available: ${listed})`,
      };
    }
    const reason =
      configured && chosen !== configured
        ? `${decision.reason}; ${configured} ${excluded.has(configured) ? 'failed this stage' : 'is not available'}, substituting ${chosen}`
        : decision.reason;
    return { ...placed, model: null, providerId: chosen, allowed: true, reason };
  }

  // Tier 2: the ceiling demoted the stage. Tiers 1 and 0 cannot occur because
  // of the floor above, and would be refused here as well if they did. A
  // refusal is a policy stop - the pipeline ends the run partially_completed -
  // not a pause, and the wording says so.
  if (decision.tier !== 2 || !LOCAL_FALLBACK_ROLES.includes(request.role)) {
    return {
      ...placed,
      model: null,
      providerId: null,
      allowed: false,
      reason: `${request.role} must not run locally; stopping the run at the ceiling (${decision.reason})`,
    };
  }
  // A local-capable role with nothing local to run on stops the run rather
  // than spends (Q26): the ceiling is not a reason to go to the cloud.
  if (!usable.includes(LOCAL_PROVIDER_ID)) {
    const why = excluded.has(LOCAL_PROVIDER_ID)
      ? `${LOCAL_PROVIDER_ID} failed this stage and no other local provider exists`
      : `no ${LOCAL_PROVIDER_ID} provider is available`;
    return {
      ...placed,
      model: null,
      providerId: null,
      allowed: false,
      reason: `${request.role} may run locally but ${why}; stopping the run at the ceiling (${decision.reason})`,
    };
  }
  return {
    ...placed,
    providerId: LOCAL_PROVIDER_ID,
    allowed: true,
    reason: `${decision.reason}; ${request.role} runs locally on ${decision.model}`,
  };
}

/**
 * What a run would have cost had everything gone to the cloud, against what it
 * actually did. This is the number that says whether routing is working, and it
 * belongs in the daily digest rather than in someone's head.
 */
export function routingSavings(
  decisions: readonly RouteDecision[],
  cloudCostPerTask = 2.5,
): { routed: number; cloudTasks: number; freeTasks: number; estimatedSavingUsd: number } {
  const cloudTasks = decisions.filter((d) => d.tier === 3).length;
  const freeTasks = decisions.length - cloudTasks;
  return {
    routed: decisions.length,
    cloudTasks,
    freeTasks,
    estimatedSavingUsd: freeTasks * cloudCostPerTask,
  };
}
