import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { BotConfig, FleetConfig } from "../config.ts";
import { checkRoute } from "../config.ts";
import {
  GatewayJournal,
  GatewayJournalError,
  payloadDigest,
  type ConversationBinding,
  type EventProjection,
  type JsonObject,
  type OperationDisposition,
  type OperationRecord,
  type WriterLease,
} from "./journal.ts";
import {
  decodeArtifactUploads,
  MAX_PUBLIC_ARTIFACT_BYTES,
  VALIDATED_MEDIA_TYPES,
} from "./artifacts.ts";
import { PluginHost, type HostCall } from "./plugin-host.ts";
import {
  processIdentity,
  ownerHasExited,
  reconcileOwnedProcess,
} from "./process-ownership.ts";
import { PluginRegistry, type PluginInstallation } from "./registry.ts";
import {
  permissionRequest,
  permissionResolution,
  permissionKey,
} from "./permissions.ts";
import {
  questionRequest,
  questionResolution,
  questionKey,
} from "./questions.ts";
import {
  object,
  ProtocolError,
  type CapabilityDescriptor,
  type GatewayPluginEvent,
} from "./protocol.ts";

export const GATEWAY_CAPABILITIES = [
  "messages",
  "turn-parts",
  "ws-auth-bearer",
  "backend-capabilities-v1",
  "operation-receipts-v1",
];
/** Startup could not establish enough ownership evidence to permit legacy takeover. */
export class GatewayStartupOwnershipError extends ProtocolError {
  constructor(error: unknown) {
    super(
      object(error) && typeof error.code === "string"
        ? error.code
        : "ownership_unreconciled",
      "Gateway startup ownership requires reconciliation"
    );
  }
}
const terminal = new Set(["ended", "failed", "cancelled", "interrupted"]);
interface MessageView {
  sourceSequence: number;
  id: string;
  order: number;
  blocks: Map<string, { revision: number; text: string; order: number }>;
  finished: boolean;
  entry?: JsonObject;
  emitted?: boolean;
}
interface ToolView {
  sourceSequence: number;
  part: JsonObject;
  finished: boolean;
  entry?: JsonObject;
  emitted?: boolean;
}
interface TurnView {
  operationId: string;
  turnId: string;
  messages: Map<string, MessageView>;
  tools: Map<string, ToolView>;
}
interface BoundBot {
  config: BotConfig;
  binding: ConversationBinding;
  installation: PluginInstallation;
  capabilities: CapabilityDescriptor;
  host?: PluginHost;
  ready: boolean;
  pump?: Promise<void>;
  permissionPump?: Promise<void>;
  questionPump?: Promise<void>;
  pumpAgain?: boolean;
  permissionPumpAgain?: boolean;
  questionPumpAgain?: boolean;
  fault?: string;
  turns: Map<string, TurnView>;
}

/** Public policy is deliberately narrowed to routes and projections implemented here. */
function effectiveCapabilities(
  native: CapabilityDescriptor,
  artifactAccess = false
): CapabilityDescriptor {
  return {
    input: {
      text: true,
      mediaTypes: artifactAccess
        ? native.input.mediaTypes.filter((type) =>
            VALIDATED_MEDIA_TYPES.includes(type)
          )
        : [],
      maxMediaBytes: artifactAccess
        ? Math.min(native.input.maxMediaBytes, MAX_PUBLIC_ARTIFACT_BYTES)
        : 0,
    },
    sessions: {
      load: native.sessions.load && native.sessions.continuity === "verified",
      import: false,
      continuity:
        native.sessions.load && native.sessions.continuity === "verified"
          ? "verified"
          : "unverified",
    },
    output: {
      text: native.output.text,
      tools: native.output.tools,
      usage: "unknown",
    },
    operations: { ...native.operations, steer: false },
    interactions: {
      permissions: native.interactions.permissions,
      questions: native.interactions.questions,
    },
    configuration: {
      model: native.configuration.model,
      thinking: native.configuration.thinking,
      compact: native.configuration.compact,
    },
    fleetTools: false,
  };
}

function pluginEnvironment(fleet: FleetConfig): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of fleet.gateway!.environment) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]!;
  }
  return environment;
}
function bindingPolicy(
  fleet: FleetConfig,
  bot: BotConfig,
  installation: PluginInstallation
): string {
  return payloadDigest({
    artifact: installation.digest,
    config: bot.backendConfig ?? {},
    workspace: bot.dir,
    policy: fleet.gateway!.policy,
    environment: pluginEnvironment(fleet),
  });
}

export interface GatewayPluginInstance {
  botName: string;
  bindingId: string;
  instanceId: string;
  leaseGeneration: number;
}

export interface GatewayPluginFault extends GatewayPluginInstance {
  code: string;
}

/** Neutral orchestration: no native runtime commands, model parsing, or backend switches. */
export class GatewayApplication {
  readonly bootId = randomUUID();
  readonly journal: GatewayJournal;
  private lease: WriterLease;
  private readonly bots = new Map<string, BoundBot>();
  private readonly subscribers = new Set<(event: JsonObject) => void>();
  private emitted = 0;
  private renewal?: ReturnType<typeof setInterval>;
  private stopping = false;
  private stopped?: Promise<void>;
  readonly fleet: FleetConfig;
  private readonly log: (line: string) => void;
  private readonly onPluginFault?: (fault: GatewayPluginFault) => void;
  private readonly onPluginReady?: (instance: GatewayPluginInstance) => void;

  private constructor(
    fleet: FleetConfig,
    log: (line: string) => void,
    journal: GatewayJournal,
    lease: WriterLease,
    onPluginFault?: (fault: GatewayPluginFault) => void,
    onPluginReady?: (instance: GatewayPluginInstance) => void
  ) {
    this.onPluginFault = onPluginFault;
    this.onPluginReady = onPluginReady;
    this.fleet = fleet;
    this.log = log;
    this.journal = journal;
    let acquired: WriterLease | undefined;
    try {
      this.lease = acquired = lease;
      this.emitted = this.journal.publicSequence;
      this.journal.recoverInterrupted(this.lease);
    } catch (error) {
      // No plugin has started. If acquisition succeeded, release only with this
      // local proof; a failed recovery write may still require operator repair.
      try {
        if (acquired)
          this.journal.releaseWriterLease(acquired, {
            ownershipReconciled: true,
          });
      } catch {
        /* Preserve storage failure. */
      }
      this.journal.close();
      throw error;
    }
    this.renewal = setInterval(() => {
      try {
        this.lease = this.journal.renewWriterLease(this.lease);
      } catch {
        this.log(
          "[gateway] writer lease lost; stopping admission and owned plugins"
        );
        void this.stop().catch(() => {
          this.log(
            "[gateway] plugins stopped; writer ownership requires explicit recovery"
          );
        });
      }
    }, 5_000);
    this.renewal.unref();
  }

  static async start(
    fleet: FleetConfig,
    log: (line: string) => void = () => {},
    onCreated?: (application: GatewayApplication) => void,
    onPluginFault?: (fault: GatewayPluginFault) => void,
    onPluginReady?: (instance: GatewayPluginInstance) => void
  ): Promise<GatewayApplication> {
    if (!fleet.gateway)
      throw new ProtocolError("invalid_config", "Gateway registry is required");
    const registry = await PluginRegistry.load(fleet.gateway.registry, {
      policy: fleet.gateway.policy,
    });
    // Every selected schema is checked before the first executable starts.
    for (const bot of fleet.bots) {
      const installation = registry.resolve(bot.backend!);
      if (!installation.validateConfig(bot.backendConfig ?? {}))
        throw new ProtocolError(
          "invalid_config",
          `Invalid backend configuration for ${bot.name}`
        );
      if (bot.routines.length)
        throw new ProtocolError(
          "capability_unavailable",
          "Gateway routine dispatch is not yet available; remove routines before enabling gateway mode"
        );
    }
    let journal: GatewayJournal | undefined;
    let app: GatewayApplication;
    try {
      journal = new GatewayJournal(join(fleet.dir, ".fleet", "gateway.sqlite"));
      const previous = journal.getWriterState();
      let reconciled = false;
      if (previous && !previous.reconciled) {
        if (previous.ownerId && previous.expiresAt > Date.now())
          throw new ProtocolError(
            "writer_busy",
            "Previous gateway writer lease has not expired"
          );
        const ownership = journal.getSupervisorRecord();
        if (!ownership || !(await ownerHasExited(ownership.ownerProcess)))
          throw new ProtocolError(
            "ownership_unreconciled",
            "Previous gateway process ownership is unverified"
          );
        for (const launch of ownership.launches) {
          // Prepared launches cannot pass the private activation gate. Stopped
          // launches were already proven empty before their durable transition.
          if (launch.state === "started") await reconcileOwnedProcess(launch);
        }
        reconciled = true;
      }
      const lease = journal.acquireWriterLease(`gateway-${randomUUID()}`, {
        ownerProcess: await processIdentity(process.pid),
        previousOwnerReconciled: reconciled,
        ...(previous ? { previousGeneration: previous.generation } : {}),
      });
      app = new GatewayApplication(
        fleet,
        log,
        journal,
        lease,
        onPluginFault,
        onPluginReady
      );
    } catch (error) {
      journal?.close();
      // A storage-version refusal happens before the journal acquires a lease
      // or any plugin is started.  It is a deterministic preflight failure,
      // so the outer fleet lock can be released safely for callers inspecting
      // or removing the disposable directory.
      if (
        journal === undefined &&
        error instanceof GatewayJournalError &&
        error.code === "incompatible_storage"
      )
        throw error;
      throw new GatewayStartupOwnershipError(error);
    }
    try {
      onCreated?.(app);
      // A later invalid binding must not discover its conflict after earlier
      // bots have already crossed a native session creation boundary.
      for (const config of fleet.bots) {
        const known = app.journal.botByName(config.name);
        if (!known) continue;
        const prior = app.journal
          .listConversations()
          .filter((binding) => binding.botId === known.botId);
        if (
          prior.length > 1 ||
          prior.some(
            (binding) =>
              binding.policyRevision !==
              bindingPolicy(fleet, config, registry.resolve(config.backend!))
          )
        ) {
          throw new ProtocolError(
            "binding_conflict",
            "Explicit conversation or binding cutover is required before startup"
          );
        }
      }
      for (const config of fleet.bots)
        await app.bind(config, registry.resolve(config.backend!));
      app.publishRoster();
      app.deliverCompletions();
      for (const bot of app.bots.values()) void app.pump(bot);
      return app;
    } catch (error) {
      await app.stop();
      throw error;
    }
  }

