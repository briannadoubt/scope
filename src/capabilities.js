import {
  EVENT_FORMAT_VERSION,
  EVENT_KINDS,
  MINIMUM_READER_EVENT_FORMAT_VERSION,
  SUPPORTED_EVENT_FORMAT_VERSIONS,
} from './event-schema.js';
import { PROTOCOL_VERSION } from './protocol.js';
import { STATUSES, PRIORITIES, RELATION_TYPES, TICKET_TYPES } from './enums.js';

export const AGENT_PROTOCOL_FEATURES = Object.freeze({
  jsonEnvelope: true,
  idempotencyReceipts: true,
  crashSafeRequestFence: true,
  optimisticRevision: true,
  atomicEventTransactions: true,
  batchAssertions: true,
  doctor: true,
  readiness: true,
  parallelPlanning: true,
  compactCoordinatorView: true,
  declaredRepositoryIntent: true,
  leases: true,
  phaseResourceReservations: true,
  derivedLifecycle: true,
  executionProjection: true,
  attempts: true,
  contracts: true,
  completionPolicy: true,
  typedDiscoveries: true,
  versionedPlans: true,
  contextPacks: true,
  repositoryIntent: true,
  observedRepositoryIntent: true,
  durableHandoffs: true,
  agentDirectory: true,
  agentPresence: true,
  addressedMessaging: true,
  messageAcknowledgements: true,
  threadedConversations: true,
  realtimeInbox: true,
  causalConflicts: true,
  metrics: true,
  resumableWatch: true,
  postgresProjection: true,
});

export const BATCH_OPERATION_SCHEMAS = Object.freeze({
  create: { required: ['op', 'type', 'title'], optional: ['ref', 'description', 'status', 'priority', 'parent', 'branch', 'prUrl', 'assignee', 'labels', 'by', 'model'] },
  update: { required: ['op', 'id', 'fields'] },
  status: { required: ['op', 'id', 'status'] },
  delete: { required: ['op', 'id'] },
  comment: { required: ['op', 'id', 'body'], optional: ['author'] },
  link: { required: ['op', 'from', 'type', 'to'] },
  unlink: { required: ['op', 'from', 'type', 'to'] },
  workspace: { required: ['op', 'fields'] },
  assert: { required: ['op', 'id', 'fields'], description: 'Compare ticket fields and abort the whole batch on mismatch.' },
});

/** The executable, transport-independent contract consumed by agents and docs. */
export function buildCapabilities({ cliVersion, workspace = null } = {}) {
  return {
    cliVersion: cliVersion ?? null,
    protocolVersion: PROTOCOL_VERSION,
    eventFormatVersion: EVENT_FORMAT_VERSION,
    eventFormat: {
      writerVersion: EVENT_FORMAT_VERSION,
      readerVersions: SUPPORTED_EVENT_FORMAT_VERSIONS,
      minimumReaderVersion: MINIMUM_READER_EVENT_FORMAT_VERSION,
    },
    eventKinds: EVENT_KINDS,
    enums: {
      ticketTypes: TICKET_TYPES,
      priorities: PRIORITIES,
      relationTypes: RELATION_TYPES,
      statuses: workspace?.columns?.map((column) => column.id) ?? STATUSES,
    },
    features: AGENT_PROTOCOL_FEATURES,
    batchOps: BATCH_OPERATION_SCHEMAS,
    workspace: workspace
      ? { key: workspace.key, name: workspace.name, columns: workspace.columns }
      : null,
  };
}
