#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const widgetHtml = readFileSync(new URL('./scope-widget.html', import.meta.url), 'utf8');
const widgetUri = 'ui://scope/board.html';
const workspacePathProperty = {
  type: 'string',
  description: 'Optional repository path containing .scope/. Defaults to the current Codex workspace when available.'
};

const tools = [
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
        status: { type: 'string', enum: ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'] },
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
  }
];

function workspaceCwd(workspacePath) {
  return resolve(workspacePath || process.env.SCOPE_WORKSPACE || process.env.CODEX_WORKSPACE_ROOT || process.env.INIT_CWD || process.env.PWD || process.cwd());
}

function runScope(args, workspacePath) {
  const result = spawnSync('scope', args, { cwd: workspaceCwd(workspacePath), encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'Scope command failed').trim());
  }
  return result.stdout.trim();
}

function runScopeJson(args, workspacePath) {
  const out = runScope(['--json', ...args], workspacePath);
  return out ? JSON.parse(out) : null;
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
  const statuses = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'];
  const tickets = Array.isArray(board)
    ? board
    : Array.isArray(board?.tickets)
      ? board.tickets
      : [];
  const sourceColumns = board?.columns && !Array.isArray(board?.columns)
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
    assignee: ticket.assignee
  };
}

async function callTool(name, args = {}) {
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
    error: { code: -32000, message: error.message || String(error) }
  };
}

async function handle(message) {
  switch (message.method) {
    case 'initialize':
      return response(message.id, {
        protocolVersion: message.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'scope', version: '0.2.0' }
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