  private async bind(
    config: BotConfig,
    installation: PluginInstallation
  ): Promise<void> {
    const { botId } = this.journal.ensureBot(this.lease, config.name);
    const prior = this.journal
      .listConversations()
      .filter((binding) => binding.botId === botId);
    if (prior.length > 1)
      throw new ProtocolError(
        "binding_conflict",
        "Explicit conversation selection is required"
      );
    const allowedEnv = pluginEnvironment(this.fleet);
    const policyRevision = bindingPolicy(this.fleet, config, installation);
    if (prior[0] && prior[0].policyRevision !== policyRevision)
      throw new ProtocolError(
        "binding_conflict",
        "Configuration changed; an explicit binding cutover is required"
      );
    const bindingId = prior[0]?.bindingId ?? `binding-${randomUUID()}`;
    let bot: BoundBot | undefined;
    let provisioned!: () => void;
    const provision = new Promise<void>((resolve) => {
      provisioned = resolve;
    });
    let host: PluginHost | undefined;
    try {
      host = await PluginHost.start({
        installation,
        bindingId,
        leaseGeneration: this.lease.generation,
        config: config.backendConfig ?? {},
        workspace: config.dir,
        dataDir: join(this.fleet.dir, ".fleet", "plugins", bindingId),
        requireExistingData: !!prior[0],
        allowedEnv,
        onLaunchPrepared: (launchId, parentLaunchId) => {
          this.journal.prepareOwnedLaunch(this.lease, {
            launchId,
            bindingId,
            ...(parentLaunchId ? { parentLaunchId } : {}),
          });
        },
        onLaunchRecorded: (launchId, identity) => {
          this.journal.recordOwnedLaunch(this.lease, launchId, identity);
        },
        onLaunchStopped: (launchId) => {
          this.journal.completeOwnedLaunch(this.lease, launchId);
        },
        lastAcknowledgedSequence: prior[0]
          ? this.journal.sourceAck(bindingId)
          : 0,
        onEvent: async (event) => {
          // A valid post-initialize event can share the response's stdout chunk.
          // Let binding creation and replay finish before crossing into storage.
          await provision;
          if (!bot)
            throw new ProtocolError(
              "not_initialized",
              "Event arrived before the binding was provisioned"
            );
          return this.receive(bot, event);
        },
        onHostCall: async (call) => {
          await provision;
          if (!bot || this.stopping || !bot.ready)
            throw new ProtocolError(
              "not_initialized",
              "Fleet service binding is unavailable"
            );
          if (call.name === "artifact.read")
            return this.readPluginArtifact(bot, call);
          if (call.name === "fleet.send") return this.sendFleet(bot, call);
          if (call.name !== "fleet.discover")
            throw new ProtocolError(
              "capability_unavailable",
              "Gateway host service is not implemented"
            );
          if (
            !object(call.arguments) ||
            Object.keys(call.arguments).length !== 0
          )
            throw new ProtocolError(
              "invalid_payload",
              "Fleet discovery accepts no routing or identity overrides"
            );
          return {
            origin: bot.config.name,
            bots: [...this.bots.values()]
              .filter(
                (target) =>
                  checkRoute(
                    bot!.config.name,
                    target.config.name,
                    this.fleet.bots
                  ).ok
              )
              .map((target) => ({
                name: target.config.name,
                title: target.config.title ?? "",
                description: target.config.description ?? "",
                online: target.ready && !!target.host?.isReady,
                backend: target.installation.manifest.id,
              })),
          };
        },
        onFailure: (error, identity) => {
          // Startup failure may be waiting for a queued event callback to drain.
          // Release its provisioning wait before PluginHost.start awaits close.
          provisioned();
          try {
            this.onPluginFault?.({
              botName: config.name,
              bindingId: identity.bindingId,
              instanceId: identity.instanceId,
              leaseGeneration: identity.leaseGeneration,
              code: error.code,
            });
          } catch {
            // Read-only diagnostics must not change host supervision.
          }
          if (bot) this.failBot(bot, error.code);
        },
      });
      const capabilities = effectiveCapabilities(
        host.capabilities,
        installation.policy.gatewayTools?.includes("artifact.read") === true &&
          installation.manifest.requestedAccess.gatewayTools.includes(
            "artifact.read"
          )
      );
      const bindingRevision = payloadDigest({
        bindingId,
        policyRevision,
        capabilities,
      });
      const binding = this.journal.ensureConversation(this.lease, {
        botId,
        conversationId:
          prior[0]?.conversationId ?? `conversation-${randomUUID()}`,
        bindingId,
        bindingRevision,
        policyRevision,
      });
      bot = {
        config,
        installation,
        binding,
        capabilities,
        host,
        ready: false,
        turns: new Map(),
      };
      this.bots.set(config.name, bot);
      try {
        this.onPluginReady?.({
          botName: config.name,
          bindingId,
          instanceId: host.instanceId,
          leaseGeneration: this.lease.generation,
        });
      } catch {
        // Read-only diagnostics must not change host supervision.
      }
      // Rebuild only from committed, ordered source observations. Replaying history
      // does not append entries, emit completions, or contact the native runtime.
      let cursor = 0;
      for (;;) {
        const events = this.journal.readSourceEvents(bindingId, cursor);
        if (!events.length) break;
        for (const event of events) {
          this.project(bot, event as unknown as GatewayPluginEvent);
          cursor = event.sourceSequence;
        }
      }
      this.journal.closePermissions(
        this.lease,
        binding,
        config.name,
        host.instanceId
      );
      provisioned();
      if (host.health !== "ready") {
        bot.fault = host.health;
        return;
      }
      let openId = `open:${binding.conversationId}`;
      const existing = this.journal.getOperation({
        ...binding,
        operationId: openId,
      });
      if (existing) {
        if (
          existing.delivery !== "accepted" ||
          existing.execution !== "ended" ||
          existing.observation !== "complete" ||
          existing.result?.status !== "opened" ||
          typeof existing.result.nativeReference !== "string"
        ) {
          bot.fault = "creation_unknown";
          return;
        }
        if (!capabilities.sessions.load) {
          bot.fault = "continuity_unverified";
          return;
        }
        // A queued load from a dead owner never entered a native handler. Retire
        // it so a later message pump cannot dispatch it as ordinary user work.
        for (const operation of this.journal.listOperationRecords(binding)) {
          if (
            operation.receipt.kind === "session_open" &&
            operation.payload?.mode === "load" &&
            operation.receipt.delivery === "queued"
          )
            this.journal.cancelQueued(this.lease, operation.receipt);
        }
        openId = `load:${binding.conversationId}:${host.instanceId}`;
      }
      const mode = existing ? "load" : "new";
      const nativeReference = existing?.result?.nativeReference;
      const payload = {
        mode,
        cwd: config.dir,
        policyRevision,
        ...(existing ? { nativeReference: nativeReference! } : {}),
      };
      this.journal.admit(this.lease, {
        ...binding,
        operationId: openId,
        kind: "session_open",
        payload,
      });
      const reserved = this.journal.reserveNext(
        this.lease,
        binding,
        existing ? { sessionLoadId: openId } : {}
      );
      if (!reserved) {
        this.journal.cancelQueued(this.lease, {
          ...binding,
          operationId: openId,
        });
        bot.fault = "reconciliation_required";
        return;
      }
      let response: unknown;
      try {
        response = await host.request("session.open", {
          openId,
          operationId: openId,
          payloadDigest: reserved.payloadDigest,
          conversationId: binding.conversationId,
          ...payload,
        });
      } catch {
        this.journal.recordDisposition(
          this.lease,
          { ...binding, operationId: openId },
          {
            delivery: "unknown",
            execution: "unknown",
            observation: "reconciliation_required",
          }
        );
        bot.fault = existing ? "continuity_unverified" : "creation_unknown";
        return;
      }
      if (
        !object(response) ||
        typeof response.nativeReference !== "string" ||
        !response.nativeReference ||
        response.status !== "opened" ||
        (existing &&
          (response.nativeReference !== nativeReference ||
            response.continuity !== "verified"))
      ) {
        this.journal.recordDisposition(
          this.lease,
          { ...binding, operationId: openId },
          {
            delivery: "unknown",
            execution: "unknown",
            observation: "reconciliation_required",
          }
        );
        bot.fault = existing ? "continuity_unverified" : "creation_unknown";
        return;
      }
      this.journal.recordDisposition(
        this.lease,
        { ...binding, operationId: openId },
        {
          delivery: "accepted",
          execution: "ended",
          result: {
            nativeReference: response.nativeReference,
            status: "opened",
          },
        }
      );
      bot.ready = host.isReady && host.health === "ready";
    } catch (error) {
      provisioned();
      await host?.close();
      throw error;
    }
  }

