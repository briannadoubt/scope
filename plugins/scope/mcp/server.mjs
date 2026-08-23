#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const widgetHtml = readFileSync(new URL('./scope-widget.html', import.meta.url), 'utf8');
const widgetUri = 'ui://scope/board.html';
const authFlows = new Map();
const workspacePathProperty = {
  type: 'string',
  description: 'Optional repository path containing .scope/. Defaults to the current Codex workspace when available.'
};
const remoteProperty = {
  type: 'string',
  description: 'Hosted Scope hub base URL. Falls back to the workspace remote config when omitted for status/logout.'
};
const requestIdProperty = {
  type: 'string',
  description: 'Stable idempotency key. Reuse it when retrying the same mutation.'
};
const capabilityListProperty = {
  type: 'array', items: { type: 'string' },
  description: 'Capabilities available to the executing agent.'
};

const tools = [
  {
    name: 'scope_capabilities',
    description: 'Discover Scope protocol versions, features, event kinds, schemas, and workspace vocabulary before using it.',
    inputSchema: { type: 'object', properties: { workspacePath: workspacePathProperty }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'scope_ready',
    description: 'List capability-eligible unclaimed work, or explain one ticket readiness.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }, capabilities: capabilityListProperty,
        parent: { type: 'string' }, plan: { type: 'boolean', default: false },
        workspacePath: workspacePathProperty
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'scope_claim',
    description: 'Atomically claim a specific ticket or the best ready ticket, creating an expiring lease and execution attempt.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }, agent: { type: 'string' }, ttl: { type: 'string', default: '20m' },
        capabilities: capabilityListProperty,
        files: { type: 'array', items: { type: 'string' } },
        worktree: { type: 'string' }, branch: { type: 'string' }, base: { type: 'string' },
        parent: { type: 'string' }, requestId: requestIdProperty, workspacePath: workspacePathProperty
      },
      required: ['agent'], additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'scope_context',
    description: 'Load a compact deterministic ticket context pack, optionally incremental from a prior cursor.',
    inputSchema: {
      type: 'object', properties: {
        id: { type: 'string' }, since: { type: 'string' }, budget: { type: 'integer', minimum: 250 },
        workspacePath: workspacePathProperty
      }, required: ['id'], additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'scope_discover',
    description: 'Publish a typed decision, fact, risk, blocker, question, handoff, or evidence record.',
    inputSchema: {
      type: 'object', properties: {
        id: { type: 'string' }, type: { type: 'string', enum: ['decision', 'fact', 'risk', 'blocker', 'question', 'handoff', 'evidence'] },
        body: { type: 'string' }, data: { type: 'object' }, by: { type: 'string', default: 'codex' },
        requestId: requestIdProperty, workspacePath: workspacePathProperty
      }, required: ['id', 'type', 'body'], additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'scope_handoff',
    description: 'Record a durable structured handoff and finish/release the current running attempt when present.',
    inputSchema: {
      type: 'object', properties: {
        id: { type: 'string' }, agent: { type: 'string' }, summary: { type: 'string' },
        to: { type: 'string' }, attemptId: { type: 'string' }, decisions: { type: 'array' },
        remaining: { type: 'array' }, blockers: { type: 'array' }, verification: { type: 'array' },
        evidence: { type: 'array' }, files: { type: 'array', items: { type: 'string' } },
        keepAttempt: { type: 'boolean', default: false }, requestId: requestIdProperty,
        workspacePath: workspacePathProperty
      }, required: ['id', 'agent', 'summary'], additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'scope_lease_renew',
    description: 'Renew an active execution lease owned by an agent.',
    inputSchema: {
      type: 'object', properties: {
        leaseId: { type: 'string' }, agent: { type: 'string' }, ttl: { type: 'string', default: '20m' },
        requestId: requestIdProperty, workspacePath: workspacePathProperty
      }, required: ['leaseId', 'agent'], additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'scope_agent_register',
    description: 'Register or refresh an agent identity and its heartbeat-based presence.',
    inputSchema: {
      type: 'object', properties: {
        agent: { type: 'string' }, displayName: { type: 'string' }, provider: { type: 'string' },
        capabilities: capabilityListProperty, metadata: { type: 'object' },
        status: { type: 'string', enum: ['online', 'busy', 'away', 'offline'], default: 'online' },
        ttl: { type: 'string', default: '2m' }, by: { type: 'string' },
        requestId: requestIdProperty, workspacePath: workspacePathProperty
      }, required: ['agent'], additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'scope_agent_heartbeat',
    description: 'Renew an agent presence lease and optionally update status, capabilities, or metadata.',
    inputSchema: {
      type: 'object', properties: {
        agent: { type: 'string' }, status: { type: 'string', enum: ['online', 'busy', 'away', 'offline'] },
        capabilities: capabilityListProperty, metadata: { type: 'object' }, ttl: { type: 'string', default: '2m' },
        by: { type: 'string' }, requestId: requestIdProperty, workspacePath: workspacePathProperty
      }, required: ['agent'], additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'scope_agents',
    description: 'List registered agents and their current heartbeat-derived presence.',
    inputSchema: {
      type: 'object', properties: { onlineOnly: { type: 'boolean', default: false }, workspacePath: workspacePathProperty },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'scope_message_send',
    description: 'Send a durable addressed message to another agent, optionally linked to a ticket or thread.',
    inputSchema: {
      type: 'object', properties: {
        from: { type: 'string' }, to: { type: 'string' }, body: { type: 'string' },
        kind: { type: 'string', default: 'question' }, ticket: { type: 'string' },
        thread: { type: 'string' }, replyTo: { type: 'string' }, correlation: { type: 'string' },
        artifactRefs: { type: 'array' }, ttl: { type: 'string' }, by: { type: 'string' },
        requestId: requestIdProperty, workspacePath: workspacePathProperty
      }, required: ['from', 'to', 'body'], additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'scope_message_inbox',
    description: 'Read pending addressed messages for an agent. Unacknowledged messages remain available for retry.',
    inputSchema: {
      type: 'object', properties: {
        agent: { type: 'string' }, includeAcknowledged: { type: 'boolean', default: false },
        includeExpired: { type: 'boolean', default: false }, since: { type: 'string' },
        ticket: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 1000 },
        workspacePath: workspacePathProperty
      }, required: ['agent'], additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'scope_message_ack',
    description: 'Acknowledge delivery of a message as its addressed recipient.',
    inputSchema: {
      type: 'object', properties: {
        messageId: { type: 'string' }, agent: { type: 'string' }, by: { type: 'string' },
        requestId: requestIdProperty, workspacePath: workspacePathProperty
      }, required: ['messageId', 'agent'], additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'scope_message_reply',
    description: 'Reply inside an existing direct-agent conversation.',
    inputSchema: {
      type: 'object', properties: {
        messageId: { type: 'string' }, from: { type: 'string' }, body: { type: 'string' },
        kind: { type: 'string', default: 'reply' }, artifactRefs: { type: 'array' },
        ttl: { type: 'string' }, by: { type: 'string' }, requestId: requestIdProperty,
        workspacePath: workspacePathProperty
      }, required: ['messageId', 'from', 'body'], additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'scope_complete',
    description: 'Atomically finish an attempt, attach evidence and verification, release its lease, and move the ticket to done.',
    inputSchema: {
      type: 'object', properties: {
        id: { type: 'string' }, attemptId: { type: 'string' }, agent: { type: 'string' }, summary: { type: 'string' },
        evidence: { type: 'array' }, verification: { type: 'array' }, branch: { type: 'string' }, pr: { type: 'string' },
        requestId: requestIdProperty, workspacePath: workspacePathProperty
      }, required: ['id', 'attemptId', 'agent'], additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'scope_board',
    description: 'Use this when you need the current Scope board as structured data.',
    inputSchema: { type: 'object', properties: { workspacePath: workspacePathProperty }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'scope_ticket_show',
    description: 'Use this when you need the full details for one Scope ticket.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Scope ticket id, such as SCP-123.' },
        workspacePath: workspacePathProperty
      },
      required: ['id'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'scope_ticket_create',
    description: 'Use this when you need to create a Scope epic, story, or bug.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        type: { type: 'string', enum: ['epic', 'story', 'bug'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
        parent: { type: 'string' },
        description: { type: 'string' },
        workspacePath: workspacePathProperty
      },
      required: ['title', 'type'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'scope_status',
    description: 'Use this when you need to move one or more Scope tickets to a new status.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        status: { type: 'string', description: 'Workspace column id discovered through scope_capabilities.' },
        by: { type: 'string', default: 'codex' },
        workspacePath: workspacePathProperty
      },
      required: ['ids', 'status'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'scope_comment',
    description: 'Use this when you need to add a durable comment to a Scope ticket.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        body: { type: 'string' },
        by: { type: 'string', default: 'codex' },
        workspacePath: workspacePathProperty
      },
      required: ['id', 'body'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'scope_render_board',
    title: 'Render Scope Board',
    description: 'Use this when the user wants an inline Scope board UI. Call scope_board first if you need to inspect the data.',
    inputSchema: { type: 'object', properties: { workspacePath: workspacePathProperty }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: {
      'ui.resourceUri': widgetUri,
      'ui.visibility': ['model', 'app'],
      'openai/outputTemplate': widgetUri,
      'openai/toolInvocation/invoking': 'Loading Scope board',
      'openai/toolInvocation/invoked': 'Scope board ready'
    }
  },
  {
    name: 'scope_render_sidebar',
    title: 'Open Scope Sidebar',
    description: 'Use this when the user wants a sidebar-style Scope workspace tab with active work and board context.',
    inputSchema: { type: 'object', properties: { workspacePath: workspacePathProperty }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: {
      'ui.resourceUri': widgetUri,
      'ui.visibility': ['model', 'app'],
      'openai/outputTemplate': widgetUri,
      'openai/toolInvocation/invoking': 'Opening Scope sidebar',
      'openai/toolInvocation/invoked': 'Scope sidebar ready'
    }
  },
  {
    name: 'scope_auth_status',
    description: 'Use this to check whether Scope has a stored hosted-hub credential for this workspace or remote.',
    inputSchema: {
      type: 'object',
      properties: {
        remote: remoteProperty,
        workspacePath: workspacePathProperty
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
  },
  {
    name: 'scope_auth_begin',
    description: 'Use this to start browser-approved hosted Scope authentication without exposing the resulting secret to the model.',
    inputSchema: {
      type: 'object',
      properties: {
        remote: { ...remoteProperty, description: 'Hosted Scope hub base URL.' },
        name: { type: 'string', description: 'Client name shown on the approval page.' },
        workspacePath: workspacePathProperty
      },
      required: ['remote'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  },
  {
    name: 'scope_auth_poll',
    description: 'Use this after scope_auth_begin to complete approval and store the hosted credential locally. Does not return the credential.',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'Flow id returned by scope_auth_begin.' },
        workspacePath: workspacePathProperty
      },
      required: ['flowId'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  },
  {
    name: 'scope_auth_logout',
    description: 'Use this to forget the stored hosted Scope credential for this workspace or remote.',
    inputSchema: {
      type: 'object',
      properties: {
        remote: remoteProperty,
        workspacePath: workspacePathProperty
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }
];

function workspaceCwd(workspacePath) {
  return resolve(workspacePath || process.env.SCOPE_WORKSPACE || process.env.CODEX_WORKSPACE_ROOT || process.env.INIT_CWD || process.env.PWD || process.cwd());
}

function runScope(args, workspacePath) {
  const result = spawnSync(process.env.SCOPE_BIN || 'scope', args, { cwd: workspaceCwd(workspacePath), encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'Scope command failed').trim());
  }
  return result.stdout.trim();
}

function runScopeJson(args, workspacePath) {
  const out = runScope(['--json', ...args], workspacePath);
  const envelope = out ? JSON.parse(out) : null;
  if (envelope?.ok === true) return envelope.data;
  if (envelope?.ok === false) {
    const error = new Error(envelope.error?.message || 'Scope command failed');
    error.code = envelope.error?.code;
    error.retryable = envelope.error?.retryable;
    error.details = envelope.error?.details;
    throw error;
  }
  return envelope; // compatibility with Scope versions before protocol 1.0
}

function mutationArgs(requestId, args) {
  return requestId ? ['--request-id', requestId, ...args] : args;
}

function boardPayload(mode = 'inline', workspacePath) {
  const board = runScopeJson(['board'], workspacePath);
  const workspaceRaw = runScopeJson(['workspace', 'show'], workspacePath);
  const workspace = {
    id: workspaceRaw?.id,
    key: workspaceRaw?.key,
    name: workspaceRaw?.name,
    description: workspaceRaw?.description
  };
  const statuses = Array.isArray(board?.columns)
    ? board.columns.map((column) => column.id)
    : ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'];
  const tickets = Array.isArray(board)
    ? board
    : Array.isArray(board?.tickets)
      ? board.tickets
      : [];
  const sourceColumns = Array.isArray(board?.columns)
    ? board.columns.map((column) => ({ status: column.id, tickets: board.buckets?.[column.id] ?? [] }))
    : board?.columns
      ? Object.entries(board.columns).map(([status, value]) => ({ status, tickets: Array.isArray(value) ? value : [] }))
      : statuses.map((status) => ({ status, tickets: tickets.filter((ticket) => ticket.status === status) }));
  const columns = sourceColumns.map((column) => ({
    status: column.status,
    tickets: column.tickets.slice(0, mode === 'sidebar' ? 12 : 6).map(compactTicket)
  }));
  const counts = {
    open: columns.filter((c) => !['done', 'cancelled'].includes(c.status)).reduce((n, c) => n + c.tickets.length, 0),
    inProgress: columns.find((c) => c.status === 'in_progress')?.tickets.length || 0,
    review: columns.find((c) => c.status === 'in_review')?.tickets.length || 0,
    done: columns.find((c) => c.status === 'done')?.tickets.length || 0
  };
  return {
    mode,
    workspace,
    columns,
    counts,
    summary: `${counts.open} open, ${counts.inProgress} active, ${counts.review} in review`
  };
}

function compactAuthBegin(grant, flowId) {
  return {
    flowId,
    remote: grant.remote,
    user_code: grant.user_code,
    verification_uri: grant.verification_uri,
    verification_uri_complete: grant.verification_uri_complete,
    expires_in: grant.expires_in,
    expires_at: grant.expires_at,
    interval: grant.interval
  };
}

function compactTicket(ticket) {
  return {
    id: ticket.id,
    title: ticket.title,
    type: ticket.type,
    priority: ticket.priority,
    status: ticket.status,
    parent_id: ticket.parent_id,
    branch: ticket.branch,
    pr_url: ticket.pr_url,
    assignee: ticket.assignee,
    execution: ticket.execution ? {
      phase: ticket.execution.phase,
      agent: ticket.execution.agent,
      reclaimable: ticket.execution.reclaimable,
      files: ticket.execution.files,
      lease: ticket.execution.lease ? {
        leaseId: ticket.execution.lease.leaseId,
        state: ticket.execution.lease.state,
        expiresAt: ticket.execution.lease.expiresAt
      } : null,
      latestDiscovery: ticket.execution.latestDiscovery,
      verification: ticket.execution.verification
    } : null
  };
}

async function callTool(name, args = {}) {
  if (name === 'scope_capabilities') {
    const data = runScopeJson(['capabilities'], args.workspacePath);
    return toolResult(data, `Scope agent protocol ${data.protocolVersion} discovered.`);
  }
  if (name === 'scope_ready') {
    const cli = ['ready'];
    if (args.id) cli.push(args.id);
    if (args.capabilities?.length) cli.push('--capabilities', args.capabilities.join(','));
    if (args.parent) cli.push('--parent', args.parent);
    if (args.plan) cli.push('--plan');
    const data = runScopeJson(cli, args.workspacePath);
    return toolResult(data, args.id ? `Readiness loaded for ${args.id}.` : 'Ready work loaded.');
  }
  if (name === 'scope_claim') {
    const cli = ['claim'];
    if (args.id) cli.push(args.id);
    cli.push('--agent', args.agent);
    if (args.ttl) cli.push('--ttl', args.ttl);
    if (args.capabilities?.length) cli.push('--capabilities', args.capabilities.join(','));
    if (args.files?.length) cli.push('--files', args.files.join(','));
    if (args.worktree) cli.push('--worktree', args.worktree);
    if (args.branch) cli.push('--branch', args.branch);
    if (args.base) cli.push('--base', args.base);
    if (args.parent) cli.push('--parent', args.parent);
    const data = runScopeJson(mutationArgs(args.requestId, cli), args.workspacePath);
    return toolResult(data, `Claimed ${data.ticket?.id || data.lease?.ticketId}.`);
  }
  if (name === 'scope_context') {
    const cli = ['context', args.id];
    if (args.since) cli.push('--since', args.since);
    if (args.budget) cli.push('--budget', String(args.budget));
    const data = runScopeJson(cli, args.workspacePath);
    return toolResult(data, `Context loaded for ${args.id}.`);
  }
  if (name === 'scope_discover') {
    const cli = ['discover', args.id, args.type, args.body, '--by', args.by || 'codex'];
    if (args.data) cli.push('--data', JSON.stringify(args.data));
    const data = runScopeJson(mutationArgs(args.requestId, cli), args.workspacePath);
    return toolResult(data, `Recorded ${args.type} on ${args.id}.`);
  }
  if (name === 'scope_handoff') {
    const cli = ['handoff', 'create', args.id, '--agent', args.agent, '--summary', args.summary];
    if (args.to) cli.push('--to', args.to);
    if (args.attemptId) cli.push('--attempt', args.attemptId);
    for (const field of ['decisions', 'remaining', 'blockers', 'verification', 'evidence']) {
      if (args[field]) cli.push(`--${field}`, JSON.stringify(args[field]));
    }
    if (args.files?.length) cli.push('--files', args.files.join(','));
    if (args.keepAttempt) cli.push('--keep-attempt');
    const data = runScopeJson(mutationArgs(args.requestId, cli), args.workspacePath);
    return toolResult(data, `Recorded handoff for ${args.id}.`);
  }
  if (name === 'scope_lease_renew') {
    const cli = ['lease', 'renew', args.leaseId, '--agent', args.agent];
    if (args.ttl) cli.push('--ttl', args.ttl);
    const data = runScopeJson(mutationArgs(args.requestId, cli), args.workspacePath);
    return toolResult(data, `Renewed lease ${args.leaseId}.`);
  }
  if (name === 'scope_agent_register') {
    const cli = ['agent', 'register', args.agent];
    if (args.displayName) cli.push('--display-name', args.displayName);
    if (args.provider) cli.push('--provider', args.provider);
    if (args.capabilities?.length) cli.push('--capabilities', args.capabilities.join(','));
    if (args.metadata) cli.push('--metadata', JSON.stringify(args.metadata));
    if (args.status) cli.push('--status', args.status);
    if (args.ttl) cli.push('--ttl', args.ttl);
    if (args.by) cli.push('--by', args.by);
    const data = runScopeJson(mutationArgs(args.requestId, cli), args.workspacePath);
    return toolResult(data, `Registered ${data.agentId} (${data.status}).`);
  }
  if (name === 'scope_agent_heartbeat') {
    const cli = ['agent', 'heartbeat', args.agent];
    if (args.status) cli.push('--status', args.status);
    if (args.capabilities) cli.push('--capabilities', args.capabilities.join(','));
    if (args.metadata) cli.push('--metadata', JSON.stringify(args.metadata));
    if (args.ttl) cli.push('--ttl', args.ttl);
    if (args.by) cli.push('--by', args.by);
    const data = runScopeJson(mutationArgs(args.requestId, cli), args.workspacePath);
    return toolResult(data, `Heartbeat renewed for ${data.agentId}.`);
  }
  if (name === 'scope_agents') {
    const cli = ['agent', 'list'];
    if (args.onlineOnly) cli.push('--online');
    const data = runScopeJson(cli, args.workspacePath);
    return toolResult(data, `Loaded ${data.length} registered agents.`);
  }
  if (name === 'scope_message_send') {
    const cli = ['message', 'send', '--from', args.from, '--to', args.to, '--body', args.body];
    if (args.kind) cli.push('--kind', args.kind);
    if (args.ticket) cli.push('--ticket', args.ticket);
    if (args.thread) cli.push('--thread', args.thread);
    if (args.replyTo) cli.push('--reply-to', args.replyTo);
    if (args.correlation) cli.push('--correlation', args.correlation);
    if (args.artifactRefs) cli.push('--artifacts', JSON.stringify(args.artifactRefs));
    if (args.ttl) cli.push('--ttl', args.ttl);
    if (args.by) cli.push('--by', args.by);
    const data = runScopeJson(mutationArgs(args.requestId, cli), args.workspacePath);
    return toolResult(data, `Sent ${data.messageId} to ${data.toAgent}.`);
  }
  if (name === 'scope_message_inbox') {
    const cli = ['message', 'inbox', args.agent];
    if (args.includeAcknowledged) cli.push('--all');
    if (args.includeExpired) cli.push('--expired');
    if (args.since) cli.push('--since', args.since);
    if (args.ticket) cli.push('--ticket', args.ticket);
    if (args.limit) cli.push('--limit', String(args.limit));
    const data = runScopeJson(cli, args.workspacePath);
    return toolResult(data, `${data.length} messages in ${args.agent}'s inbox.`);
  }
  if (name === 'scope_message_ack') {
    const cli = ['message', 'ack', args.messageId, '--agent', args.agent];
    if (args.by) cli.push('--by', args.by);
    const data = runScopeJson(mutationArgs(args.requestId, cli), args.workspacePath);
    return toolResult(data, `Acknowledged ${data.messageId}.`);
  }
  if (name === 'scope_message_reply') {
    const cli = ['message', 'reply', args.messageId, '--from', args.from, '--body', args.body];
    if (args.kind) cli.push('--kind', args.kind);
    if (args.artifactRefs) cli.push('--artifacts', JSON.stringify(args.artifactRefs));
    if (args.ttl) cli.push('--ttl', args.ttl);
    if (args.by) cli.push('--by', args.by);
    const data = runScopeJson(mutationArgs(args.requestId, cli), args.workspacePath);
    return toolResult(data, `Replied with ${data.messageId}.`);
  }
  if (name === 'scope_complete') {
    const cli = ['complete', args.id, '--attempt', args.attemptId, '--agent', args.agent];
    if (args.summary) cli.push('--summary', args.summary);
    if (args.evidence) cli.push('--evidence', JSON.stringify(args.evidence));
    if (args.verification) cli.push('--verification', JSON.stringify(args.verification));
    if (args.branch) cli.push('--branch', args.branch);
    if (args.pr) cli.push('--pr', args.pr);
    const data = runScopeJson(mutationArgs(args.requestId, cli), args.workspacePath);
    return toolResult(data, `Completed ${args.id}.`);
  }
  if (name === 'scope_board') {
    const data = boardPayload('inline', args.workspacePath);
    return toolResult(data, `Scope board loaded: ${data.summary}.`);
  }
  if (name === 'scope_ticket_show') {
    const data = runScopeJson(['ticket', 'show', args.id], args.workspacePath);
    return toolResult(data, `Loaded ${args.id}.`);
  }
  if (name === 'scope_ticket_create') {
    const cli = ['ticket', 'create', args.title, '-t', args.type];
    if (args.priority) cli.push('-p', args.priority);
    if (args.parent) cli.push('--parent', args.parent);
    if (args.description) cli.push('--description', args.description);
    const data = runScopeJson(cli, args.workspacePath);
    return toolResult(data, `Created ${data?.id || 'Scope ticket'}.`);
  }
  if (name === 'scope_status') {
    const ids = args.ids.join(',');
    const text = runScope(['status', ids, args.status, '--by', args.by || 'codex'], args.workspacePath);
    return toolResult({ ids: args.ids, status: args.status, output: text }, `Moved ${ids} to ${args.status}.`);
  }
  if (name === 'scope_comment') {
    const text = runScope(['comment', args.id, args.body, '--by', args.by || 'codex'], args.workspacePath);
    return toolResult({ id: args.id, output: text }, `Commented on ${args.id}.`);
  }
  if (name === 'scope_render_board') {
    const data = boardPayload('inline', args.workspacePath);
    return toolResult(data, `Rendered Scope board: ${data.summary}.`, { 'ui.resourceUri': widgetUri });
  }
  if (name === 'scope_render_sidebar') {
    const data = boardPayload('sidebar', args.workspacePath);
    return toolResult(data, `Opened Scope sidebar: ${data.summary}.`, { 'ui.resourceUri': widgetUri });
  }
  if (name === 'scope_auth_status') {
    const cli = ['auth', 'status'];
    if (args.remote) cli.push('--remote', args.remote);
    const data = runScopeJson(cli, args.workspacePath);
    return toolResult(data, data.authenticated ? `Scope is authenticated with ${data.remote}.` : `Scope is not authenticated with ${data.remote}.`);
  }
  if (name === 'scope_auth_begin') {
    const cli = ['auth', 'begin', '--remote', args.remote];
    if (args.name) cli.push('--name', args.name);
    const grant = runScopeJson(cli, args.workspacePath);
    const flowId = randomUUID();
    authFlows.set(flowId, {
      remote: grant.remote,
      deviceCode: grant.device_code,
      expiresAt: grant.expires_at,
      workspacePath: args.workspacePath
    });
    const data = compactAuthBegin(grant, flowId);
    return toolResult(data, `Open ${data.verification_uri_complete} and approve code ${data.user_code}.`);
  }
  if (name === 'scope_auth_poll') {
    const flow = authFlows.get(args.flowId);
    if (!flow) throw new Error('Unknown or expired auth flow. Run scope_auth_begin again.');
    const data = runScopeJson(['auth', 'poll', '--remote', flow.remote, '--device-code', flow.deviceCode], args.workspacePath || flow.workspacePath);
    if (data.authenticated) authFlows.delete(args.flowId);
    return toolResult(data, data.authenticated ? `Scope is authenticated with ${data.remote}.` : 'Still waiting for approval.');
  }
  if (name === 'scope_auth_logout') {
    const cli = ['auth', 'logout'];
    if (args.remote) cli.push('--remote', args.remote);
    const data = runScopeJson(cli, args.workspacePath);
    return toolResult(data, `Forgot the stored credential for ${data.remote}.`);
  }
  throw new Error(`Unknown tool: ${name}`);
}

function toolResult(data, text, meta = {}) {
  return {
    content: [{ type: 'text', text }],
    structuredContent: data,
    _meta: meta
  };
}

function response(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id, error) {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: error.message || String(error),
      data: {
        scopeCode: error.code || 'INTERNAL_ERROR',
        retryable: error.retryable === true,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    }
  };
}

async function handle(message) {
  switch (message.method) {
    case 'initialize':
      return response(message.id, {
        protocolVersion: message.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'scope', version: '0.3.0' }
      });
    case 'notifications/initialized':
      return null;
    case 'tools/list':
      return response(message.id, { tools });
    case 'tools/call':
      return response(message.id, await callTool(message.params.name, message.params.arguments || {}));
    case 'resources/list':
      return response(message.id, {
        resources: [{
          uri: widgetUri,
          name: 'Scope board widget',
          title: 'Scope Board',
          mimeType: 'text/html;profile=mcp-app'
        }]
      });
    case 'resources/read':
      if (message.params.uri !== widgetUri) throw new Error(`Unknown resource: ${message.params.uri}`);
      return response(message.id, {
        contents: [{
          uri: widgetUri,
          mimeType: 'text/html;profile=mcp-app',
          text: widgetHtml
        }]
      });
    default:
      if (message.id === undefined) return null;
      throw new Error(`Unsupported method: ${message.method}`);
  }
}

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain().catch((error) => {
    write(errorResponse(null, error));
  });
});

async function drain() {
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const header = buffer.slice(0, headerEnd).toString('utf8');
    const match = /^Content-Length:\s*(\d+)/im.exec(header);
    if (!match) throw new Error('Missing Content-Length header');
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) return;
    const body = buffer.slice(bodyStart, bodyEnd).toString('utf8');
    buffer = buffer.slice(bodyEnd);
    const message = JSON.parse(body);
    try {
      const reply = await handle(message);
      if (reply) write(reply);
    } catch (error) {
      write(errorResponse(message.id, error));
    }
  }
}

function write(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
