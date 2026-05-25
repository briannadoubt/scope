import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb, findScopeDir, defaultScopeDir, SCOPE_DIR_NAME } from './db.js';
import {
  createProject,
  getProject,
  listProjects,
  updateProject,
  deleteProject,
  createTicket,
  getTicket,
  listTickets,
  updateTicket,
  deleteTicket,
  addRelation,
  removeRelation,
  listRelations,
  addComment,
  listComments,
  listHistory,
  listEpicChildren,
  epicProgress,
  SCHEMA_STATUSES,
  SCHEMA_PRIORITIES,
  SCHEMA_TICKET_TYPES,
  SCHEMA_RELATION_TYPES,
} from './repo.js';

const STATUS = z.enum(SCHEMA_STATUSES);
const PRIORITY = z.enum(SCHEMA_PRIORITIES);
const TYPE = z.enum(SCHEMA_TICKET_TYPES);
const RELATION = z.enum(SCHEMA_RELATION_TYPES);

function ok(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function fail(err) {
  return {
    isError: true,
    content: [{ type: 'text', text: String(err.message || err) }],
  };
}

function wrap(fn) {
  return async (args) => {
    try {
      const data = await fn(args);
      return ok(data);
    } catch (e) {
      return fail(e);
    }
  };
}

/**
 * Resolve the .scope directory:
 *  - explicit option (`--scope-dir` on the CLI subcommand)
 *  - SCOPE_DIR env var
 *  - walk up from CWD
 *  - if `autoInit` is true and none found, create one in CWD
 */
function resolveScopeDir({ explicit, autoInit }) {
  if (explicit) {
    const dir = resolve(explicit);
    if (!existsSync(dir)) {
      if (autoInit) mkdirSync(dir, { recursive: true });
      else throw new Error(`scope-dir does not exist: ${dir}`);
    }
    return dir;
  }
  if (process.env.SCOPE_DIR) {
    const dir = resolve(process.env.SCOPE_DIR);
    if (!existsSync(dir)) {
      if (autoInit) mkdirSync(dir, { recursive: true });
      else throw new Error(`SCOPE_DIR does not exist: ${dir}`);
    }
    return dir;
  }
  const found = findScopeDir();
  if (found) return found;
  if (autoInit) {
    const dir = defaultScopeDir();
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  throw new Error(
    `No ${SCOPE_DIR_NAME}/ directory found. Run \`scope init\`, set SCOPE_DIR, or pass --scope-dir.`
  );
}

export function buildMcpServer({ scopeDir, autoInit = false, db: existingDb } = {}) {
  let dir;
  let db;
  if (existingDb) {
    db = existingDb;
    dir = scopeDir ?? '(shared)';
  } else {
    dir = resolveScopeDir({ explicit: scopeDir, autoInit });
    db = openDb(dir);
  }

  const server = new McpServer(
    { name: 'scope', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Local kanban for projects, epics, stories, and bugs. ' +
        'Use these tools to plan and track work. Ticket IDs look like "SCP-1" (project key + number). ' +
        `Statuses: ${SCHEMA_STATUSES.join('|')}. Types: ${SCHEMA_TICKET_TYPES.join('|')}.`,
    }
  );

  /* ---------- projects ---------- */

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: 'List all projects in this scope database.',
      inputSchema: {},
    },
    wrap(async () => listProjects(db))
  );

  server.registerTool(
    'get_project',
    {
      title: 'Get project',
      description:
        'Show a project with its epics (including per-epic progress) and all tickets.',
      inputSchema: {
        id_or_key: z
          .string()
          .describe('Project id (slug, e.g. "my-app") or key (e.g. "APP").'),
      },
    },
    wrap(async ({ id_or_key }) => {
      const p = getProject(db, id_or_key);
      if (!p) throw new Error(`Project not found: ${id_or_key}`);
      const tickets = listTickets(db, { projectIdOrKey: p.id });
      const epics = tickets
        .filter((t) => t.type === 'epic')
        .map((e) => ({ ...e, progress: epicProgress(db, e.id) }));
      return { ...p, tickets, epics };
    })
  );

  server.registerTool(
    'create_project',
    {
      title: 'Create project',
      description:
        'Create a new project. The key is used to prefix ticket IDs (e.g. key "APP" → tickets "APP-1", "APP-2"...).',
      inputSchema: {
        id: z
          .string()
          .describe('Slug, lowercase letters/digits/hyphens (e.g. "my-app").'),
        key: z
          .string()
          .describe('2-10 uppercase letters/digits (e.g. "APP"). Used as ticket ID prefix.'),
        name: z.string().describe('Human-readable name.'),
        description: z.string().optional().describe('Short one-line description.'),
        overview: z
          .string()
          .optional()
          .describe('Long-form markdown: goals, architecture, scope, etc.'),
      },
    },
    wrap(async (args) =>
      createProject(db, {
        id: args.id,
        key: args.key.toUpperCase(),
        name: args.name,
        description: args.description ?? '',
        overview: args.overview ?? '',
      })
    )
  );

  server.registerTool(
    'update_project',
    {
      title: 'Update project',
      description: 'Update name, description, or overview of a project.',
      inputSchema: {
        id_or_key: z.string(),
        name: z.string().optional(),
        description: z.string().optional(),
        overview: z.string().optional(),
      },
    },
    wrap(async ({ id_or_key, ...fields }) => updateProject(db, id_or_key, fields))
  );

  server.registerTool(
    'delete_project',
    {
      title: 'Delete project',
      description: 'Delete a project and all its tickets. Destructive.',
      inputSchema: {
        id_or_key: z.string(),
        confirm: z.literal(true).describe('Must be true; safety guard.'),
      },
    },
    wrap(async ({ id_or_key }) => {
      const p = getProject(db, id_or_key);
      if (!p) throw new Error(`Project not found: ${id_or_key}`);
      deleteProject(db, p.id);
      return { deleted: p.id };
    })
  );

  /* ---------- tickets ---------- */

  server.registerTool(
    'list_tickets',
    {
      title: 'List tickets',
      description:
        'List tickets across all projects, filterable by project / type / status / parent epic / assignee.',
      inputSchema: {
        project: z.string().optional().describe('Project id or key.'),
        type: TYPE.optional(),
        status: STATUS.optional(),
        parent: z
          .string()
          .optional()
          .describe('Parent epic id, or the literal "none" to list top-level tickets.'),
        assignee: z.string().optional(),
      },
    },
    wrap(async (args) => {
      const filter = {
        projectIdOrKey: args.project,
        type: args.type,
        status: args.status,
        assignee: args.assignee,
      };
      if (args.parent !== undefined) {
        filter.parentId = args.parent === 'none' ? null : args.parent;
      }
      return listTickets(db, filter);
    })
  );

  server.registerTool(
    'get_ticket',
    {
      title: 'Get ticket',
      description:
        'Get a ticket with its relations, comments, history, children (if epic), and epic progress.',
      inputSchema: {
        id: z.string().describe('Ticket id, e.g. "APP-3".'),
      },
    },
    wrap(async ({ id }) => {
      const t = getTicket(db, id);
      if (!t) throw new Error(`Ticket not found: ${id}`);
      return {
        ...t,
        relations: listRelations(db, t.id),
        comments: listComments(db, t.id),
        history: listHistory(db, t.id),
        children: t.type === 'epic' ? listEpicChildren(db, t.id) : [],
        progress: t.type === 'epic' ? epicProgress(db, t.id) : null,
      };
    })
  );

  server.registerTool(
    'create_ticket',
    {
      title: 'Create ticket',
      description:
        'Create a ticket. Use type "epic" for high-level work; use "story" or "bug" with parent set to an epic id for breakdown.',
      inputSchema: {
        project: z.string().describe('Project id or key.'),
        type: TYPE.default('story'),
        title: z.string(),
        description: z.string().optional().describe('Markdown body.'),
        status: STATUS.default('backlog'),
        priority: PRIORITY.default('medium'),
        parent: z
          .string()
          .optional()
          .describe('Parent epic id (required-ish for stories/bugs that belong to an epic).'),
        branch: z.string().optional(),
        pr_url: z.string().optional(),
        assignee: z.string().optional(),
        labels: z.array(z.string()).optional(),
      },
    },
    wrap(async (args) =>
      createTicket(db, {
        projectIdOrKey: args.project,
        type: args.type,
        title: args.title,
        description: args.description ?? '',
        status: args.status,
        priority: args.priority,
        parent: args.parent,
        branch: args.branch,
        prUrl: args.pr_url,
        assignee: args.assignee,
        labels: args.labels ?? [],
      })
    )
  );

  server.registerTool(
    'update_ticket',
    {
      title: 'Update ticket',
      description:
        'Update any field on a ticket. Pass null for branch/pr_url/assignee/parent_id to clear them.',
      inputSchema: {
        id: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        status: STATUS.optional(),
        priority: PRIORITY.optional(),
        parent_id: z.string().nullable().optional(),
        branch: z.string().nullable().optional(),
        pr_url: z.string().nullable().optional(),
        assignee: z.string().nullable().optional(),
        labels: z.array(z.string()).optional(),
        by: z.string().optional().describe('Author of the change (recorded in history).'),
      },
    },
    wrap(async ({ id, by, ...fields }) => updateTicket(db, id, fields, by))
  );

  server.registerTool(
    'delete_ticket',
    {
      title: 'Delete ticket',
      description: 'Delete a ticket. Children of a deleted epic are detached (not deleted).',
      inputSchema: {
        id: z.string(),
        confirm: z.literal(true).describe('Must be true; safety guard.'),
      },
    },
    wrap(async ({ id }) => {
      const ok = deleteTicket(db, id);
      if (!ok) throw new Error(`Ticket not found: ${id}`);
      return { deleted: id };
    })
  );

  server.registerTool(
    'set_status',
    {
      title: 'Set ticket status',
      description: 'Move a ticket to a new status. Convenience over update_ticket.',
      inputSchema: {
        id: z.string(),
        status: STATUS,
        by: z.string().optional(),
      },
    },
    wrap(async ({ id, status, by }) => updateTicket(db, id, { status }, by))
  );

  server.registerTool(
    'set_branch',
    {
      title: 'Set ticket branch',
      description:
        'Attach a git branch to a ticket. If transition_to_in_progress is true, also flip status to in_progress.',
      inputSchema: {
        id: z.string(),
        branch: z.string().nullable().describe('Branch name, or null to clear.'),
        transition_to_in_progress: z.boolean().optional().default(false),
        by: z.string().optional(),
      },
    },
    wrap(async ({ id, branch, transition_to_in_progress, by }) => {
      const fields = { branch };
      if (transition_to_in_progress && branch) fields.status = 'in_progress';
      return updateTicket(db, id, fields, by);
    })
  );

  server.registerTool(
    'set_pr',
    {
      title: 'Set ticket PR',
      description:
        'Attach a PR URL to a ticket. transition can be "in_review" or "done" to also update status.',
      inputSchema: {
        id: z.string(),
        pr_url: z.string().nullable(),
        transition: z.enum(['in_review', 'done', 'none']).optional().default('none'),
        by: z.string().optional(),
      },
    },
    wrap(async ({ id, pr_url, transition, by }) => {
      const fields = { pr_url };
      if (transition === 'in_review' && pr_url) fields.status = 'in_review';
      if (transition === 'done') fields.status = 'done';
      return updateTicket(db, id, fields, by);
    })
  );

  /* ---------- relations ---------- */

  server.registerTool(
    'add_relation',
    {
      title: 'Add ticket relation',
      description:
        `Link two tickets. The inverse relation is created automatically. Types: ${SCHEMA_RELATION_TYPES.join('|')}.`,
      inputSchema: {
        from: z.string().describe('Source ticket id.'),
        to: z.string().describe('Target ticket id.'),
        type: RELATION,
      },
    },
    wrap(async ({ from, to, type }) => addRelation(db, from, to, type))
  );

  server.registerTool(
    'remove_relation',
    {
      title: 'Remove ticket relation',
      description: 'Remove a relation (and its inverse) between two tickets.',
      inputSchema: {
        from: z.string(),
        to: z.string(),
        type: RELATION,
      },
    },
    wrap(async ({ from, to, type }) => {
      removeRelation(db, from, to, type);
      return { ok: true };
    })
  );

  server.registerTool(
    'list_relations',
    {
      title: 'List ticket relations',
      description: 'List relations of a ticket (with target titles and statuses).',
      inputSchema: {
        id: z.string(),
      },
    },
    wrap(async ({ id }) => listRelations(db, id))
  );

  /* ---------- epic helpers ---------- */

  server.registerTool(
    'list_epic_children',
    {
      title: 'List epic children',
      description: 'List the stories and bugs that belong to an epic.',
      inputSchema: { epic_id: z.string() },
    },
    wrap(async ({ epic_id }) => {
      const e = getTicket(db, epic_id);
      if (!e) throw new Error(`Epic not found: ${epic_id}`);
      if (e.type !== 'epic') throw new Error(`${epic_id} is not an epic.`);
      return listEpicChildren(db, e.id);
    })
  );

  server.registerTool(
    'get_epic_progress',
    {
      title: 'Get epic progress',
      description: 'Get done/total counts and percentage for an epic.',
      inputSchema: { epic_id: z.string() },
    },
    wrap(async ({ epic_id }) => epicProgress(db, epic_id))
  );

  /* ---------- comments / history ---------- */

  server.registerTool(
    'add_comment',
    {
      title: 'Add comment',
      description: 'Add a comment to a ticket.',
      inputSchema: {
        id: z.string(),
        body: z.string(),
        author: z.string().optional(),
      },
    },
    wrap(async ({ id, body, author }) => addComment(db, id, body, author))
  );

  server.registerTool(
    'list_comments',
    {
      title: 'List comments',
      description: 'List comments on a ticket in chronological order.',
      inputSchema: { id: z.string() },
    },
    wrap(async ({ id }) => listComments(db, id))
  );

  server.registerTool(
    'list_history',
    {
      title: 'List ticket history',
      description: 'List the change log for a ticket (every field update).',
      inputSchema: { id: z.string() },
    },
    wrap(async ({ id }) => listHistory(db, id))
  );

  /* ---------- board ---------- */

  server.registerTool(
    'get_board',
    {
      title: 'Get board',
      description:
        'Get tickets bucketed by status, optionally filtered to one project or one epic. Returns { columns, buckets } where buckets is { status: ticket[] }.',
      inputSchema: {
        project: z.string().optional(),
        epic: z.string().optional().describe('Filter to children of this epic id.'),
      },
    },
    wrap(async ({ project, epic }) => {
      const tickets = listTickets(db, {
        projectIdOrKey: project,
        parentId: epic,
      });
      const buckets = Object.fromEntries(SCHEMA_STATUSES.map((s) => [s, []]));
      for (const t of tickets) if (buckets[t.status]) buckets[t.status].push(t);
      return { columns: SCHEMA_STATUSES, buckets };
    })
  );

  /* ---------- meta ---------- */

  server.registerTool(
    'get_meta',
    {
      title: 'Get scope metadata',
      description:
        'Get the location of the scope database and the legal values for statuses, priorities, types, and relation types.',
      inputSchema: {},
    },
    wrap(async () => ({
      scope_dir: dir,
      statuses: SCHEMA_STATUSES,
      priorities: SCHEMA_PRIORITIES,
      ticket_types: SCHEMA_TICKET_TYPES,
      relation_types: SCHEMA_RELATION_TYPES,
    }))
  );

  return { server, db, scopeDir: dir };
}

export async function runMcpStdio({ scopeDir, autoInit } = {}) {
  const { server } = buildMcpServer({ scopeDir, autoInit });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