  private requireBot(name: string): BoundBot {
    const bot = this.bots.get(name);
    if (!bot) throw new ProtocolError("bot_not_found", "Unknown bot");
    return bot;
  }
  binding(name: string): JsonObject {
    const bot = this.requireBot(name);
    return {
      fleetId: this.journal.fleetId,
      botId: bot.binding.botId,
      conversationId: bot.binding.conversationId,
      bindingId: bot.binding.bindingId,
      bindingRevision: bot.binding.bindingRevision,
      backend: {
        id: bot.installation.manifest.id,
        version: bot.installation.manifest.version,
      },
      capabilities: bot.capabilities as unknown as JsonObject,
    };
  }
  roster(): JsonObject {
    const bots = [...this.bots.values()].map((bot) => {
      const operations = this.journal
        .listOperationRecords(bot.binding)
        .filter((op) => !op.receipt.kind);
      const transcript = this.journal.readTranscript(bot.binding);
      return {
        name: bot.config.name,
        title: bot.config.title ?? "",
        description: bot.config.description ?? "",
        avatar: bot.config.avatar,
        online: bot.ready && !!bot.host?.isReady,
        active: operations.some((op) =>
          ["running", "waiting_for_input", "cancel_requested"].includes(
            op.receipt.execution
          )
        ),
        lastActive: transcript.at(-1)?.ts ?? "",
        latest: transcript.at(-1)?.text ?? "",
        queued: operations.filter((op) => op.receipt.delivery === "queued")
          .length,
        ...(bot.fault ? { gatewayStatus: bot.fault } : {}),
        gateway: this.binding(bot.config.name),
      };
    });
    return {
      fleetId: this.journal.fleetId,
      capabilities: [...GATEWAY_CAPABILITIES],
      bots,
      counts: {
        total: bots.length,
        active: bots.filter((bot) => bot.active).length,
      },
    };
  }
  readImage(name: string, file: string): { mediaType: string; bytes: Buffer } {
    return this.journal.readImage(this.requireBot(name).binding, file);
  }
  transcript(name: string): JsonObject[] {
    return this.journal.readTranscript(this.requireBot(name).binding);
  }
  private sendFleet(
    origin: BoundBot,
    call: Record<string, unknown>
  ): JsonObject {
    const args = call.arguments;
    if (
      !object(args) ||
      Object.keys(args).some((key) => !["target", "text"].includes(key)) ||
      typeof args.target !== "string" ||
      typeof args.text !== "string" ||
      !args.text.trim() ||
      ![call.operationId, call.toolCallId, call.actionId].every(
        (value) => typeof value === "string" && value.length > 0
      )
    )
      throw new ProtocolError(
        "invalid_payload",
        "Fleet send requires a target, text and correlated native action"
      );
    const route = checkRoute(origin.config.name, args.target, this.fleet.bots);
    if (!route.ok)
      throw new ProtocolError(route.reason, "Fleet route is unavailable");
    const target = this.requireBot(args.target);
    const scope = {
      origin: { ...origin.binding, operationId: String(call.operationId) },
      toolCallId: String(call.toolCallId),
      actionId: String(call.actionId),
    };
    const known = this.journal.hasFleetDispatch(scope);
    if (!known && (!target.ready || !target.host?.isReady))
      throw new ProtocolError(
        "session_unavailable",
        "Fleet target cannot admit new work"
      );
    if (!known)
      target.host!.assertSubmitFits({
        operationId: `dispatch-${"0".repeat(64)}`,
        payloadDigest: `sha256:${"0".repeat(64)}`,
        conversationId: target.binding.conversationId,
        turnId: `turn-${randomUUID()}`,
        policyRevision: target.binding.policyRevision,
        input: [{ type: "text", text: args.text }],
      });
    let admitted;
    try {
      admitted = this.journal.admitFleetDispatch(this.lease, {
        ...scope,
        target: target.binding,
        toolCallId: String(call.toolCallId),
        actionId: String(call.actionId),
        text: args.text,
        publicBotName: target.config.name,
      });
    } catch (error) {
      if (object(error) && typeof error.code === "string")
        throw new ProtocolError(error.code, "Fleet dispatch admission failed");
      throw error;
    }
    this.publishCommitted(target, true);
    if (admitted.created)
      queueMicrotask(() => {
        void this.pump(target);
      });
    return {
      status: "admitted",
      dispatchId: admitted.dispatchId,
      receipt: admitted.receipt as unknown as JsonObject,
    };
  }
  private deliverCompletions(afterId = 0): void {
    if (this.stopping) return;
    let deliveries;
    try {
      deliveries = this.journal.readOutbox(100, afterId);
    } catch {
      return;
    }
    if (deliveries.length === 100)
      queueMicrotask(() => this.deliverCompletions(deliveries.at(-1)!.id));
    for (const delivery of deliveries) {
      const origin = [...this.bots.values()].find(
        (bot) => bot.binding.botId === delivery.originBotId
      );
      if (!origin?.ready || !origin.host?.isReady) continue;
      try {
        origin.host.assertSubmitFits({
          operationId: `completion-${delivery.dispatchId}`,
          payloadDigest: `sha256:${"0".repeat(64)}`,
          conversationId: origin.binding.conversationId,
          turnId: `turn-${randomUUID()}`,
          policyRevision: origin.binding.policyRevision,
          input: [
            {
              type: "text",
              text: `Fleet completion from ${delivery.targetBotId}. Execution: ${String(delivery.payload.execution)}; observation: ${String(delivery.payload.observation)}.\n\n${String(delivery.payload.text)}`,
            },
          ],
        });
        const admitted = this.journal.admitCompletion(
          this.lease,
          delivery.id,
          origin.binding,
          origin.config.name
        );
        this.publishCommitted(origin, true);
        if (admitted.created)
          queueMicrotask(() => {
            void this.pump(origin);
          });
      } catch {
        // Keep the durable outbox item pending for recovery; never fabricate an ACK.
      }
    }
  }
  inspect(
    name: string,
    operationId: string,
    conversationId?: string
  ): JsonObject | null {
    const bot = this.requireBot(name);
    if (conversationId && conversationId !== bot.binding.conversationId)
      throw new ProtocolError(
        "stale_binding",
        "Conversation differs from the current binding"
      );
    const receipt = this.journal.getOperation({ ...bot.binding, operationId });
    return receipt?.kind === "session_open"
      ? null
      : (receipt as unknown as JsonObject | null);
  }
  registerRoutineSchedule(scheduleId: string, owner: string): JsonObject {
    return this.journal.registerRoutineSchedule(
      this.lease,
      scheduleId,
      owner
    ) as unknown as JsonObject;
  }
  cutoverRoutineSchedule(
    scheduleId: string,
    expectedOwner: string,
    expectedGeneration: number,
    nextOwner: string
  ): JsonObject {
    return this.journal.cutoverRoutineSchedule(
      this.lease,
      scheduleId,
      expectedOwner,
      expectedGeneration,
      nextOwner
    ) as unknown as JsonObject;
  }
  admitRoutineFire(
    name: string,
    scheduleId: string,
    occurrence: string,
    owner: string,
    ownerGeneration: number,
    text: string
  ): JsonObject {
    const bot = this.requireBot(name);
    if (!text.trim())
      throw new ProtocolError(
        "invalid_payload",
        "Routine text must be nonempty"
      );
    if (this.stopping || !bot.ready || !bot.host?.isReady)
      throw new ProtocolError(
        "session_unavailable",
        "The session is unavailable"
      );
    const operationId = `routine-op:${payloadDigest({ scheduleId, occurrence }).slice(7)}`;
    bot.host.assertSubmitFits({
      operationId,
      payloadDigest: `sha256:${"0".repeat(64)}`,
      conversationId: bot.binding.conversationId,
      turnId: `turn-${randomUUID()}`,
      policyRevision: bot.binding.policyRevision,
      input: [{ type: "text", text }],
    });
    const admitted = this.journal.admitRoutineFire(this.lease, {
      scheduleId,
      occurrence,
      owner,
      ownerGeneration,
      binding: bot.binding,
      payload: { text },
    });
    this.publishCommitted(bot, true);
    if (admitted.created)
      queueMicrotask(() => {
        void this.pump(bot);
      });
    return admitted as unknown as JsonObject;
  }
  async admit(
    name: string,
    body: Record<string, unknown>,
    contract: string | undefined,
    revision: string | undefined
  ): Promise<JsonObject> {
    const bot = this.requireBot(name);
    if (contract !== "2")
      throw new ProtocolError(
        "client_upgrade_required",
        "This bot requires client contract 2"
      );
    if (
      revision !== bot.binding.bindingRevision ||
      body.conversationId !== bot.binding.conversationId
    )
      throw new ProtocolError(
        "capabilities_changed",
        "Binding revision changed; refresh discovery"
      );
    if (
      typeof body.operationId !== "string" ||
      !body.operationId.trim() ||
      body.operationId.length > 256 ||
      body.operationId !== body.clientMessageId
    )
      throw new ProtocolError(
        "invalid_payload",
        "Matching operationId and clientMessageId are required"
      );
    if (
      Object.keys(body).some(
        (key) =>
          ![
            "text",
            "operationId",
            "clientMessageId",
            "conversationId",
            "images",
          ].includes(key)
      )
    )
      throw new ProtocolError("invalid_payload", "Unknown message field");
    const known = this.journal.getOperation({
      ...bot.binding,
      operationId: body.operationId,
    });
    if (
      !known &&
      Array.isArray(body.images) &&
      body.images.some(
        (item) =>
          object(item) &&
          typeof item.mediaType === "string" &&
          !bot.capabilities.input.mediaTypes.includes(item.mediaType)
      )
    )
      throw new ProtocolError(
        "capability_unavailable",
        "Attachment type is unavailable for this binding"
      );
    const uploads = await decodeArtifactUploads(body.images);
    if (typeof body.text !== "string" || (!body.text.trim() && !uploads.length))
      throw new ProtocolError(
        "invalid_payload",
        "Message text or an attachment is required"
      );
    const payload = { text: body.text };
    const intent = {
      ...bot.binding,
      operationId: body.operationId,
      payload,
      publicBotName: name,
    };
    const artifacts = uploads.length
      ? this.journal.describeArtifacts(intent, uploads)
      : [];
    if (
      !known &&
      uploads.some(
        (upload) =>
          !bot.capabilities.input.mediaTypes.includes(upload.mediaType) ||
          upload.bytes.length > bot.capabilities.input.maxMediaBytes
      )
    )
      throw new ProtocolError(
        "capability_unavailable",
        "Attachment exceeds the binding capabilities"
      );
    if (!known && (this.stopping || !bot.ready || !bot.host?.isReady))
      throw new ProtocolError(
        "session_unavailable",
        "The session is unavailable; inspect existing operations before continuing"
      );
    // Validate the exact host's negotiated whole-frame budget before accepting
    // new durable intent. A retry of a known identity never dispatches again.
    if (!known)
      bot.host!.assertSubmitFits({
        operationId: body.operationId,
        payloadDigest: `sha256:${"0".repeat(64)}`,
        conversationId: bot.binding.conversationId,
        turnId: `turn-${randomUUID()}`,
        policyRevision: bot.binding.policyRevision,
        input: [{ type: "text", text: body.text }, ...artifacts],
      });
    const admitted = uploads.length
      ? this.journal.admitMessageArtifacts(this.lease, intent, uploads)
      : this.journal.admit(this.lease, intent);
    this.publishCommitted(bot, true);
    if (admitted.created)
      queueMicrotask(() => {
        void this.pump(bot);
      });
    return admitted.receipt as unknown as JsonObject;
  }

