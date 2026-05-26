import { Command, Option } from 'commander';
import chalk from 'chalk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const PKG = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
    'utf8'
  )
);
import {
  openDb,
  findScopeDir,
  defaultScopeDir,
  SCOPE_DIR_NAME,
  DB_FILE_NAME,
} from './db.js';
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
  SCHEMA_RELATION_TYPES,
} from './repo.js';
import { startServer } from './server.js';
import { ensureHub, findRunningHub, startHubWatchdog, hubFetch, DEFAULT_HUB_PORT } from './hub.js';
import { loadOrCreateCa, CA_CERT_PATH, CA_KEY_PATH, CA_DIR, fingerprintHex } from './ca.js';
import { listDevices, renameDevice, findDeviceByName, removeDevice } from './devices.js';
import { revokeSerial, unrevokeSerial, listRevoked } from './revocation.js';
import {
  boardView,
  projectDetail,
  table,
  ticketDetail,
  ticketRow,
  typeBadge,
  colorStatus,
} from './format.js';

/* ---------------- helpers ---------------- */

function openOrDie() {
  const dir = findScopeDir();
  if (!dir) {
    console.error(
      chalk.red(
        `No ${SCOPE_DIR_NAME}/ directory found. Run \`scope init\` in your project root first.`
      )
    );
    process.exit(1);
  }
  return { db: openDb(dir), scopeDir: dir };
}