  private readPluginArtifact(bot: BoundBot, call: HostCall): JsonObject {
    const args = call.arguments;
    if (
      typeof call.operationId !== "string" ||
      !object(args) ||
      typeof args.artifactId !== "string" ||
      Object.keys(args).some(
        (key) => !["artifactId", "offset", "limit"].includes(key)
      )
    )
      throw new ProtocolError(
        "invalid_payload",
        "Artifact read requires exact operation and range"
      );
    const operation = this.journal.getOperation({
      ...bot.binding,
      operationId: call.operationId,
    });
    if (
      !operation ||
      !["dispatching", "accepted"].includes(operation.delivery) ||
      terminal.has(operation.execution)
    )
      throw new ProtocolError(
        "artifact_unavailable",
        "Artifact operation is not active"
      );
    const maxChunk = Math.min(
      65536,
      Math.floor(bot.host!.limits.maxFrameBytes / 8)
    );
    const limit = args.limit === undefined ? maxChunk : Number(args.limit);
    if (
      maxChunk < 256 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > maxChunk ||
      (args.offset !== undefined && typeof args.offset !== "number") ||
      (args.limit !== undefined && typeof args.limit !== "number")
    )
      throw new ProtocolError(
        "resource_limit",
        "Artifact range exceeds the negotiated frame budget"
      );
    const result = this.journal.readArtifact(
      { ...bot.binding, operationId: call.operationId },
      args.artifactId,
      args.offset === undefined ? 0 : Number(args.offset),
      limit
    );
    return {
      artifact: result.descriptor,
      data: Buffer.from(result.bytes).toString("base64"),
      nextOffset: result.nextOffset,
    };
  }

  async settings(
    name: string,
    kind: "model" | "thinking"
  ): Promise<JsonObject> {
    const bot = this.requireBot(name);
    if (!bot.capabilities.configuration[kind])
      throw new ProtocolError(
        "capability_unavailable",
        "Native settings are unavailable"
      );
    const host = bot.host;
    if (this.stopping || !bot.ready || !host?.isReady)
      throw new ProtocolError(
        "session_unavailable",
        "Settings session is unavailable"
      );
    const result = await host.request("session.snapshot", {
      conversationId: bot.binding.conversationId,
    });
    if (
      this.stopping ||
      !bot.ready ||
      !host.isReady ||
      !object(result) ||
      result.observation !== "complete" ||
      result.disposition !== "known" ||
      !object(result.settings) ||
      typeof result.settings[kind] !== "string" ||
      !String(result.settings[kind]).trim() ||
      String(result.settings[kind]).length > 1025
    )
      throw new ProtocolError(
        "session_unavailable",
        "Authoritative native settings are unavailable"
      );
    // Native session paths and model/provider metadata never enter the public projection.
    return { [kind]: result.settings[kind] };
  }

  admitConfiguration(
    name: string,
    kind: "model" | "thinking" | "compact",
    body: Record<string, unknown>
  ): JsonObject {
    const bot = this.requireBot(name);
    if (
      body.kind !== kind ||
      body.conversationId !== bot.binding.conversationId ||
      typeof body.operationId !== "string" ||
      !body.operationId.trim() ||
      body.operationId.length > 256 ||
      (kind !== "compact" &&
        (typeof body[kind] !== "string" ||
          !String(body[kind]).trim() ||
          String(body[kind]).length > 1025 ||
          String(body[kind]).includes("\0"))) ||
      Object.keys(body).some(
        (key) =>
          ![
            "kind",
            "operationId",
            "conversationId",
            ...(kind === "compact" ? [] : [kind]),
          ].includes(key)
      )
    )
      throw new ProtocolError(
        "invalid_payload",
        "Configuration requires exact identity and one settings value"
      );
    const known = this.journal.getOperation({
      ...bot.binding,
      operationId: body.operationId,
    });
    if (!known) {
      if (!bot.capabilities.configuration[kind])
        throw new ProtocolError(
          "capability_unavailable",
          "This native setting is unavailable"
        );
      if (this.stopping || !bot.ready || !bot.host?.isReady)
        throw new ProtocolError(
          "session_unavailable",
          "Configuration session is unavailable"
        );
      bot.host.assertRequestFits(
        kind === "compact" ? "session.compact" : "session.configure",
        {
          ...body,
          turnId: `turn-${randomUUID()}`,
          payloadDigest: `sha256:${"0".repeat(64)}`,
          policyRevision: bot.binding.policyRevision,
        }
      );
    }
    const admitted = this.journal.admit(this.lease, {
      ...bot.binding,
      kind,
      operationId: body.operationId,
      payload: body as JsonObject,
    });
    this.publishCommitted(bot, true);
    if (admitted.created)
      queueMicrotask(() => {
        void this.pump(bot);
      });
    return admitted.receipt as unknown as JsonObject;
  }

  admitCancellation(
    name: string,
    targetOperationId: string,
    body: Record<string, unknown>
  ): JsonObject {
    const bot = this.requireBot(name);
    if (
      body.kind !== "cancel" ||
      body.targetOperationId !== targetOperationId ||
      body.conversationId !== bot.binding.conversationId ||
      typeof body.operationId !== "string" ||
      !body.operationId.trim() ||
      body.operationId.length > 256 ||
      Object.keys(body).some(
        (key) =>
          ![
            "kind",
            "operationId",
            "conversationId",
            "targetOperationId",
          ].includes(key)
      )
    )
      throw new ProtocolError(
        "invalid_payload",
        "Cancellation requires exact control and target identities"
      );
    const known = this.journal.getOperation({
      ...bot.binding,
      operationId: body.operationId,
    });
    if (!known) {
      if (bot.capabilities.operations.cancel === "unsupported")
        throw new ProtocolError(
          "capability_unavailable",
          "Cancellation is unavailable"
        );
      if (this.stopping || !bot.ready || !bot.host?.isReady)
        throw new ProtocolError(
          "session_unavailable",
          "Cancellation session is unavailable"
        );
      bot.host.assertRequestFits("operation.cancel", {
        ...body,
        payloadDigest: `sha256:${"0".repeat(64)}`,
        policyRevision: bot.binding.policyRevision,
      });
    }
    const admitted = this.journal.admitCancellation(this.lease, {
      ...bot.binding,
      kind: "cancel",
      operationId: body.operationId,
      payload: body as JsonObject,
    });
    this.publishCommitted(bot, true);
    this.deliverCompletions();
    if (admitted.created)
      queueMicrotask(() => {
        void this.pump(bot, "permission");
      });
    return admitted.receipt as unknown as JsonObject;
  }

  admitPermission(
    name: string,
    interactionId: string,
    body: Record<string, unknown>
  ): JsonObject {
    const bot = this.requireBot(name);
    if (
      body.kind !== "permission" ||
      body.conversationId !== bot.binding.conversationId ||
      body.interactionId !== interactionId ||
      typeof body.operationId !== "string" ||
      !body.operationId.trim() ||
      body.operationId.length > 256
    )
      throw new ProtocolError(
        "invalid_payload",
        "Permission requires an exact control and conversation identity"
      );
    const fields = [
      "kind",
      "operationId",
      "conversationId",
      "bindingId",
      "instanceId",
      "targetOperationId",
      "turnId",
      "interactionId",
      "optionsDigest",
      "expiresAt",
      "revision",
      "optionId",
    ];
    if (Object.keys(body).some((key) => !fields.includes(key)))
      throw new ProtocolError(
        "invalid_payload",
        "Unknown permission decision field"
      );
    const known = this.journal.getOperation({
      ...bot.binding,
      operationId: body.operationId,
    });
    if (!known) {
      if (bot.capabilities.interactions.permissions !== "exact-request")
        throw new ProtocolError(
          "capability_unavailable",
          "Exact permissions are unavailable"
        );
      if (this.stopping || !bot.ready || !bot.host?.isReady)
        throw new ProtocolError(
          "session_unavailable",
          "Permission session is unavailable"
        );
      bot.host.assertRequestFits("interaction.respond", {
        ...body,
        payloadDigest: `sha256:${"0".repeat(64)}`,
        policyRevision: bot.binding.policyRevision,
      });
    }
    const admitted = this.journal.admitPermission(
      this.lease,
      {
        ...bot.binding,
        kind: "permission",
        operationId: body.operationId,
        payload: body as JsonObject,
      },
      bot.host?.instanceId ?? ""
    );
    if (admitted.created)
      queueMicrotask(() => {
        void this.pump(bot, "permission");
      });
    return admitted.receipt as unknown as JsonObject;
  }

  admitQuestion(
    name: string,
    interactionId: string,
    body: Record<string, unknown>
  ): JsonObject {
    const bot = this.requireBot(name);
    if (
      body.kind !== "question" ||
      body.conversationId !== bot.binding.conversationId ||
      body.interactionId !== interactionId ||
      typeof body.operationId !== "string" ||
      !body.operationId.trim() ||
      body.operationId.length > 256
    )
      throw new ProtocolError(
        "invalid_payload",
        "Question requires an exact control and conversation identity"
      );
    const fields = [
      "kind",
      "operationId",
      "conversationId",
      "bindingId",
      "instanceId",
      "targetOperationId",
      "turnId",
      "interactionId",
      "optionsDigest",
      "expiresAt",
      "revision",
      "value",
      "confirmed",
      "cancelled",
    ];
    if (Object.keys(body).some((key) => !fields.includes(key)))
      throw new ProtocolError(
        "invalid_payload",
        "Unknown question decision field"
      );
    const known = this.journal.getOperation({
      ...bot.binding,
      operationId: body.operationId,
    });
    if (!known) {
      if (!bot.capabilities.interactions.questions)
        throw new ProtocolError(
          "capability_unavailable",
          "Questions are unavailable"
        );
      if (this.stopping || !bot.ready || !bot.host?.isReady)
        throw new ProtocolError(
          "session_unavailable",
          "Question session is unavailable"
        );
      bot.host.assertRequestFits("interaction.respond", {
        ...body,
        payloadDigest: `sha256:${"0".repeat(64)}`,
        policyRevision: bot.binding.policyRevision,
      });
    }
    const admitted = this.journal.admitQuestion(
      this.lease,
      {
        ...bot.binding,
        kind: "question",
        operationId: body.operationId,
        payload: body as JsonObject,
      },
      bot.host?.instanceId ?? ""
    );
    if (admitted.created)
      queueMicrotask(() => {
        void this.pump(bot, "question");
      });
    return admitted.receipt as unknown as JsonObject;
  }

  private pump(
    bot: BoundBot,
    interruptOnly: "permission" | "question" | false = false
  ): Promise<void> {
    const slot =
      interruptOnly === "permission"
        ? "permissionPump"
        : interruptOnly === "question"
          ? "questionPump"
          : "pump";
    const again =
      interruptOnly === "permission"
        ? "permissionPumpAgain"
        : interruptOnly === "question"
          ? "questionPumpAgain"
          : "pumpAgain";
    if (bot[slot]) {
      bot[again] = true;
      return bot[slot]!;
    }
    if (this.stopping || !bot.ready || !bot.host?.isReady)
      return Promise.resolve();
    const pump = this.dispatch(bot, interruptOnly);
    bot[slot] = pump;
    const clear = () => {
      if (bot[slot] === pump) bot[slot] = undefined;
      if (bot[again]) {
        bot[again] = false;
        queueMicrotask(() => {
          void this.pump(bot, interruptOnly);
        });
      }
    };
    void pump.then(clear, clear);
    return pump;
  }
  private async dispatch(
    bot: BoundBot,
    interruptOnly: "permission" | "question" | false = false
  ): Promise<void> {
    try {
      for (;;) {
        // Closing can start while a native response is outstanding. Never turn
        // the next queued item into an uncertain dispatch after admission stops.
        if (this.stopping || !bot.ready || !bot.host?.isReady) break;
        const op = this.journal.reserveNext(this.lease, bot.binding, {
          interruptKinds: ["permission", "question", "cancel"],
          onlyInterrupts: Boolean(interruptOnly),
        });
        if (!op) break;
        if (op.receipt.kind === "cancel") {
          await this.dispatchCancellation(bot, op);
          continue;
        }
        if (op.receipt.kind === "permission") {
          await this.dispatchPermission(bot, op);
          continue;
        }
        if (op.receipt.kind === "question") {
          await this.dispatchQuestion(bot, op);
          continue;
        }
        if (
          op.receipt.kind === "model" ||
          op.receipt.kind === "thinking" ||
          op.receipt.kind === "compact"
        ) {
          await this.dispatchConfiguration(bot, op);
          continue;
        }
        if (
          op.receipt.kind ||
          !op.payload ||
          typeof op.payload.text !== "string"
        )
          throw new ProtocolError(
            "invalid_state",
            "Dispatcher encountered an unsupported queued operation"
          );
        let result: unknown;
        try {
          result = await bot.host.request("operation.submit", {
            operationId: op.receipt.operationId,
            payloadDigest: op.payloadDigest,
            conversationId: bot.binding.conversationId,
            turnId: op.turnId,
            policyRevision: op.policyRevision,
            input: [
              { type: "text", text: op.payload.text },
              ...(Array.isArray(op.payload.artifacts)
                ? op.payload.artifacts
                : []),
            ],
          });
        } catch {
          // A lost submit response cannot erase a correlated native acceptance
          // or turn-start event. Host failure handles loss of execution evidence.
          const latest = this.journal.getOperation(op.receipt)!;
          if (latest.delivery !== "accepted") this.markUnknown(bot, op);
          break;
        }
        const latest = this.journal.getOperation(op.receipt)!;
        // A terminal event may have committed while the RPC response was in flight.
        if (!terminal.has(latest.execution)) {
          if (object(result) && result.disposition === "accepted") {
            this.journal.recordDisposition(this.lease, op.receipt, {
              delivery: "accepted",
              evidence: "correlated_submit_response",
            });
          } else if (
            object(result) &&
            result.disposition === "rejected" &&
            latest.delivery !== "accepted"
          ) {
            this.journal.recordDisposition(this.lease, op.receipt, {
              delivery: "rejected",
              execution: "not_started",
              evidence: "correlated_submit_response",
            });
          } else {
            if (latest.delivery !== "accepted") this.markUnknown(bot, op);
            break;
          }
        }
        this.publishCommitted(bot, true);
      }
    } catch (error) {
      this.failBot(
        bot,
        error instanceof ProtocolError ? error.code : "storage_failure"
      );
    }
  }
  private async dispatchConfiguration(
    bot: BoundBot,
    op: OperationRecord
  ): Promise<void> {
    const kind = op.receipt.kind as "model" | "thinking" | "compact";
    let result: unknown;
    try {
      result = await bot.host!.request(
        kind === "compact" ? "session.compact" : "session.configure",
        {
          ...op.payload,
          operationId: op.receipt.operationId,
          conversationId: bot.binding.conversationId,
          kind,
          turnId: op.turnId,
          payloadDigest: op.payloadDigest,
          policyRevision: op.policyRevision,
        }
      );
    } catch {
      result = { status: "unknown" };
    }
    const latest = this.journal.getOperation(op.receipt)!;
    // Durable terminal evidence may precede a delayed command acknowledgement.
    if (terminal.has(latest.execution) || latest.delivery === "rejected") {
      this.publishCommitted(bot, true);
      return;
    }
    if (
      object(result) &&
      result.disposition === "accepted" &&
      result.status === "applied" &&
      (kind === "compact" ||
        (object(result.settings) &&
          result.settings[kind] === op.payload?.[kind]))
    ) {
      this.journal.recordDisposition(this.lease, op.receipt, {
        delivery: "accepted",
        execution: "ended",
        observation: "complete",
        result: { status: "applied" },
        evidence: "correlated_configuration_readback",
      });
    } else if (
      object(result) &&
      result.disposition === "accepted" &&
      result.status === undefined
    ) {
      this.journal.recordDisposition(this.lease, op.receipt, {
        delivery: "accepted",
        evidence: "correlated_control_acceptance",
      });
    } else if (
      latest.delivery !== "accepted" &&
      object(result) &&
      result.disposition === "rejected" &&
      result.status === "failed"
    ) {
      this.journal.recordDisposition(this.lease, op.receipt, {
        delivery: "rejected",
        execution: "not_started",
        observation: "complete",
        result: { status: "failed" },
        evidence: "configuration_rejected_before_native_write",
      });
    } else this.markUnknown(bot, op);
    this.publishCommitted(bot, true);
  }