function out(cmd, data, formatter) {
  const opts = cmd.optsWithGlobals();
  if (opts.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  if (formatter) {
    const s = formatter(data);
    if (s) process.stdout.write(s + '\n');
  }
}

function fail(msg) {
  console.error(chalk.red(msg));
  process.exit(1);
}

function readBodyFromOpts({ description, descriptionFile, edit }) {
  if (descriptionFile) {
    try {
      return readFileSync(descriptionFile, 'utf8');
    } catch (e) {
      fail(`Could not read --description-file: ${e.message}`);
    }
  }
  if (typeof description === 'string') return description;
  if (edit) return editorPrompt('');
  return undefined;
}

function editorPrompt(initial) {
  const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
  const tmp = join(tmpdir(), `scope-${Date.now()}.md`);
  writeFileSync(tmp, initial ?? '');
  const r = spawnSync(editor, [tmp], { stdio: 'inherit' });
  if (r.status !== 0) fail(`Editor exited with status ${r.status}`);
  return readFileSync(tmp, 'utf8');
}

/**
 * Keep the event loop alive until the process receives a termination signal.
 * Used when `scope serve` attaches to an existing hub instead of starting
 * one — exiting would confuse launchers (Claude Code previews, supervisors)
 * that expect a long-running server process.
 */
function idleUntilSignaled() {
  const ticker = setInterval(() => {}, 1 << 30);
  const stop = () => { clearInterval(ticker); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
}

function parseLabels(s) {
  if (!s) return [];
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Where each tool's skill file would be installed. */
function detectTargets(_tool, projectDir) {
  const home = homedir();
  const root = projectDir ? resolve(projectDir) : process.cwd();
  return {
    claude: join(home, '.claude/skills/scope/SKILL.md'),
    codex: join(home, '.codex/AGENTS.md') + chalk.gray(' (appends if exists)'),
    cursor: join(root, '.cursor/rules/scope.mdc'),
  };
}

/* ---------------- program ---------------- */

export function buildProgram() {
  const program = new Command();
  program
    .name('scope')
    .description(
      'Local-first kanban for projects, epics, stories, and bugs. Built for agents.'
    )
    .version(PKG.version)
    .option('--json', 'output JSON instead of pretty text', false);

  /* ---------- init ---------- */
  program
    .command('init')
    .description(`Create a ${SCOPE_DIR_NAME}/ directory in the current folder.`)
    .option('-f, --force', 'reinitialize if it already exists', false)
    .action((opts, cmd) => {
      const dir = defaultScopeDir();
      if (existsSync(dir) && !opts.force) {
        console.error(chalk.yellow(`${SCOPE_DIR_NAME}/ already exists at ${dir}`));
        process.exit(0);
      }
      mkdirSync(dir, { recursive: true });
      const db = openDb(dir);
      db.close();
      out(
        cmd,
        { scope_dir: dir, db: join(dir, DB_FILE_NAME) },
        (d) =>
          chalk.green('✓') +
          ` Initialized scope at ${chalk.bold(d.scope_dir)}\n` +
          chalk.gray(`  db: ${d.db}\n  Next: scope project create <id> <KEY> <name>`)
      );
    });

  /* ---------- project ---------- */
  const project = program.command('project').description('Manage projects.');

  project
    .command('create <id> <key> <name...>')
    .description('Create a project. <id> lowercase-kebab, <key> 2-10 uppercase letters (e.g. SCP).')
    .option('-d, --description <text>', 'short description')
    .option('--overview <text>', 'long overview (goals, architecture, etc.)')
    .option('--overview-file <path>', 'read overview from a file (often a README)')
    .option('-e, --edit', 'edit overview in $EDITOR', false)
    .action((id, key, nameWords, opts, cmd) => {
      const { db } = openOrDie();
      let overview = opts.overview ?? '';
      if (opts.overviewFile) overview = readFileSync(opts.overviewFile, 'utf8');
      if (opts.edit) overview = editorPrompt(overview);
      try {
        const p = createProject(db, {
          id,
          key: key.toUpperCase(),
          name: nameWords.join(' '),
          description: opts.description ?? '',
          overview,
        });
        out(cmd, p, (p) =>
          chalk.green('✓') + ` Created project ${chalk.bold(p.key)} (${p.id}): ${p.name}`
        );
      } catch (e) {
        fail(e.message);
      }
    });

  project
    .command('list')
    .alias('ls')
    .description('List projects.')
    .action((opts, cmd) => {
      const { db } = openOrDie();
      const rows = listProjects(db);
      out(cmd, rows, (rows) =>
        table(
          rows.map((r) => ({
            key: chalk.bold(r.key),
            id: r.id,
            name: r.name,
            description: r.description,
          })),
          [
            { key: 'key', header: 'KEY' },
            { key: 'id', header: 'ID' },
            { key: 'name', header: 'NAME', width: 30 },
            { key: 'description', header: 'DESCRIPTION', width: 50 },
          ]
        )
      );
    });

  project
    .command('show <idOrKey>')
    .description('Show project details with its epics and tickets.')
    .action((idOrKey, opts, cmd) => {
      const { db } = openOrDie();
      const p = getProject(db, idOrKey);
      if (!p) fail(`Project not found: ${idOrKey}`);
      const tickets = listTickets(db, { projectIdOrKey: p.id });
      const epics = tickets.filter((t) => t.type === 'epic');
      out(cmd, { ...p, tickets, epics }, (data) =>
        projectDetail(data, { tickets: data.tickets, epics: data.epics })
      );
    });

  project
    .command('edit <idOrKey>')
    .description('Edit a project.')
    .option('-n, --name <name>')
    .option('-d, --description <text>')
    .option('--overview <text>')
    .option('--overview-file <path>')
    .option('-e, --edit', 'edit overview in $EDITOR', false)
    .action((idOrKey, opts, cmd) => {
      const { db } = openOrDie();
      const p = getProject(db, idOrKey);
      if (!p) fail(`Project not found: ${idOrKey}`);
      const fields = {};
      if (opts.name) fields.name = opts.name;
      if (opts.description !== undefined) fields.description = opts.description;
      if (opts.overview !== undefined) fields.overview = opts.overview;
      if (opts.overviewFile) fields.overview = readFileSync(opts.overviewFile, 'utf8');
      if (opts.edit) fields.overview = editorPrompt(p.overview ?? '');
      const updated = updateProject(db, p.id, fields);
      out(cmd, updated, (u) => chalk.green('✓') + ` Updated ${u.key}`);
    });

  project
    .command('delete <idOrKey>')
    .description('Delete a project and all its tickets.')
    .option('-y, --yes', 'skip confirmation', false)
    .action((idOrKey, opts, cmd) => {
      const { db } = openOrDie();
      const p = getProject(db, idOrKey);
      if (!p) fail(`Project not found: ${idOrKey}`);
      if (!opts.yes) {
        fail(`Refusing to delete ${p.key} without --yes. This removes all tickets too.`);
      }
      deleteProject(db, p.id);
      out(cmd, { deleted: p.id }, (d) =>
        chalk.green('✓') + ` Deleted project ${d.deleted}`
      );
    });

  /* ---------- ticket ---------- */
  const ticket = program.command('ticket').description('Manage tickets (epics, stories, bugs).');

  ticket
    .command('create <projectKey> <title...>')
    .description('Create a ticket in a project.')
    .addOption(
      new Option('-t, --type <type>', 'ticket type')
        .choices(['epic', 'story', 'bug'])
        .default('story')
    )
    .option('-d, --description <text>')
    .option('--description-file <path>')
    .option('-e, --edit', 'edit description in $EDITOR', false)
    .addOption(
      new Option('-s, --status <status>', 'initial status')
        .choices(SCHEMA_STATUSES)
        .default('backlog')
    )
    .addOption(
      new Option('-p, --priority <priority>', 'priority').choices(SCHEMA_PRIORITIES).default('medium')
    )
    .option('--parent <ticketId>', 'parent epic (for stories/bugs)')
    .option('--branch <name>', 'git branch')
    .option('--pr <url>', 'pull request URL')
    .option('--assignee <name>', 'assignee handle')
    .option('--labels <csv>', 'comma-separated labels')
    .action((projectKey, titleWords, opts, cmd) => {
      const { db } = openOrDie();
      const description = readBodyFromOpts(opts) ?? '';
      try {
        const t = createTicket(db, {
          projectIdOrKey: projectKey,
          type: opts.type,
          title: titleWords.join(' '),
          description,
          status: opts.status,
          priority: opts.priority,
          parent: opts.parent,
          branch: opts.branch,
          prUrl: opts.pr,
          assignee: opts.assignee,
          labels: parseLabels(opts.labels),
        });
        out(cmd, t, (t) =>
          chalk.green('✓') +
          ` Created ${typeBadge(t.type)} ${chalk.bold(t.id)}: ${t.title}`
        );
      } catch (e) {
        fail(e.message);
      }
    });

  ticket
    .command('list')
    .alias('ls')
    .description('List tickets, optionally filtered.')
    .option('-p, --project <key>', 'filter by project')
    .addOption(new Option('-t, --type <type>').choices(['epic', 'story', 'bug']))
    .addOption(new Option('-s, --status <status>').choices(SCHEMA_STATUSES))
    .option('--parent <epicId>', 'filter by parent epic ("none" for top-level)')
    .option('--assignee <name>')
    .action((opts, cmd) => {
      const { db } = openOrDie();
      const filter = {
        projectIdOrKey: opts.project,
        type: opts.type,
        status: opts.status,
        assignee: opts.assignee,
      };
      if (opts.parent) {
        filter.parentId = opts.parent === 'none' ? null : opts.parent;
      }
      const tickets = listTickets(db, filter);
      out(cmd, tickets, (tickets) =>
        table(tickets.map(ticketRow), [
          { key: 'id', header: 'ID' },
          { key: 'type', header: 'TYPE' },
          { key: 'title', header: 'TITLE', width: 50 },
          { key: 'status', header: 'STATUS' },
          { key: 'priority', header: 'PRI' },
          { key: 'parent', header: 'EPIC' },
          { key: 'branch', header: 'BRANCH', width: 24 },
          { key: 'pr', header: 'PR', width: 30 },
        ])
      );
    });

  ticket
    .command('show <id>')
    .description('Show a ticket with its children, relations, and comments.')
    .action((id, opts, cmd) => {
      const { db } = openOrDie();
      const t = getTicket(db, id);
      if (!t) fail(`Ticket not found: ${id}`);
      const relations = listRelations(db, t.id);
      const comments = listComments(db, t.id);
      const children = t.type === 'epic' ? listEpicChildren(db, t.id) : [];
      const progress = t.type === 'epic' ? epicProgress(db, t.id) : undefined;
      out(
        cmd,
        { ...t, relations, comments, children, progress },
        (data) =>
          ticketDetail(t, {
            children: data.children,
            relations: data.relations,
            comments: data.comments,
            progress: data.progress,
          })
      );
    });

  ticket
    .command('edit <id>')
    .description('Edit fields on a ticket.')
    .option('--title <text>')
    .option('-d, --description <text>')
    .option('--description-file <path>')
    .option('-e, --edit', 'open description in $EDITOR', false)
    .addOption(new Option('-s, --status <status>').choices(SCHEMA_STATUSES))
    .addOption(new Option('-p, --priority <priority>').choices(SCHEMA_PRIORITIES))
    .option('--parent <epicId>', 'set parent epic ("none" to clear)')
    .option('--branch <name>', 'git branch ("none" to clear)')
    .option('--pr <url>', 'pull request URL ("none" to clear)')
    .option('--assignee <name>')
    .option('--labels <csv>')
    .option('--by <author>', 'attribute the change in history')
    .action((id, opts, cmd) => {
      const { db } = openOrDie();
      const t = getTicket(db, id);
      if (!t) fail(`Ticket not found: ${id}`);
      const fields = {};
      if (opts.title) fields.title = opts.title;
      const body = readBodyFromOpts(opts);
      if (body !== undefined) fields.description = body;
      if (opts.status) fields.status = opts.status;
      if (opts.priority) fields.priority = opts.priority;
      if (opts.parent !== undefined)
        fields.parent_id = opts.parent === 'none' ? null : opts.parent;
      if (opts.branch !== undefined)
        fields.branch = opts.branch === 'none' ? null : opts.branch;
      if (opts.pr !== undefined) fields.pr_url = opts.pr === 'none' ? null : opts.pr;
      if (opts.assignee !== undefined) fields.assignee = opts.assignee;
      if (opts.labels !== undefined) fields.labels = parseLabels(opts.labels);
      try {
        const updated = updateTicket(db, t.id, fields, opts.by);
        out(cmd, updated, (u) => chalk.green('✓') + ` Updated ${chalk.bold(u.id)}`);
      } catch (e) {
        fail(e.message);
      }
    });

  ticket
    .command('delete <id>')
    .description('Delete a ticket.')
    .option('-y, --yes', 'skip confirmation', false)
    .action((id, opts, cmd) => {
      const { db } = openOrDie();
      const t = getTicket(db, id);
      if (!t) fail(`Ticket not found: ${id}`);
      if (!opts.yes && t.type === 'epic') {
        const kids = listEpicChildren(db, t.id);
        if (kids.length)
          fail(
            `Refusing to delete epic ${t.id} with ${kids.length} children without --yes (children will be detached, not deleted).`
          );
      }
      deleteTicket(db, t.id);
      out(cmd, { deleted: t.id }, (d) => chalk.green('✓') + ` Deleted ${d.deleted}`);
    });

  /* ---------- status / branch / pr shortcuts ---------- */

  program
    .command('status <id> <status>')
    .description(`Set a ticket's status. (${SCHEMA_STATUSES.join('|')})`)
    .option('--by <author>')
    .action((id, status, opts, cmd) => {
      const { db } = openOrDie();
      try {
        const t = updateTicket(db, id, { status }, opts.by);
        out(cmd, t, (t) =>
          chalk.green('✓') +
          ` ${chalk.bold(t.id)} → ${colorStatus(t.status)}`
        );
      } catch (e) {
        fail(e.message);
      }
    });

  program
    .command('branch <id> [branch]')
    .description('Get or set the branch for a ticket. Pass "none" to clear.')
    .option('--by <author>')
    .option('--in-progress', 'also flip the status to in_progress', false)
    .action((id, branch, opts, cmd) => {
      const { db } = openOrDie();
      const t = getTicket(db, id);
      if (!t) fail(`Ticket not found: ${id}`);
      if (branch === undefined) {
        out(cmd, { id: t.id, branch: t.branch }, (d) => d.branch ?? '(none)');
        return;
      }
      const value = branch === 'none' ? null : branch;
      const fields = { branch: value };
      if (opts.inProgress && value) fields.status = 'in_progress';
      const updated = updateTicket(db, t.id, fields, opts.by);
      out(cmd, updated, (u) =>
        chalk.green('✓') +
        ` ${chalk.bold(u.id)} branch = ${u.branch ?? '(none)'}${
          opts.inProgress ? `, status = ${colorStatus(u.status)}` : ''
        }`
      );
    });

  program
    .command('pr <id> [url]')
    .description('Get or set the PR URL for a ticket. Pass "none" to clear.')
    .option('--by <author>')
    .option('--in-review', 'also flip the status to in_review', false)
    .option('--merged', 'also flip the status to done', false)
    .action((id, url, opts, cmd) => {
      const { db } = openOrDie();
      const t = getTicket(db, id);
      if (!t) fail(`Ticket not found: ${id}`);
      if (url === undefined) {
        out(cmd, { id: t.id, pr_url: t.pr_url }, (d) => d.pr_url ?? '(none)');
        return;
      }
      const value = url === 'none' ? null : url;
      const fields = { pr_url: value };
      if (opts.merged) fields.status = 'done';
      else if (opts.inReview && value) fields.status = 'in_review';
      const updated = updateTicket(db, t.id, fields, opts.by);
      out(cmd, updated, (u) =>
        chalk.green('✓') +
        ` ${chalk.bold(u.id)} pr = ${u.pr_url ?? '(none)'}, status = ${colorStatus(u.status)}`
      );
    });

  /* ---------- relations ---------- */

  const link = program.command('link').description('Create or remove relationships between tickets.');

  link
    .command('add <fromId> <type> <toId>')
    .description(`Link two tickets. Types: ${SCHEMA_RELATION_TYPES.join('|')}`)
    .action((fromId, type, toId, opts, cmd) => {
      const { db } = openOrDie();
      try {
        const rels = addRelation(db, fromId, toId, type);
        out(cmd, rels, () =>
          chalk.green('✓') + ` ${fromId} ${chalk.gray(type)} ${toId}`
        );
      } catch (e) {
        fail(e.message);
      }
    });

  link
    .command('remove <fromId> <type> <toId>')
    .alias('rm')
    .description('Remove a relationship.')
    .action((fromId, type, toId, opts, cmd) => {
      const { db } = openOrDie();
      try {
        removeRelation(db, fromId, toId, type);
        out(cmd, { ok: true }, () => chalk.green('✓') + ` removed`);
      } catch (e) {
        fail(e.message);
      }
    });

  link
    .command('list <ticketId>')
    .alias('ls')
    .description('List relationships for a ticket.')
    .action((id, opts, cmd) => {
      const { db } = openOrDie();
      const rels = listRelations(db, id);
      out(cmd, rels, (rels) =>
        table(
          rels.map((r) => ({
            type: r.type,
            to: chalk.bold(r.to_ticket_id),
            title: r.title ?? '',
            status: r.status ? colorStatus(r.status) : '',
          })),
          [
            { key: 'type', header: 'TYPE' },
            { key: 'to', header: 'TO' },
            { key: 'title', header: 'TITLE', width: 50 },
            { key: 'status', header: 'STATUS' },
          ]
        )
      );
    });

  /* ---------- epic helpers ---------- */

  const epic = program.command('epic').description('Epic-focused convenience commands.');

  epic
    .command('list [projectKey]')
    .alias('ls')
    .description('List epics, optionally filtered to one project.')
    .action((projectKey, opts, cmd) => {
      const { db } = openOrDie();
      const epics = listTickets(db, { projectIdOrKey: projectKey, type: 'epic' });
      const enriched = epics.map((e) => ({
        ...e,
        progress: epicProgress(db, e.id),
      }));
      out(cmd, enriched, (rows) =>
        table(
          rows.map((e) => ({
            id: chalk.bold(e.id),
            title: e.title,
            status: colorStatus(e.status),
            progress: `${e.progress.done}/${e.progress.total} (${e.progress.percent}%)`,
          })),
          [
            { key: 'id', header: 'ID' },
            { key: 'title', header: 'TITLE', width: 50 },
            { key: 'status', header: 'STATUS' },
            { key: 'progress', header: 'PROGRESS' },
          ]
        )
      );
    });

  epic
    .command('children <epicId>')
    .description('List stories and bugs belonging to an epic.')
    .action((epicId, opts, cmd) => {
      const { db } = openOrDie();
      const e = getTicket(db, epicId);
      if (!e) fail(`Epic not found: ${epicId}`);
      if (e.type !== 'epic') fail(`${epicId} is not an epic (it's a ${e.type}).`);
      const children = listEpicChildren(db, e.id);
      out(cmd, children, (rows) =>
        table(rows.map(ticketRow), [
          { key: 'id', header: 'ID' },
          { key: 'type', header: 'TYPE' },
          { key: 'title', header: 'TITLE', width: 50 },
          { key: 'status', header: 'STATUS' },
          { key: 'priority', header: 'PRI' },
        ])
      );
    });

  /* ---------- comments / history ---------- */

  program
    .command('comment <ticketId> <body...>')
    .description('Add a comment to a ticket.')
    .option('--by <author>')
    .action((id, body, opts, cmd) => {
      const { db } = openOrDie();
      try {
        const c = addComment(db, id, body.join(' '), opts.by);
        out(cmd, c, () => chalk.green('✓') + ` Comment added on ${chalk.bold(id)}`);
      } catch (e) {
        fail(e.message);
      }
    });

  program
    .command('history <ticketId>')
    .description('Show change history for a ticket.')
    .action((id, opts, cmd) => {
      const { db } = openOrDie();
      const t = getTicket(db, id);
      if (!t) fail(`Ticket not found: ${id}`);
      const rows = listHistory(db, t.id);
      out(cmd, rows, (rows) =>
        table(rows, [
          { key: 'changed_at', header: 'WHEN' },
          { key: 'changed_by', header: 'WHO' },
          { key: 'field', header: 'FIELD' },
          { key: 'old_value', header: 'FROM', width: 30 },
          { key: 'new_value', header: 'TO', width: 30 },
        ])
      );
    });

  /* ---------- board / ui ---------- */

  program
    .command('board')
    .description('Render a kanban board in the terminal.')
    .option('-p, --project <key>', 'filter by project')
    .option('--epic <id>', 'only tickets in a given epic')
    .action((opts, cmd) => {
      const { db } = openOrDie();
      const tickets = listTickets(db, {
        projectIdOrKey: opts.project,
        parentId: opts.epic,
      });
      out(cmd, tickets, boardView);
    });

  /* ---------- workspace (hub registration) ---------- */

  const workspace = program
    .command('workspace')
    .alias('ws')
    .description(
      'Attach, detach, and list workspaces on the running hub (http://localhost:<port>).'
    );

  workspace
    .command('add [path]')
    .description(
      'Attach a .scope/ to the running hub. PATH defaults to the .scope/ found by walking up from cwd.'
    )
    .option('-l, --label <name>', 'human-readable label (defaults to repo dir name)')
    .option('-p, --port <port>', 'preferred hub port (auto-discovered if omitted)', String(DEFAULT_HUB_PORT))
    .action(async (pathArg, opts, cmd) => {
      const preferredPort = Number.parseInt(opts.port, 10);
      let target;
      if (pathArg) {
        target = resolve(pathArg);
        // Accept either /repo or /repo/.scope — normalize to .scope/
        if (!target.endsWith('/.scope') && !target.endsWith('/' + SCOPE_DIR_NAME)) {
          const candidate = join(target, SCOPE_DIR_NAME);
          if (existsSync(candidate)) target = candidate;
        }
      } else {
        target = findScopeDir();
      }
      if (!target) {
        fail(
          `No path given and no ${SCOPE_DIR_NAME}/ found from cwd. ` +
            `Run 'scope init' there first, or pass an explicit path.`
        );
      }
      if (!existsSync(target)) fail(`Path does not exist: ${target}`);

      const hub = await findRunningHub(preferredPort);
      if (!hub) {
        fail(
          `No scope hub running (scanned ports ${preferredPort}+). ` +
            `Start one with \`scope serve\` (in any repo) first.`
        );
      }
      try {
        const res = await hubFetch(`${hub.url}/api/workspaces`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scope_dir: target, label: opts.label }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) fail(body.error || `HTTP ${res.status}`);
        out(cmd, body, (w) =>
          chalk.green('✓') +
            ` Attached ${chalk.bold(w.label)} (${w.id.slice(0, 7)})  ${chalk.gray(w.scope_dir)}  ${chalk.gray(`→ ${hub.url}`)}`
        );
      } catch (e) {
        fail(e.message);
      }
    });

  workspace
    .command('list')
    .alias('ls')
    .description('List workspaces attached to the running hub.')
    .option('-p, --port <port>', 'preferred hub port (auto-discovered if omitted)', String(DEFAULT_HUB_PORT))
    .action(async (opts, cmd) => {
      const preferredPort = Number.parseInt(opts.port, 10);
      const hub = await findRunningHub(preferredPort);
      if (!hub) fail(`No scope hub running (scanned ports ${preferredPort}+).`);
      try {
        const res = await hubFetch(`${hub.url}/api/workspaces`);
        if (!res.ok) fail(`HTTP ${res.status}`);
        const list = await res.json();
        out(cmd, list, (rows) =>
          rows.length
            ? table(
                rows.map((w) => ({
                  id: chalk.bold(w.id.slice(0, 10)),
                  label: w.label,
                  scope_dir: chalk.gray(w.scope_dir),
                })),
                [
                  { key: 'id', header: 'ID' },
                  { key: 'label', header: 'LABEL', width: 24 },
                  { key: 'scope_dir', header: 'PATH', width: 60 },
                ]
              )
            : chalk.gray('(no workspaces attached)')
        );
      } catch (e) {
        fail(e.message);
      }
    });

  workspace
    .command('remove <id>')
    .alias('rm')
    .description('Detach a workspace from the running hub (does not delete the .scope/ files).')
    .option('-p, --port <port>', 'preferred hub port (auto-discovered if omitted)', String(DEFAULT_HUB_PORT))
    .action(async (id, opts, cmd) => {
      const preferredPort = Number.parseInt(opts.port, 10);
      const hub = await findRunningHub(preferredPort);
      if (!hub) fail(`No scope hub running (scanned ports ${preferredPort}+).`);
      try {
        const res = await hubFetch(`${hub.url}/api/workspaces/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) fail(body.error || `HTTP ${res.status}`);
        out(cmd, body, () => chalk.green('✓') + ` Detached ${chalk.bold(id)}`);
      } catch (e) {
        fail(e.message);
      }
    });

  /* ---------- skills ---------- */

  const skills = program
    .command('skills')
    .description('Install or inspect the bundled agent skill (Claude / Codex / Cursor).');

  // Resolve the skills/ directory shipped alongside this install. Works whether
  // you're running from a brew install, npm link, or a checked-out clone.
  const skillsDir = (() => {
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, '..', 'skills');
  })();

  skills
    .command('install', { isDefault: true })
    .description(
      'Install the Scope agent skill into Claude Code / Codex / Cursor using the local copy that ships with this install.'
    )
    .option(
      '-t, --tool <list>',
      'comma-separated subset: claude,codex,cursor (default: auto-detect)'
    )
    .option('--project <path>', 'project root for Cursor rule install (defaults to CWD)')
    .option('--dry-run', 'print what would be installed without writing', false)
    .allowUnknownOption()
    .action(async (opts, cmd) => {
      const script = join(skillsDir, 'install.sh');
      if (!existsSync(script)) {
        fail(
          `Bundled skills/install.sh not found at ${script}.\n` +
          `This shouldn't happen for a brew install. Try: brew reinstall briannadoubt/tap/scope`
        );
      }
      const args = [];
      if (opts.tool) args.push('--tool', opts.tool);
      if (opts.project) args.push('--project', opts.project);
      // Local-mode runner: copy files from the bundled skills dir instead of
      // curl-fetching them. We pass SCOPE_SKILLS_DIR so install.sh prefers local.
      const env = { ...process.env, SCOPE_SKILLS_DIR: skillsDir };
      if (opts.dryRun) {
        const data = {
          script,
          skills_dir: skillsDir,
          args,
          would_install: detectTargets(opts.tool, opts.project),
        };
        out(cmd, data, (d) => {
          let s = chalk.gray('# dry run — nothing written') + '\n';
          s += `script:     ${d.script}\n`;
          s += `skills dir: ${d.skills_dir}\n`;
          s += `would install:\n`;
          for (const [k, v] of Object.entries(d.would_install)) {
            s += `  ${k.padEnd(7)} → ${v}\n`;
          }
          return s;
        });
        return;
      }
      const r = spawnSync('bash', [script, ...args], { stdio: 'inherit', env });
      if (r.status !== 0) process.exit(r.status ?? 1);
    });

  skills
    .command('path')
    .description('Print the absolute path to the bundled skills directory.')
    .action((opts, cmd) => {
      out(cmd, { skills_dir: skillsDir }, (d) => d.skills_dir);
    });

  skills
    .command('list')
    .alias('ls')
    .description('Show the per-tool skill wrappers and where they install to.')
    .action((opts, cmd) => {
      const targets = detectTargets(undefined, process.cwd());
      const rows = [
        {
          tool: 'claude',
          source: join(skillsDir, 'claude/scope/SKILL.md'),
          target: targets.claude,
          detected: existsSync(targets.claude.split(' ')[0].replace(/^~/, process.env.HOME)) ||
                    existsSync((process.env.HOME || '') + '/.claude'),
        },
        {
          tool: 'codex',
          source: join(skillsDir, 'codex/AGENTS.md'),
          target: targets.codex,
          detected: existsSync((process.env.HOME || '') + '/.codex'),
        },
        {
          tool: 'cursor',
          source: join(skillsDir, 'cursor/scope.mdc'),
          target: targets.cursor,
          detected: existsSync(join(process.cwd(), '.cursor')),
        },
      ];
      out(cmd, rows, (rows) =>
        rows
          .map(
            (r) =>
              `${chalk.bold(r.tool.padEnd(7))} ${r.detected ? chalk.green('●') : chalk.gray('○')} ${chalk.gray(
                'src:'
              )} ${r.source}\n         ${chalk.gray('dst:')} ${r.target}`
          )
          .join('\n')
      );
    });

  /* ---------- ca ---------- */

  const ca = program
    .command('ca')
    .description('Manage the local certificate authority (~/.scope-hub/ca/).');

  ca
    .command('fingerprint')
    .description('Print the SHA-256 fingerprint of the local CA cert. Generates the CA on first run.')
    .action((opts, cmd) => {
      const c = loadOrCreateCa();
      out(
        cmd,
        {
          fingerprint: c.fingerprint,
          ca_cert: CA_CERT_PATH,
          ca_key: CA_KEY_PATH,
          created: c.created,
        },
        (d) => {
          let s = d.fingerprint;
          if (d.created) s = chalk.green('✓') + ` generated new CA\n` + s;
          return s;
        }
      );
    });

  ca
    .command('trust')
    .description(
      'Add ~/.scope-hub/ca/ca.crt to the macOS System keychain as a trusted ' +
      'root so browsers stop showing a cert warning. Requires sudo (the System ' +
      'keychain is admin-owned).'
    )
    .option('--user', 'install into the login keychain instead of the System keychain (no sudo, but only trusted for the current user)', false)
    .option('--dry-run', 'print the command without running it', false)
    .action((opts, cmd) => {
      const c = loadOrCreateCa();
      const keychain = opts.user
        ? join(homedir(), 'Library/Keychains/login.keychain-db')
        : '/Library/Keychains/System.keychain';
      // `security add-trusted-cert` is the supported macOS way to add a
      // trust anchor. -d marks it as a root, -r trustRoot says "trust for
      // SSL etc.", -k <keychain> picks which store to write to.
      const args = ['add-trusted-cert', '-d', '-r', 'trustRoot', '-k', keychain, CA_CERT_PATH];
      const argv = opts.user ? ['security', ...args] : ['sudo', 'security', ...args];
      if (opts.dryRun) {
        out(cmd, { command: argv.join(' '), ca_cert: CA_CERT_PATH, fingerprint: c.fingerprint, keychain }, (d) => d.command);
        return;
      }
      if (process.platform !== 'darwin') {
        fail(`scope ca trust currently supports macOS only (you're on ${process.platform}). On Linux, copy ${CA_CERT_PATH} into /usr/local/share/ca-certificates/ and run update-ca-certificates.`);
      }
      const r = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit' });
      if (r.status !== 0) fail(`security exited with status ${r.status}`);
      process.stdout.write(
        chalk.green('✓') + ` Added ${chalk.bold(CA_CERT_PATH)} as a trusted root in ${keychain}\n` +
        chalk.gray('  Browsers should stop showing the cert warning. Restart open browser tabs to pick up the change.\n')
      );
    });

  ca
    .command('untrust')
    .description('Remove the Scope CA from the macOS keychain (reverses `scope ca trust`).')
    .option('--user', 'remove from the login keychain instead of System', false)
    .option('--dry-run', 'print the command without running it', false)
    .action((opts, cmd) => {
      const keychain = opts.user
        ? join(homedir(), 'Library/Keychains/login.keychain-db')
        : '/Library/Keychains/System.keychain';
      const args = ['remove-trusted-cert', '-d', CA_CERT_PATH];
      const argv = opts.user ? ['security', ...args] : ['sudo', 'security', ...args];
      if (opts.dryRun) {
        out(cmd, { command: argv.join(' '), ca_cert: CA_CERT_PATH, keychain }, (d) => d.command);
        return;
      }
      if (process.platform !== 'darwin') {
        fail(`scope ca untrust currently supports macOS only.`);
      }
      const r = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit' });
      if (r.status !== 0) fail(`security exited with status ${r.status}`);
      process.stdout.write(chalk.green('✓') + ` Removed Scope CA trust from ${keychain}\n`);
    });

  ca
    .command('path')
    .description('Print the on-disk path to the CA directory.')
    .action((opts, cmd) => {
      out(cmd, { ca_dir: CA_DIR, ca_cert: CA_CERT_PATH, ca_key: CA_KEY_PATH }, (d) => d.ca_dir);
    });

  /* ---------- pair / devices ---------- */

  program
    .command('pair')
    .description(
      'Begin pairing a new native client. Prints a one-time 6-digit code; ' +
      'the device POSTs its CSR to /api/pair/complete with the code. Blocks ' +
      'until a device pairs or the code expires (default 5min).'
    )
    .option('-p, --port <port>', 'preferred hub port', String(DEFAULT_HUB_PORT))
    .action(async (opts, cmd) => {
      const preferredPort = Number.parseInt(opts.port, 10);
      const hub = await findRunningHub(preferredPort);
      if (!hub) fail(`No scope hub running on ports ${preferredPort}+. Start one with \`scope serve\`.`);
      try {
        const beginRes = await hubFetch(`${hub.url}/api/pair/begin`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!beginRes.ok) {
          const body = await beginRes.json();
          fail(body.error || `HTTP ${beginRes.status}`);
        }
        const { code, expires_at, ttl_ms } = await beginRes.json();

        const ca = loadOrCreateCa();
        // Banner — keep machine-readable bits in --json mode.
        if (cmd.optsWithGlobals().json) {
          out(cmd, { code, expires_at, ttl_ms, hub_url: hub.url, ca_fingerprint: ca.fingerprint });
        } else {
          process.stdout.write(
            '\n' +
            chalk.bold('Pairing code: ') + chalk.bold.green(code) + '\n' +
            chalk.gray(`  expires at:    ${expires_at} (${Math.round(ttl_ms / 1000)}s)`) + '\n' +
            chalk.gray(`  hub:           ${hub.url}`) + '\n' +
            chalk.gray(`  CA fingerprint:`) + '\n' +
            '    ' + chalk.gray(ca.fingerprint) + '\n' +
            '\nOn the new device, run the pairing flow against:\n' +
            chalk.bold(`  ${hub.url}/api/pair/complete`) + '\n' +
            chalk.gray('  body: { code, csr_pem, device_name }') + '\n' +
            '\nWaiting for device...\n'
          );
        }

        // Poll for completion by re-issuing the same code? No — once a device
        // pairs, devices.json gains a new record. We watch that file (lightly
        // — a 1s poll is plenty for an interactive flow with a 5min window).
        const startedAt = Date.now();
        const before = new Set(listDevices().map((d) => d.name + '@' + d.serial_hex));
        let paired = null;
        while (Date.now() - startedAt < ttl_ms) {
          await new Promise((r) => setTimeout(r, 1000));
          const after = listDevices();
          paired = after.find((d) => !before.has(d.name + '@' + d.serial_hex)) || null;
          if (paired) break;
        }
        if (!paired) fail('Pairing code expired before a device completed the flow.');

        if (cmd.optsWithGlobals().json) {
          out(cmd, { paired });
        } else {
          process.stdout.write(
            chalk.green('✓') + ` Paired ${chalk.bold(paired.name)}\n` +
            chalk.gray(`  serial:       ${paired.serial_hex}`) + '\n' +
            chalk.gray(`  fingerprint:  ${paired.fingerprint}`) + '\n' +
            chalk.gray(`  cert expires: ${paired.not_after}`) + '\n'
          );
        }
      } catch (e) {
        fail(e.message);
      }
    });

  const devices = program
    .command('devices')
    .description('Manage paired native client devices (~/.scope-hub/devices.json).');

  devices
    .command('list')
    .alias('ls')
    .description('List paired devices.')
    .action((opts, cmd) => {
      const rows = listDevices();
      out(cmd, rows, (rows) =>
        rows.length
          ? table(
              rows.map((d) => ({
                name: chalk.bold(d.name),
                serial: d.serial_hex.slice(0, 12) + '…',
                paired_at: d.paired_at,
                last_seen: d.last_seen,
                not_after: d.not_after,
              })),
              [
                { key: 'name', header: 'NAME', width: 24 },
                { key: 'serial', header: 'SERIAL' },
                { key: 'paired_at', header: 'PAIRED' },
                { key: 'last_seen', header: 'LAST SEEN' },
                { key: 'not_after', header: 'EXPIRES' },
              ]
            )
          : chalk.gray('(no devices paired — run `scope pair` on this machine and complete the flow on a client)')
      );
    });

  devices
    .command('revoke <name>')
    .description('Revoke a paired device. Removes it from devices.json and adds its cert serial to revoked.json (CRL). The running hub is signaled (SIGUSR1) to reload the CRL live.')
    .option('-y, --yes', 'skip confirmation', false)
    .action(async (name, opts, cmd) => {
      const d = findDeviceByName(name);
      if (!d) fail(`No device named ${name}`);
      if (!opts.yes) fail(`Refusing to revoke ${name} without --yes (this is destructive; rerun with -y).`);
      revokeSerial({ serialHex: d.serial_hex, name: d.name });
      removeDevice(name);
      // Best-effort: kick the running hub so the new CRL takes effect now.
      let signaled = false;
      try {
        const home = homedir();
        const hubFile = join(home, '.scope-hub', 'hub.json');
        if (existsSync(hubFile)) {
          const { pid } = JSON.parse(readFileSync(hubFile, 'utf8'));
          if (pid && pid !== process.pid) {
            try { process.kill(pid, 'SIGUSR1'); signaled = true; } catch {}
          }
        }
      } catch {}
      out(cmd, { revoked: { name: d.name, serial_hex: d.serial_hex }, signaled }, (data) =>
        chalk.green('✓') + ` Revoked ${chalk.bold(data.revoked.name)} (serial ${data.revoked.serial_hex.slice(0, 12)}…)` +
        (data.signaled ? chalk.gray(' — signaled hub to reload CRL') : chalk.gray(' — no running hub to signal'))
      );
    });

  devices
    .command('revoked')
    .description('List revoked device certificates (CRL).')
    .action((opts, cmd) => {
      const rows = listRevoked();
      out(cmd, rows, (rows) =>
        rows.length
          ? table(
              rows.map((r) => ({
                name: r.name || chalk.gray('(unknown)'),
                serial: r.serial_hex.slice(0, 16) + '…',
                revoked_at: r.revoked_at,
              })),
              [
                { key: 'name', header: 'NAME' },
                { key: 'serial', header: 'SERIAL' },
                { key: 'revoked_at', header: 'REVOKED' },
              ]
            )
          : chalk.gray('(none)')
      );
    });

  devices
    .command('unrevoke <serial>')
    .description('Remove a serial from the CRL (does NOT re-add to devices.json — the user has to re-pair).')
    .action((serial, opts, cmd) => {
      const ok = unrevokeSerial(serial);
      if (!ok) fail(`Serial ${serial} was not in the CRL`);
      out(cmd, { unrevoked: serial }, (d) => chalk.green('✓') + ` Unrevoked ${d.unrevoked}`);
    });

  devices
    .command('rename <name> <newName>')
    .description('Rename a paired device (display name only; cert is unchanged).')
    .action((name, newName, opts, cmd) => {
      try {
        const d = renameDevice(name, newName);
        if (!d) fail(`No device named ${name}`);
        out(cmd, d, (d) => chalk.green('✓') + ` Renamed → ${chalk.bold(d.name)}`);
      } catch (e) {
        fail(e.message);
      }
    });

  /* ---------- serve ---------- */

  program
    .command('serve')
    .description(
      'Run the local web UI. Auto-attaches to a running hub if one exists; otherwise starts one and idles with a watchdog so the hub survives sibling process death.'
    )
    .option('-p, --port <port>', 'preferred port (walks forward if taken)', String(DEFAULT_HUB_PORT))
    .option('--no-open', "don't open the browser automatically")
    .action(async (opts) => {
      const { scopeDir } = openOrDie();
      const preferredPort = Number.parseInt(opts.port, 10);

      const ensureOpts = {
        scopeDir,
        preferredPort,
        openBrowser: opts.open,
      };
      const res = await ensureHub(ensureOpts);
      startHubWatchdog(res, ensureOpts, {
        onEvent: (e) => {
          if (e.type === 'repair.done') {
            process.stderr.write(
              chalk.gray(
                `[watchdog] hub repaired → ${e.url}${e.promoted ? ' (promoted self)' : ''}\n`
              )
            );
          }
        },
      });

      if (res.weAreHub) {
        process.stdout.write(
          chalk.green('✓') + ` scope running at ${chalk.bold(res.url)}\n` +
          chalk.gray('  press Ctrl-C to stop') + '\n'
        );
      } else {
        process.stdout.write(
          chalk.green('✓') +
            ` Attached to existing hub at ${chalk.bold(res.url)} — registered this workspace.\n` +
          chalk.gray('  this process idles + watchdogs the hub; Ctrl-C to detach') + '\n'
        );
        idleUntilSignaled();
      }
    });

  return program;
}

export function run(argv) {
  const program = buildProgram();
  program.parseAsync(argv).catch((e) => {
    console.error(chalk.red(e.message || String(e)));
    process.exit(1);
  });
}