  private async dispatchCancellation(
    bot: BoundBot,
    op: OperationRecord
  ): Promise<void> {
    const targetKey = {
      ...bot.binding,
      operationId: String(op.payload!.targetOperationId),
    };
    const target = this.journal.getOperation(targetKey);
    let result: unknown;
    if (
      target &&
      (terminal.has(target.execution) || target.delivery === "rejected")
    ) {
      result = { status: "already_terminal" };
    } else {
      try {
        result = await bot.host!.request("operation.cancel", {
          ...op.payload,
          operationId: op.receipt.operationId,
          payloadDigest: op.payloadDigest,
          policyRevision: op.policyRevision,
        });
      } catch {
        result = { status: "unknown" };
      }
    }
    if (
      object(result) &&
      ["requested", "already_terminal", "unsupported"].includes(
        String(result.status)
      )
    ) {
      this.journal.recordDisposition(this.lease, op.receipt, {
        delivery: "accepted",
        execution: "ended",
        observation: "complete",
        result: {
          status:
            result.status === "already_terminal"
              ? "applied"
              : result.status === "unsupported"
                ? "failed"
                : "requested",
        },
        evidence: "correlated_cancellation_response",
      });
      const latest = this.journal.getOperation(targetKey);
      if (
        result.status === "requested" &&
        latest &&
        latest.delivery === "accepted" &&
        ["running", "waiting_for_input"].includes(latest.execution)
      ) {
        this.journal.recordDisposition(this.lease, targetKey, {
          execution: "cancel_requested",
          evidence: "correlated_cancellation_response",
        });
      }
    } else this.markUnknown(bot, op);
    this.publishCommitted(bot, true);
  }

  private async dispatchPermission(
    bot: BoundBot,
    op: OperationRecord
  ): Promise<void> {
    const payload = op.payload!;
    const request = this.journal.getPermission(payload);
    const target = this.journal.getOperation({
      ...bot.binding,
      operationId: String(payload.targetOperationId),
    });
    if (
      !request ||
      request.resolution ||
      payload.instanceId !== bot.host!.instanceId ||
      Date.parse(String(payload.expiresAt)) <= Date.now() ||
      !target ||
      terminal.has(target.execution)
    ) {
      this.journal.recordDisposition(this.lease, op.receipt, {
        delivery: "rejected",
        execution: "not_started",
        result: { status: "expired" },
        evidence: "permission_no_longer_live",
      });
      this.publishCommitted(bot, true);
      return;
    }
    let result: unknown;
    try {
      result = await bot.host!.request("interaction.respond", {
        ...payload,
        operationId: op.receipt.operationId,
        payloadDigest: op.payloadDigest,
        policyRevision: op.policyRevision,
      });
    } catch {
      result = { status: "unknown" };
    }
    const latest = this.journal.getOperation(op.receipt)!;
    if (!terminal.has(latest.execution) && latest.delivery !== "rejected") {
      if (
        object(result) &&
        ["applied", "expired", "stale", "unsupported"].includes(
          String(result.status)
        )
      ) {
        const status =
          result.status === "stale"
            ? "expired"
            : result.status === "unsupported"
              ? "failed"
              : String(result.status);
        this.journal.recordDisposition(this.lease, op.receipt, {
          delivery: "accepted",
          execution: "ended",
          observation: "complete",
          result: { status },
          evidence: "correlated_permission_response",
        });
      } else this.markUnknown(bot, op);
    }
    this.publishCommitted(bot, true);
  }
  private async dispatchQuestion(
    bot: BoundBot,
    op: OperationRecord
  ): Promise<void> {
    const payload = op.payload!;
    const request = this.journal.getQuestion(payload);
    const target = this.journal.getOperation({
      ...bot.binding,
      operationId: String(payload.targetOperationId),
    });
    if (
      !request ||
      request.resolution ||
      payload.instanceId !== bot.host!.instanceId ||
      (payload.expiresAt !== undefined &&
        Date.parse(String(payload.expiresAt)) <= Date.now()) ||
      !target ||
      terminal.has(target.execution)
    ) {
      this.journal.recordDisposition(this.lease, op.receipt, {
        delivery: "rejected",
        execution: "not_started",
        result: { status: "expired" },
        evidence: "question_no_longer_live",
      });
      this.publishCommitted(bot, true);
      return;
    }
    let result: unknown;
    try {
      result = await bot.host!.request("interaction.respond", {
        ...payload,
        operationId: op.receipt.operationId,
        payloadDigest: op.payloadDigest,
        policyRevision: op.policyRevision,
      });
    } catch {
      result = { status: "unknown" };
    }
    const latest = this.journal.getOperation(op.receipt)!;
    if (!terminal.has(latest.execution) && latest.delivery !== "rejected") {
      if (
        object(result) &&
        ["expired", "stale", "unsupported"].includes(String(result.status))
      ) {
        const status =
          result.status === "stale"
            ? "expired"
            : result.status === "unsupported"
              ? "failed"
              : String(result.status);
        this.journal.recordDisposition(this.lease, op.receipt, {
          delivery: "accepted",
          execution: "ended",
          observation: "complete",
          result: { status },
          evidence: "correlated_question_response",
        });
      } else if (
        object(result) &&
        result.status === "unknown" &&
        result.transport === "submitted" &&
        result.consumption === "unconfirmed"
      ) {
        this.journal.recordDisposition(this.lease, op.receipt, {
          delivery: "accepted",
          execution: "ended",
          observation: "complete",
          result: {
            status: "unknown",
            transport: "submitted",
            consumption: "unconfirmed",
          },
          evidence: "correlated_question_transport_write",
        });
      } else this.markUnknown(bot, op);
    }
    this.publishCommitted(bot, true);
  }
  private markUnknown(bot: BoundBot, op: OperationRecord): void {
    const latest = this.journal.getOperation(op.receipt)!;
    if (terminal.has(latest.execution) || latest.delivery === "rejected")
      return;
    this.journal.recordDisposition(this.lease, op.receipt, {
      delivery: latest.delivery === "accepted" ? "accepted" : "unknown",
      execution: "unknown",
      observation: "reconciliation_required",
    });
    bot.fault = "operation_unknown";
    this.publishRoster();
  }
  private failBot(bot: BoundBot, code: string): void {
    bot.ready = false;
    bot.fault = code;
    if (this.stopping) return;
    try {
      for (const op of this.journal.listOperationRecords(bot.binding)) {
        if (
          ["dispatching", "accepted"].includes(op.receipt.delivery) &&
          !terminal.has(op.receipt.execution)
        )
          this.markUnknown(bot, op);
      }
      this.journal.closePermissions(this.lease, bot.binding, bot.config.name);
      this.journal.closeQuestions(this.lease, bot.binding, bot.config.name);
      this.publishCommitted(bot, false);
      this.publishRoster();
    } catch {
      this.log(
        "[gateway] storage or lease unavailable; receipt inspection required after recovery"
      );
    }
  }

  private receive(bot: BoundBot, event: GatewayPluginEvent): number {
    const ack = this.journal.sourceAck(bot.binding.bindingId);
    if (event.sourceSequence <= ack)
      return this.journal.commitPluginEvent(
        this.lease,
        event as unknown as Parameters<GatewayJournal["commitPluginEvent"]>[1],
        { publicEvents: [] }
      ).ack;
    if (event.sourceSequence !== ack + 1)
      throw new ProtocolError(
        "observation_gap",
        "Plugin replay must restore the next contiguous event before new observations"
      );
    if (event.operationId) {
      const op = this.journal.getOperationRecord({
        ...bot.binding,
        operationId: event.operationId,
      });
      // The host and journal fence the CURRENT envelope lease. A replayed event
      // may belong to an operation reserved by an earlier, reconciled owner.
      if (!op || op.turnId !== event.turnId || op.leaseGeneration === null)
        throw new ProtocolError(
          "stale_binding",
          "Event does not match a dispatched operation and turn"
        );
    }
    const previous = structuredClone(bot.turns);
    let committed: ReturnType<GatewayJournal["commitPluginEvent"]>;
    try {
      const projection = this.project(bot, event);
      committed = this.journal.commitPluginEvent(
        this.lease,
        event as unknown as Parameters<GatewayJournal["commitPluginEvent"]>[1],
        projection
      );
    } catch (error) {
      bot.turns = previous;
      throw error;
    }
    // Storage committed the projection and source watermark together. A later
    // observer/roster failure cannot roll RAM back or nack that durable event.
    this.publishCommitted(bot, event.type === "turn.terminal");
    if (event.type === "turn.terminal") this.deliverCompletions();
    if (event.type === "turn.terminal" || event.type === "interaction.resolved")
      queueMicrotask(() => {
        void this.pump(bot);
        void this.pump(bot, "permission");
      });
    return committed.ack;
  }
  private project(bot: BoundBot, event: GatewayPluginEvent): EventProjection {
    const projection: EventProjection = { publicEvents: [] };
    const payload = event.payload;
    const wire = projection.publicEvents!;
    if (event.type === "session.state") return projection;
    if (event.type === "observation.gap") {
      if (!event.operationId)
        throw new ProtocolError(
          "observation_gap",
          "Binding observation gap requires reconciliation"
        );
      projection.operation = { observation: "reconciliation_required" };
      return projection;
    }
    if (event.type === "operation.disposition") {
      if (
        !["accepted", "rejected", "unknown"].includes(
          String(payload.disposition)
        )
      )
        throw new ProtocolError("invalid_event", "Invalid native disposition");
      projection.operation = {
        delivery: payload.disposition as OperationDisposition["delivery"],
        evidence: "correlated_plugin_event",
      };
      return projection;
    }
    const control = event.operationId
      ? this.journal.getOperationRecord({
          ...bot.binding,
          operationId: event.operationId,
        })
      : null;
    if (
      control &&
      ["model", "thinking", "compact"].includes(String(control.receipt.kind))
    ) {
      if (event.type === "turn.started") {
        projection.operation = {
          delivery: "accepted",
          execution: "running",
          evidence: "correlated_control_started",
        };
      } else if (event.type === "turn.terminal") {
        if (!terminal.has(String(payload.execution)))
          throw new ProtocolError(
            "invalid_event",
            "Control terminal requires explicit execution state"
          );
        const kind = control.receipt.kind!;
        const applied =
          payload.execution === "ended" &&
          object(payload.result) &&
          payload.result.status === "applied" &&
          (kind === "compact" ||
            (object(payload.result.settings) &&
              payload.result.settings[kind] === control.payload?.[kind]));
        const failed =
          ["failed", "cancelled", "interrupted"].includes(
            String(payload.execution)
          ) &&
          object(payload.result) &&
          ["failed", "cancelled"].includes(String(payload.result.status));
        if (payload.observation === "complete" && (applied || failed)) {
          projection.operation = {
            delivery: "accepted",
            execution: payload.execution as OperationDisposition["execution"],
            observation: "complete",
            result: {
              status: applied
                ? "applied"
                : payload.execution === "cancelled"
                  ? "cancelled"
                  : "failed",
            },
            evidence: "correlated_control_terminal",
          };
        } else {
          projection.operation = {
            delivery: "accepted",
            execution: "unknown",
            observation: "reconciliation_required",
            evidence: "control_terminal_missing_application_evidence",
          };
        }
      } else
        throw new ProtocolError(
          "invalid_event",
          "Settings controls cannot produce chat or tool output"
        );
      return projection;
    }
    let turn = bot.turns.get(event.turnId!);
    if (event.type === "turn.started") {
      if (!turn) {
        turn = {
          operationId: event.operationId!,
          turnId: event.turnId!,
          messages: new Map(),
          tools: new Map(),
        };
        bot.turns.set(turn.turnId, turn);
      }
      projection.operation = {
        delivery: "accepted",
        execution: "running",
        evidence: "correlated_turn_started",
      };
      wire.push({
        type: "bubble",
        bot: bot.config.name,
        turnId: turn.turnId,
        phase: "working",
        text: "",
      });
      return projection;
    }
    if (
      event.type === "interaction.requested" ||
      event.type === "interaction.resolved"
    ) {
      const requested = event.type === "interaction.requested";
      const kind = String(payload.kind ?? "");
      if (kind === "permission") {
        if (bot.capabilities.interactions.permissions !== "exact-request")
          throw new ProtocolError(
            "capability_unavailable",
            "Unsupported interaction type"
          );
        const retained = this.journal.getPermission(payload as JsonObject);
        const descriptor = requested
          ? permissionRequest(payload as JsonObject)
          : retained?.descriptor;
        if (!descriptor || descriptor.interactionId !== event.interactionId)
          throw new ProtocolError(
            "invalid_permission",
            "Permission event requires exact request identity"
          );
        const value = requested
          ? descriptor
          : permissionResolution(payload as JsonObject, descriptor);
        if (requested && retained) {
          if (payloadDigest(descriptor) !== payloadDigest(retained.descriptor))
            throw new ProtocolError(
              "permission_conflict",
              "Permission descriptor changed"
            );
          return projection;
        }
        if (
          !requested &&
          retained?.resolution &&
          payloadDigest(retained.resolution) === payloadDigest(value)
        )
          return projection;
        const target = this.journal.getOperation({
          ...bot.binding,
          operationId: String(event.operationId),
        });
        if (
          requested &&
          (!turn ||
            !target ||
            target.delivery !== "accepted" ||
            terminal.has(target.execution))
        )
          throw new ProtocolError(
            "invalid_permission",
            "Permission requires an active accepted turn"
          );
        projection.permission = requested
          ? { request: descriptor }
          : { resolution: value };
        const entry = {
          id: payloadDigest({
            permission: permissionKey(descriptor),
            ...(requested ? {} : { resolution: value }),
          }),
          operationId: event.operationId!,
          turnId: event.turnId!,
          role: "assistant",
          origin: "bot",
          text: "",
          ts: new Date().toISOString(),
          [requested ? "permission" : "permissionResolved"]: value,
        };
        projection.entries = [entry];
        wire.push({ type: "append", bot: bot.config.name, entry });
        if (requested)
          projection.operation = {
            execution: "waiting_for_input",
            evidence: "correlated_permission_event",
          };
        return projection;
      }
      if (kind !== "question" || !bot.capabilities.interactions.questions)
        throw new ProtocolError(
          "capability_unavailable",
          "Unsupported interaction type"
        );
      const retained = this.journal.getQuestion(payload as JsonObject);
      const descriptor = requested
        ? questionRequest(payload as JsonObject)
        : retained?.descriptor;
      if (!descriptor || descriptor.interactionId !== event.interactionId)
        throw new ProtocolError(
          "invalid_question",
          "Question event requires exact request identity"
        );
      const value = requested
        ? descriptor
        : questionResolution(payload as JsonObject, descriptor);
      if (requested && retained) {
        if (payloadDigest(descriptor) !== payloadDigest(retained.descriptor))
          throw new ProtocolError(
            "question_conflict",
            "Question descriptor changed"
          );
        return projection;
      }
      if (
        !requested &&
        retained?.resolution &&
        payloadDigest(retained.resolution) === payloadDigest(value)
      )
        return projection;
      const target = this.journal.getOperation({
        ...bot.binding,
        operationId: String(event.operationId),
      });
      if (
        requested &&
        (!turn ||
          !target ||
          target.delivery !== "accepted" ||
          terminal.has(target.execution))
      )
        throw new ProtocolError(
          "invalid_question",
          "Question requires an active accepted turn"
        );
      projection.question = requested
        ? { request: descriptor }
        : { resolution: value };
      const entry = {
        id: payloadDigest({
          question: questionKey(descriptor),
          ...(requested ? {} : { resolution: value }),
        }),
        operationId: event.operationId!,
        turnId: event.turnId!,
        role: "assistant",
        origin: "bot",
        text: "",
        ts: new Date().toISOString(),
        [requested ? "question" : "questionResolved"]: value,
      };
      projection.entries = [entry];
      wire.push({ type: "append", bot: bot.config.name, entry });
      if (requested)
        projection.operation = {
          execution: "waiting_for_input",
          evidence: "correlated_question_event",
        };
      return projection;
    }
    if (!turn)
      throw new ProtocolError(
        "invalid_event",
        "Turn observations require a preceding turn.started"
      );
    if (event.type === "message.started") {
      const id = String(event.messageId);
      if (
        payload.role !== "assistant" ||
        !Number.isSafeInteger(payload.order) ||
        Number(payload.order) !== turn.messages.size ||
        turn.messages.has(id) ||
        [...turn.messages.values()].some(
          (message) => message.order === payload.order
        )
      )
        throw new ProtocolError(
          "invalid_event",
          "Invalid assistant message identity/order"
        );
      turn.messages.set(id, {
        id,
        sourceSequence: event.sourceSequence,
        order: Number(payload.order),
        blocks: new Map(),
        finished: false,
      });
    } else if (event.type === "text.snapshot") {
      const message = turn.messages.get(String(event.messageId));
      if (!message || message.finished)
        throw new ProtocolError(
          "invalid_event",
          "Snapshot targets an unavailable message"
        );
      const blockId = String(event.blockId);
      const prior = message.blocks.get(blockId);
      const revision = Number(payload.revision);
      if (
        prior &&
        (revision < prior.revision ||
          (revision === prior.revision && payload.text !== prior.text))
      )
        throw new ProtocolError(
          "invalid_event",
          "Text revision regressed or conflicted"
        );
      if (prior && revision === prior.revision) return projection;
      const order = prior?.order ?? message.blocks.size;
      message.blocks.set(blockId, {
        revision,
        text: String(payload.text),
        order,
      });
      wire.push(this.bubble(bot, turn));
    } else if (event.type === "message.finished") {
      const message = turn.messages.get(String(event.messageId));
      if (!message || message.finished || !Array.isArray(payload.blocks))
        throw new ProtocolError(
          "invalid_event",
          "Final message requires authoritative blocks and a live message identity"
        );
      const ids = new Set<string>();
      const blocks = payload.blocks.map((value) => {
        if (
          !object(value) ||
          value.type !== "text" ||
          typeof value.blockId !== "string" ||
          !value.blockId ||
          ids.has(value.blockId) ||
          typeof value.text !== "string" ||
          !Number.isSafeInteger(value.revision)
        )
          throw new ProtocolError(
            "invalid_event",
            "Invalid authoritative text block"
          );
        ids.add(value.blockId);
        const prior = message.blocks.get(value.blockId);
        if (
          Number(value.revision) < (prior?.revision ?? 0) ||
          (prior &&
            value.revision === prior.revision &&
            value.text !== prior.text)
        )
          throw new ProtocolError(
            "invalid_event",
            "Final text conflicts with an observed revision"
          );
        return { type: "text", text: value.text };
      });
      if ([...message.blocks.keys()].some((id) => !ids.has(id)))
        throw new ProtocolError(
          "invalid_event",
          "Authoritative final omitted an observed block"
        );
      if (
        typeof payload.ts !== "string" ||
        !Number.isFinite(Date.parse(payload.ts))
      )
        throw new ProtocolError(
          "invalid_event",
          "Final message requires a stable timestamp"
        );
      const entry: JsonObject = {
        id: payloadDigest({
          bindingId: bot.binding.bindingId,
          messageId: message.id,
        }),
        operationId: turn.operationId,
        turnId: turn.turnId,
        role: "assistant",
        origin: "bot",
        text: blocks.map((block) => block.text).join(""),
        parts: blocks,
        ts: payload.ts,
      };
      message.finished = true;
      message.entry = entry;
      // Authoritative finals can contain a newer revision than the last live
      // snapshot. Keep that text visible while an earlier message finishes.
      message.blocks.clear();
      payload.blocks.forEach((value, order) => {
        const block = value as Record<string, unknown>;
        message.blocks.set(String(block.blockId), {
          revision: Number(block.revision),
          text: String(block.text),
          order,
        });
      });
      this.flushParts(bot, turn, projection);
      const remaining = this.bubble(bot, turn);
      // Flutter preserves prior text for an empty parts-only update. Reset the
      // active bubble before removing its newly canonical text, while keeping
      // this turn alive for subsequent messages (final retires it permanently).
      if (remaining.text === "")
        wire.push({
          type: "bubble",
          bot: bot.config.name,
          turnId: turn.turnId,
          phase: "working",
          text: "",
        });
      wire.push(remaining);
    } else if (
      ["tool.started", "tool.updated", "tool.finished"].includes(event.type)
    ) {
      if (
        !bot.capabilities.output.tools ||
        typeof event.toolCallId !== "string" ||
        !event.toolCallId
      )
        throw new ProtocolError(
          "capability_unavailable",
          "Tool projection requires a negotiated stable identity"
        );
      const id = event.toolCallId;
      let tool = turn.tools.get(id);
      if (event.type === "tool.started") {
        if (
          tool ||
          turn.tools.size >= 4096 ||
          payload.state !== "running" ||
          typeof payload.label !== "string" ||
          !payload.label.trim() ||
          payload.label.length > 256
        )
          throw new ProtocolError("invalid_event", "Invalid tool start");
        tool = {
          sourceSequence: event.sourceSequence,
          finished: false,
          part: {
            type: "tool",
            toolCallId: id,
            tool: "tool",
            label: payload.label,
            status: "running",
          },
        };
        turn.tools.set(id, tool);
      } else {
        if (!tool || tool.finished)
          throw new ProtocolError(
            "invalid_event",
            "Tool update requires a live identity"
          );
        if (event.type === "tool.finished") {
          if (!["ended", "error"].includes(String(payload.state)))
            throw new ProtocolError("invalid_event", "Invalid tool outcome");
          tool.part.status = payload.state === "ended" ? "ok" : "error";
          tool.finished = true;
          tool.entry = {
            id: payloadDigest({
              bindingId: bot.binding.bindingId,
              operationId: turn.operationId,
              toolCallId: id,
            }),
            operationId: turn.operationId,
            turnId: turn.turnId,
            role: "assistant",
            origin: "bot",
            text: "",
            parts: [{ ...tool.part }],
            // Gateway observation time, not an invented native tool duration.
            ts: new Date().toISOString(),
          };
          this.flushParts(bot, turn, projection);
        } else if (payload.state !== "running")
          throw new ProtocolError(
            "invalid_event",
            "Invalid running tool update"
          );
      }
      const remaining = this.bubble(bot, turn);
      if (remaining.text === "")
        wire.push({
          type: "bubble",
          bot: bot.config.name,
          turnId: turn.turnId,
          phase: "working",
          text: "",
        });
      wire.push(remaining);
    } else if (event.type === "turn.terminal") {
      if (!terminal.has(String(payload.execution)))
        throw new ProtocolError(
          "invalid_event",
          "Terminal event requires explicit execution state"
        );
      const complete =
        payload.observation === "complete" &&
        [...turn.messages.values()].every((message) => message.finished) &&
        [...turn.tools.values()].every((tool) => tool.finished);
      // Preserve completed messages even when a preceding unfinished message
      // makes overall observation incomplete; never fabricate its missing final.
      this.flushParts(bot, turn, projection, true);
      projection.operation = {
        delivery: "accepted",
        execution: payload.execution as OperationDisposition["execution"],
        observation: complete ? "complete" : "reconciliation_required",
        evidence: "correlated_terminal_event",
        result: { taskOutcome: "unknown" },
      };
      const dispatched = this.journal.getOperationRecord({
        ...bot.binding,
        operationId: turn.operationId,
      })?.payload?.dispatch;
      if (object(dispatched)) {
        const text = [...turn.messages.values()]
          .sort((a, b) => a.order - b.order)
          .filter((message) => message.finished)
          .map((message) => String(message.entry?.text ?? ""))
          .join("\n\n");
        projection.completion = {
          dispatchId: String(dispatched.dispatchId),
          originBotId: String(dispatched.originBotId),
          payload: {
            originConversationId: dispatched.originConversationId,
            originBindingId: dispatched.originBindingId,
            depth: dispatched.depth,
            execution: String(payload.execution),
            observation: complete ? "complete" : "reconciliation_required",
            text:
              text.length > 32000
                ? text.slice(0, 32000) +
                  "\n[Output truncated; full output remains in the target transcript.]"
                : text,
          },
        };
      }
      bot.turns.delete(turn.turnId);
      wire.push({
        type: "bubble",
        bot: bot.config.name,
        turnId: turn.turnId,
        phase: "final",
        text: "",
      });
    } else {
      // No usage or additional interaction capability is exposed until its exact
      // projection/decision route is implemented. Never leak raw vendor payloads.
      throw new ProtocolError(
        "capability_unavailable",
        "Plugin emitted an event outside the effective gateway capabilities"
      );
    }
    return projection;
  }
  private orderedParts(turn: TurnView): Array<MessageView | ToolView> {
    return [...turn.messages.values(), ...turn.tools.values()].sort(
      (a, b) => a.sourceSequence - b.sourceSequence
    );
  }
  private flushParts(
    bot: BoundBot,
    turn: TurnView,
    projection: EventProjection,
    terminal = false
  ): void {
    projection.entries = [];
    for (const part of this.orderedParts(turn)) {
      if (!part.finished) {
        if (terminal) continue;
        break;
      }
      if (part.emitted || !part.entry) continue;
      part.emitted = true;
      projection.entries.push(part.entry);
      projection.publicEvents!.push({
        type: "append",
        bot: bot.config.name,
        entry: part.entry,
      });
    }
  }
  private bubble(bot: BoundBot, turn: TurnView): JsonObject {
    const parts: JsonObject[] = this.orderedParts(turn)
      .filter((part) => !part.emitted)
      .flatMap((part) =>
        "blocks" in part
          ? [...part.blocks.values()]
              .sort((a, b) => a.order - b.order)
              .map((block) => ({ type: "text", text: block.text }))
          : [{ ...part.part }]
      );
    return {
      type: "bubble",
      bot: bot.config.name,
      turnId: turn.turnId,
      phase: "parts",
      text: parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
      parts,
    };
  }
  subscribe(listener: (event: JsonObject) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }
  /** Called after hello: new durable sequence numbers survive the client's replay cutoff. */
  refreshLiveSnapshots(): void {
    for (const bot of this.bots.values()) {
      const snapshots = [...bot.turns.values()].map((turn) =>
        this.bubble(bot, turn)
      );
      if (snapshots.length)
        this.journal.appendPublicEvents(
          this.lease,
          bot.binding.bindingId,
          snapshots
        );
    }
    this.publishRoster();
  }
  private publishRoster(): void {
    const first = this.bots.values().next().value as BoundBot | undefined;
    if (!first || this.stopping) return;
    this.journal.appendPublicEvents(this.lease, first.binding.bindingId, [
      { type: "roster", ...this.roster() },
    ]);
    this.flush();
  }
  private publishCommitted(bot: BoundBot, roster: boolean): void {
    try {
      this.flush();
      if (roster) this.publishRoster();
    } catch {
      bot.ready = false;
      bot.fault = "publication_unavailable";
      this.log(
        "[gateway] state committed; publication failed, admission paused for this binding"
      );
    }
  }
  private flush(): void {
    for (;;) {
      const events = this.journal.readEvents(this.emitted);
      if (!events.length) return;
      for (const { seq, event } of events) {
        this.emitted = seq;
        for (const listener of this.subscribers) {
          try {
            listener(event);
          } catch {
            /* A failed observer cannot undo a durable receipt. */
          }
        }
      }
    }
  }
  stop(): Promise<void> {
    return (this.stopped ??= (async () => {
      this.stopping = true;
      if (this.renewal) clearInterval(this.renewal);
      const results = await Promise.allSettled(
        [...this.bots.values()].map((bot) => bot.host?.close())
      );
      // Close rejects outstanding requests. Join their continuations before
      // recovery, lease release, or closing the shared SQLite connection.
      await Promise.allSettled(
        [...this.bots.values()].flatMap((bot) => [
          bot.pump,
          bot.permissionPump,
          bot.questionPump,
        ])
      );
      try {
        this.journal.recoverInterrupted(this.lease);
        for (const bot of this.bots.values())
          this.journal.closePermissions(
            this.lease,
            bot.binding,
            bot.config.name
          );
        this.journal.releaseWriterLease(this.lease, {
          ownershipReconciled: results.every(
            (result) => result.status === "fulfilled"
          ),
        });
        if (results.some((result) => result.status === "rejected"))
          throw new ProtocolError(
            "ownership_unreconciled",
            "Plugin ownership could not be confirmed during shutdown"
          );
      } finally {
        this.subscribers.clear();
        this.journal.close();
      }
    })());
  }
}
