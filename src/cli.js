import { Command, Option } from 'commander';
import chalk from 'chalk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
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
  ensureScopeGitignore,
  SCOPE_DIR_NAME,
  DB_FILE_NAME,
} from './db.js';
import { ensureEventLog } from './backfill.js';
import { syncFromLog } from './replay.js';
import { syncWithRemote } from './sync-client.js';
import { readRemoteConfig, writeRemoteConfig, resolveRemote, remoteConfigPath } from './remote-config.js';
import {
  getWorkspace,
  setWorkspace,
  listWorkspaces,
  updateWorkspace,
  rekeyWorkspace,
  applyBatch,
  createTicket,
  getTicket,
  listTickets,
  searchTickets,
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
import { loadOrCreateToken } from './auth.js';
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
  const db = openDb(dir);
  ensureScopeGitignore(dir); // existing workspaces get the ignore rules on first use
  ensureEventLog(db, dir);
  syncFromLog(db, dir); // rebuild the cache if the log is ahead (e.g. after a pull)
  return { db, scopeDir: dir };
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

/**
 * The acting model for agent-driven changes (SCP-128): the global `--model`
 * flag, else the SCOPE_MODEL env var, else null (a direct human edit). History
 * renders "<model> on behalf of <--by>" when set. `--by` stays the human.
 */
function actingModel(cmd) {
  return cmd.optsWithGlobals().model || process.env.SCOPE_MODEL || null;
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

function stdinPrompt(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => { rl.close(); resolve(ans); });
  });
}

/** Read all of stdin to a string (for `scope batch` piped JSON). */
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function maybeOfferCaTrust() {
  if (process.platform !== 'darwin') return;
  if (!process.stdin.isTTY) return;
  const loginKeychain = join(homedir(), 'Library/Keychains/login.keychain-db');
  const check = spawnSync('security', ['find-certificate', '-c', 'Scope Local CA', loginKeychain], { stdio: 'pipe' });
  if (check.status === 0) return; // already trusted
  process.stdout.write(
    '\n' + chalk.yellow('!') + ' Browsers will show a security warning — the Scope CA isn\'t trusted yet.\n' +
    chalk.gray('  This is a one-time step. Your login keychain password may be required.\n\n')
  );
  const ans = await stdinPrompt('  Trust the Scope CA in your login keychain? [Y/n] ');
  if (ans.trim().toLowerCase() === 'n') {
    process.stdout.write(chalk.gray('  Skipped. Run `scope ca trust --user` to add it later.\n\n'));
    return;
  }
  const r = spawnSync(
    'security',
    ['add-trusted-cert', '-r', 'trustRoot', '-k', loginKeychain, CA_CERT_PATH],
    { stdio: 'inherit' }
  );
  if (r.status === 0) {
    process.stdout.write(chalk.green('✓') + ' CA trusted — restart any open browser tabs to pick up the change.\n\n');
  } else {
    process.stdout.write(chalk.red('✗') + ' Could not add trust automatically. Run `scope ca trust --user` to try manually.\n\n');
  }
}

function parseLabels(s) {
  if (!s) return [];
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Split a comma-separated list of ticket ids (e.g. "SCP-1,SCP-2") into a clean array. */
function splitIds(s) {
  const list = String(s)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (!list.length) fail('No ticket id given.');
  return list;
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
    .option('--json', 'output JSON instead of pretty text', false)
    .option(
      '--model <model>',
      'acting model for agent-driven changes; history shows "<model> on behalf of <--by>" (or set SCOPE_MODEL)'
    );

  /* ---------- init ---------- */
  program
    .command('init')
    .description(`Create a ${SCOPE_DIR_NAME}/ directory in the current folder.`)
    .option('-f, --force', 'reinitialize if it already exists', false)
    .option('--key <key>', 'workspace key (2-10 uppercase letters/digits)')
    .option('--name <name>', 'workspace name')
    .option('--description <text>', 'short description')
    .action(async (opts, cmd) => {
      const dir = defaultScopeDir();
      const isJson = cmd.optsWithGlobals().json;
      if (existsSync(dir) && !opts.force) {
        console.error(chalk.yellow(`${SCOPE_DIR_NAME}/ already exists at ${dir}`));
        process.exit(0);
      }
      mkdirSync(dir, { recursive: true });
      ensureScopeGitignore(dir);
      const db = openDb(dir);

      // Prompt for key/name if interactive and not provided.
      let key = opts.key;
      let name = opts.name;
      let description = opts.description;
      if (!isJson && process.stdin.isTTY) {
        const current = getWorkspace(db);
        if (!opts.key) {
          const ans = (await stdinPrompt(
            `Workspace key [${current.key}]: `
          )).trim();
          if (ans) key = ans;
        }
        if (!opts.name) {
          const ans = (await stdinPrompt(
            `Workspace name [${current.name}]: `
          )).trim();
          if (ans) name = ans;
        }
        if (opts.description === undefined) {
          const ans = (await stdinPrompt('Description (optional): ')).trim();
          if (ans) description = ans;
        }
      }
      const updates = {};
      if (key) updates.key = key.toUpperCase();
      if (name) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (Object.keys(updates).length) {
        try { setWorkspace(db, updates); }
        catch (e) { db.close(); fail(e.message); }
      }
      const ws = getWorkspace(db);
      db.close();
      out(
        cmd,
        { scope_dir: dir, db: join(dir, DB_FILE_NAME), workspace: ws },
        (d) =>
          chalk.green('✓') +
          ` Initialized scope at ${chalk.bold(d.scope_dir)}\n` +
          chalk.gray(`  db:        ${d.db}\n`) +
          chalk.gray(`  key:       ${d.workspace.key}\n`) +
          chalk.gray(`  name:      ${d.workspace.name}\n`) +
          chalk.gray(`  Next: scope ticket create -t story "first ticket"`)
      );
    });

  /* ---------- project (deprecated aliases to workspace) ---------- */

  const project = program
    .command('project')
    .description('Deprecated alias for `scope workspace` (kept for back-compat).');

  function warnProjectDeprecated() {
    process.stderr.write(
      chalk.yellow(
        '! `scope project ...` is deprecated — use `scope workspace ...` instead.\n'
      )
    );
  }

  project
    .command('create [id] [key] [name...]')
    .description('Set the workspace key/name/description (deprecated).')
    .option('-d, --description <text>')
    .option('--overview <text>')
    .option('--overview-file <path>')
    .option('-e, --edit', 'edit overview in $EDITOR', false)
    .action((id, key, nameWords, opts, cmd) => {
      warnProjectDeprecated();
      const { db } = openOrDie();
      const fields = {};
      if (key) fields.key = key.toUpperCase();
      if (nameWords && nameWords.length) fields.name = nameWords.join(' ');
      if (opts.description !== undefined) fields.description = opts.description;
      let overview;
      if (opts.overview !== undefined) overview = opts.overview;
      if (opts.overviewFile) overview = readFileSync(opts.overviewFile, 'utf8');
      if (opts.edit) overview = editorPrompt(overview ?? '');
      if (overview !== undefined) fields.overview = overview;
      try {
        const updated = updateWorkspace(db, fields);
        out(cmd, updated, (p) =>
          chalk.green('✓') + ` Workspace is now ${chalk.bold(p.key)}: ${p.name}`
        );
      } catch (e) {
        fail(e.message);
      }
    });

  project
    .command('list')
    .alias('ls')
    .description('List workspaces (deprecated — always one).')
    .action((opts, cmd) => {
      warnProjectDeprecated();
      const { db } = openOrDie();
      const rows = listWorkspaces(db).map((w) => ({
        ...w,
        id: w.key.toLowerCase(),
      }));
      out(cmd, rows, (rows) =>
        table(
          rows.map((r) => ({
            key: chalk.bold(r.key),
            id: r.id,
            name: r.name,
            description: r.description ?? '',
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
    .command('show [idOrKey]')
    .description('Show the workspace (deprecated).')
    .action((idOrKey, opts, cmd) => {
      warnProjectDeprecated();
      const { db } = openOrDie();
      const ws = getWorkspace(db);
      if (
        idOrKey &&
        idOrKey.toUpperCase() !== ws.key &&
        idOrKey.toLowerCase() !== ws.key.toLowerCase()
      ) {
        fail(`Workspace key is ${ws.key}, got ${idOrKey}.`);
      }
      const tickets = listTickets(db);
      const epics = tickets.filter((t) => t.type === 'epic');
      out(
        cmd,
        { ...ws, id: ws.key.toLowerCase(), tickets, epics },
        (data) => projectDetail(data, { tickets: data.tickets, epics: data.epics })
      );
    });

  project
    .command('edit [idOrKey]')
    .description('Edit the workspace (deprecated).')
    .option('-n, --name <name>')
    .option('-d, --description <text>')
    .option('--overview <text>')
    .option('--overview-file <path>')
    .option('-e, --edit', 'edit overview in $EDITOR', false)
    .action((idOrKey, opts, cmd) => {
      warnProjectDeprecated();
      const { db } = openOrDie();
      const fields = {};
      if (opts.name) fields.name = opts.name;
      if (opts.description !== undefined) fields.description = opts.description;
      if (opts.overview !== undefined) fields.overview = opts.overview;
      if (opts.overviewFile) fields.overview = readFileSync(opts.overviewFile, 'utf8');
      if (opts.edit) fields.overview = editorPrompt(getWorkspace(db).overview ?? '');
      try {
        const updated = updateWorkspace(db, fields);
        out(cmd, updated, (u) => chalk.green('✓') + ` Updated ${u.key}`);
      } catch (e) {
        fail(e.message);
      }
    });

  project
    .command('delete [idOrKey]')
    .description('(Deprecated) Workspace cannot be deleted from the CLI.')
    .option('-y, --yes', 'skip confirmation', false)
    .action(() => {
      fail(
        "Workspace can't be deleted via the CLI. To remove it, run `rm -rf .scope/`."
      );
    });

  /* ---------- ticket ---------- */
  const ticket = program.command('ticket').description('Manage tickets (epics, stories, bugs).');

  ticket
    .command('create [title...]')
    .description('Create a ticket in the local workspace.')
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
    .option('--parent <ticketId>', 'parent epic (stories/bugs, or a sub-epic)')
    .option('--branch <name>', 'git branch')
    .option('--pr <url>', 'pull request URL')
    .option('--assignee <name>', 'assignee handle')
    .option('--labels <csv>', 'comma-separated labels')
    .option('--by <author>', 'attribute the creation in history')
    .option('--project <key>', '(deprecated) validated against workspace key')
    .action((titleWords, opts, cmd) => {
      const { db } = openOrDie();
      if (opts.project) {
        const ws = getWorkspace(db);
        if (opts.project.toUpperCase() !== ws.key) {
          fail(`--project ${opts.project} doesn't match workspace key ${ws.key}.`);
        }
        process.stderr.write(
          chalk.yellow('! --project is deprecated — tickets always go in the local workspace.\n')
        );
      }
      if (!titleWords || !titleWords.length) {
        fail('Ticket title is required.');
      }
      const description = readBodyFromOpts(opts) ?? '';
      try {
        const t = createTicket(db, {
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
          actor: opts.by,
          model: actingModel(cmd),
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
    .option('-p, --project <key>', '(deprecated) validated against workspace key')
    .addOption(new Option('-t, --type <type>').choices(['epic', 'story', 'bug']))
    .addOption(new Option('-s, --status <status>').choices(SCHEMA_STATUSES))
    .option('--parent <epicId>', 'filter by parent epic ("none" for top-level)')
    .option('--assignee <name>')
    .action((opts, cmd) => {
      const { db } = openOrDie();
      if (opts.project) {
        const ws = getWorkspace(db);
        if (opts.project.toUpperCase() !== ws.key) {
          fail(`--project ${opts.project} doesn't match workspace key ${ws.key}.`);
        }
        process.stderr.write(
          chalk.yellow('! -p/--project is deprecated.\n')
        );
      }
      const filter = {
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
    .command('search <query...>')
    .alias('find')
    .description('Full-text search tickets across all fields and comments.')
    .option('-n, --limit <count>', 'max results (1-200)', '50')
    .action((queryWords, opts, cmd) => {
      const { db } = openOrDie();
      const query = queryWords.join(' ');
      const tickets = searchTickets(db, query, { limit: Number(opts.limit) });
      out(cmd, tickets, (tickets) =>
        tickets.length
          ? table(tickets.map(ticketRow), [
              { key: 'id', header: 'ID' },
              { key: 'type', header: 'TYPE' },
              { key: 'title', header: 'TITLE', width: 50 },
              { key: 'status', header: 'STATUS' },
              { key: 'priority', header: 'PRI' },
              { key: 'parent', header: 'EPIC' },
            ])
          : chalk.dim(`No tickets match "${query}".`)
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
    .command('edit <ids>')
    .description('Edit fields on a ticket. Pass a comma-separated list of ids to edit several atomically.')
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
    .action((ids, opts, cmd) => {
      const { db } = openOrDie();
      const list = splitIds(ids);
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
        if (list.length === 1) {
          const t = getTicket(db, list[0]);
          if (!t) fail(`Ticket not found: ${list[0]}`);
          const updated = updateTicket(db, t.id, fields, opts.by, actingModel(cmd));
          out(cmd, updated, (u) => chalk.green('✓') + ` Updated ${chalk.bold(u.id)}`);
          return;
        }
        const r = applyBatch(db, list.map((id) => ({ op: 'update', id, fields })), { actor: opts.by, model: actingModel(cmd) });
        out(cmd, { updated: list }, () => chalk.green('✓') + ` Updated ${r.applied} tickets: ${list.join(', ')}`);
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
    .command('status <ids> <status>')
    .description(
      `Set a ticket's status. (${SCHEMA_STATUSES.join('|')}) ` +
        'Pass a comma-separated list of ids to move several atomically.'
    )
    .option('--by <author>')
    .action((ids, status, opts, cmd) => {
      const { db } = openOrDie();
      const list = splitIds(ids);
      try {
        if (list.length === 1) {
          const t = updateTicket(db, list[0], { status }, opts.by, actingModel(cmd));
          out(cmd, t, (t) => chalk.green('✓') + ` ${chalk.bold(t.id)} → ${colorStatus(t.status)}`);
          return;
        }
        const r = applyBatch(db, list.map((id) => ({ op: 'status', id, status })), { actor: opts.by, model: actingModel(cmd) });
        out(cmd, { updated: list, status }, () =>
          chalk.green('✓') + ` ${r.applied} tickets → ${colorStatus(status)}: ${list.join(', ')}`
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
      const updated = updateTicket(db, t.id, fields, opts.by, actingModel(cmd));
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
      const updated = updateTicket(db, t.id, fields, opts.by, actingModel(cmd));
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
    .description('List epics. [projectKey] is deprecated (validated against workspace key).')
    .action((projectKey, opts, cmd) => {
      const { db } = openOrDie();
      if (projectKey) {
        const ws = getWorkspace(db);
        if (projectKey.toUpperCase() !== ws.key) {
          fail(`Project key ${projectKey} doesn't match workspace key ${ws.key}.`);
        }
      }
      const epics = listTickets(db, { type: 'epic' });
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
        const c = addComment(db, id, body.join(' '), opts.by, actingModel(cmd));
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

  /* ---------- batch ---------- */

  program
    .command('batch')
    .description(
      'Apply many operations atomically (all succeed or none). Reads a JSON ' +
        'array of ops from --file or stdin. This is the supported way to do ' +
        'bulk/compound edits — never edit scope.db directly.'
    )
    .option('-f, --file <path>', 'read ops JSON from a file (default: stdin)')
    .option('--by <author>', 'default actor for ops that omit "by"')
    .action(async (opts, cmd) => {
      const { db } = openOrDie();
      let raw;
      if (opts.file) {
        try { raw = readFileSync(opts.file, 'utf8'); }
        catch (e) { fail(`Could not read --file: ${e.message}`); }
      } else {
        raw = await readStdin();
        if (!raw.trim()) fail('No ops given. Pass --file <path> or pipe a JSON array on stdin.');
      }
      let ops;
      try { ops = JSON.parse(raw); }
      catch (e) { fail(`Ops must be valid JSON: ${e.message}`); }
      if (!Array.isArray(ops)) fail('Ops JSON must be an array of {op, ...} objects.');
      try {
        const result = applyBatch(db, ops, { actor: opts.by, model: actingModel(cmd) });
        out(cmd, result, (r) =>
          chalk.green('✓') + ` Applied ${r.applied} ops atomically` +
          (Object.keys(r.refs).length ? `\n${chalk.gray('  refs: ' + JSON.stringify(r.refs))}` : '')
        );
      } catch (e) {
        fail(`Batch failed (nothing was applied): ${e.message}`);
      }
    });

  /* ---------- sync (SCP-136) ---------- */

  program
    .command('sync')
    .description('Sync this workspace with a remote hub: push local events, pull the remote back.')
    .option('--remote <url>', 'remote hub base URL, e.g. https://hub.scope.dev (falls back to $SCOPE_REMOTE, then .scope/remote.json)')
    .option('--remote-workspace <id>', 'the remote workspace id to sync with (wins over --project)')
    .option('--project <tenantId>', 'the remote project (tenant) to sync with (falls back to $SCOPE_PROJECT, then .scope/remote.json)')
    .option('--token <token>', 'credential for the remote hub: a per-user API key (sk_…) or shared token. Falls back to $SCOPE_API_KEY then $SCOPE_TOKEN.')
    .option('--model <name>', 'acting model for attribution (X-Scope-Model). Falls back to $SCOPE_MODEL.')
    .action(async (opts, cmd) => {
      const { db, scopeDir } = openOrDie();
      // SCP-193: flags > env > committed .scope/remote.json. The legacy
      // --remote-workspace selector wins over --project; on a hosted hub the
      // project (tenant) id IS the remote workspace id, so either spelling
      // lands on the same board.
      let target;
      try {
        target = resolveRemote(scopeDir, { remote: opts.remote, project: opts.remoteWorkspace || opts.project });
      } catch (e) {
        fail(e.message);
      }
      if (!target.url) {
        fail('remote hub URL is required (--remote). Configure one with `scope remote set --url <url>`.');
      }
      if (!target.project) {
        fail('remote workspace id is required (--remote-workspace). Configure one with `scope remote set --project <tenantId>`.');
      }
      try {
        const r = await syncWithRemote(db, scopeDir, {
          remote: target.url,
          remoteWorkspace: target.project,
          token: opts.token || process.env.SCOPE_API_KEY || process.env.SCOPE_TOKEN || '',
          model: opts.model || process.env.SCOPE_MODEL || '',
        });
        out(cmd, r, (r) =>
          chalk.green('✓') +
          ` pushed ${r.pushed} (${r.duplicates} dup), pulled ${r.pulled}` +
          (r.renumbered.length ? `, renumbered ${r.renumbered.length}` : '')
        );
      } catch (e) {
        fail(e.message);
      }
    });

  /* ---------- apikey: per-user API keys (SCP-173) ---------- */

  const key = program
    .command('apikey')
    .description('Create, list, and revoke per-user API keys on a remote hosted hub.');

  // Resolve the credential used to call the hub's /auth/keys endpoints: an
  // existing API key or session token. The very first key is minted in the web
  // UI after GitHub sign-in; thereafter a key can mint more.
  const authCred = (opts) => opts.token || process.env.SCOPE_API_KEY || process.env.SCOPE_TOKEN || '';
  const keysUrl = (remote, path = '') => `${remote.replace(/\/$/, '')}/auth/keys${path}`;
  const authHeaders = (cred) => ({
    'Content-Type': 'application/json',
    ...(cred ? { Authorization: `Bearer ${cred}` } : {}),
  });

  key
    .command('create <name>')
    .description('Mint a named API key on the remote hub. The secret is shown ONCE.')
    .requiredOption('--remote <url>', 'remote hub base URL, e.g. https://scope-hub.fly.dev')
    .option('--token <token>', 'existing API key / session to authenticate this call ($SCOPE_API_KEY / $SCOPE_TOKEN)')
    .action(async (name, opts, cmd) => {
      try {
        const res = await fetch(keysUrl(opts.remote), {
          method: 'POST', headers: authHeaders(authCred(opts)), body: JSON.stringify({ name }),
        });
        if (!res.ok) fail(`create failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
        const body = await res.json();
        out(cmd, body, (b) =>
          chalk.green('✓') + ` created key ${chalk.bold(b.id)} (${b.name})\n` +
          chalk.yellow('  save this now — it is shown only once:') + '\n  ' + chalk.bold(b.key));
      } catch (e) { fail(e.message); }
    });

  key
    .command('list')
    .description('List your API keys on the remote hub (never shows secrets).')
    .requiredOption('--remote <url>', 'remote hub base URL')
    .option('--token <token>', 'existing API key / session ($SCOPE_API_KEY / $SCOPE_TOKEN)')
    .action(async (opts, cmd) => {
      try {
        const res = await fetch(keysUrl(opts.remote), { headers: authHeaders(authCred(opts)) });
        if (!res.ok) fail(`list failed: HTTP ${res.status}`);
        const rows = await res.json();
        out(cmd, rows, (rs) => rs.length
          ? rs.map((k) => `  ${k.id}  ${k.name}${k.revoked_at ? chalk.red(' (revoked)') : ''}`).join('\n')
          : '  (no keys)');
      } catch (e) { fail(e.message); }
    });

  key
    .command('revoke <id>')
    .description('Revoke an API key by id on the remote hub.')
    .requiredOption('--remote <url>', 'remote hub base URL')
    .option('--token <token>', 'existing API key / session ($SCOPE_API_KEY / $SCOPE_TOKEN)')
    .action(async (id, opts, cmd) => {
      try {
        const res = await fetch(keysUrl(opts.remote, `/${encodeURIComponent(id)}`), {
          method: 'DELETE', headers: authHeaders(authCred(opts)),
        });
        if (!res.ok) fail(`revoke failed: HTTP ${res.status}`);
        out(cmd, { ok: true, id }, () => chalk.green('✓') + ` revoked ${id}`);
      } catch (e) { fail(e.message); }
    });

  /* ---------- remote: committed hub target (SCP-193) ---------- */

  const remote = program
    .command('remote')
    .description(
      'Configure which hosted hub + project this workspace syncs with (.scope/remote.json — committed with the repo, never holds credentials).'
    );

  remote
    .command('set')
    .description('Write/merge .scope/remote.json with the hub URL and/or target project (tenant) id.')
    .option('--url <url>', 'remote hub base URL, e.g. https://scope-hub.fly.dev')
    .option('--project <tenantId>', 'target project (tenant) id, e.g. tnt_…')
    .action((opts, cmd) => {
      const { scopeDir } = openOrDie();
      if (!opts.url && !opts.project) fail('Nothing to set — pass --url and/or --project.');
      try {
        const existing = readRemoteConfig(scopeDir) || {};
        const cfg = writeRemoteConfig(scopeDir, {
          url: opts.url || existing.url,
          project: opts.project || existing.project,
        });
        out(cmd, { ...cfg, path: remoteConfigPath(scopeDir) }, (c) =>
          chalk.green('✓') + ` Remote configured — ${c.path}\n` +
          chalk.gray(`  url:      ${c.url || '(none)'}\n`) +
          chalk.gray(`  project:  ${c.project || '(none)'}\n`) +
          chalk.gray('  Tokens never live here — pass --token or set $SCOPE_API_KEY.')
        );
      } catch (e) { fail(e.message); }
    });

  remote
    .command('show')
    .description('Show the resolved remote target and where each value comes from (flag/env/file/none).')
    .action((opts, cmd) => {
      const { scopeDir } = openOrDie();
      try {
        const r = resolveRemote(scopeDir);
        out(cmd, r, (r) =>
          `  url:      ${r.url ? chalk.bold(r.url) : chalk.gray('(none)')}  ${chalk.gray(`[${r.source.url}]`)}\n` +
          `  project:  ${r.project ? chalk.bold(r.project) : chalk.gray('(none)')}  ${chalk.gray(`[${r.source.project}]`)}`
        );
      } catch (e) { fail(e.message); }
    });

  /* ---------- projects: hosted boards (SCP-193) ---------- */

  const projects = program
    .command('projects')
    .description('List and create projects (boards) on a remote hosted hub.');

  const projectsUrl = (remoteUrl) => `${remoteUrl.replace(/\/$/, '')}/api/projects`;
  // Resolve the hub URL like `scope sync` does (flag > $SCOPE_REMOTE >
  // .scope/remote.json) — but without requiring a workspace, so these work
  // outside a repo when --remote is explicit.
  const resolveHubOrDie = (opts) => {
    let r;
    try {
      r = resolveRemote(findScopeDir(), { remote: opts.remote });
    } catch (e) {
      fail(e.message);
    }
    if (!r.url) fail('No remote configured. Pass --remote <url> or run `scope remote set --url <url>`.');
    return r;
  };

  projects
    .command('list')
    .description('List the projects (boards) you belong to on the remote hub, with your role on each.')
    .option('--remote <url>', 'remote hub base URL (falls back to $SCOPE_REMOTE, then .scope/remote.json)')
    .option('--token <token>', 'API key / session to authenticate ($SCOPE_API_KEY / $SCOPE_TOKEN)')
    .action(async (opts, cmd) => {
      const r = resolveHubOrDie(opts);
      try {
        const res = await fetch(projectsUrl(r.url), { headers: authHeaders(authCred(opts)) });
        if (res.status === 401) fail('list failed: HTTP 401 — pass --token or set $SCOPE_API_KEY.');
        if (!res.ok) fail(`list failed: HTTP ${res.status}`);
        const rows = await res.json();
        out(cmd, rows, (rs) => rs.length
          ? rs.map((p) => `  ${p.tenant_id}  ${p.role}  ${p.name}`).join('\n')
          : '  (no projects)');
      } catch (e) { fail(e.message); }
    });

  projects
    .command('create <name>')
    .description('Create a project (board) on the remote hub — you become its owner.')
    .option('--remote <url>', 'remote hub base URL (falls back to $SCOPE_REMOTE, then .scope/remote.json)')
    .option('--token <token>', 'API key / session to authenticate ($SCOPE_API_KEY / $SCOPE_TOKEN)')
    .action(async (name, opts, cmd) => {
      const r = resolveHubOrDie(opts);
      try {
        const res = await fetch(projectsUrl(r.url), {
          method: 'POST', headers: authHeaders(authCred(opts)), body: JSON.stringify({ name }),
        });
        if (res.status === 401) fail('create failed: HTTP 401 — pass --token or set $SCOPE_API_KEY.');
        if (!res.ok) fail(`create failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
        const body = await res.json();
        // SCP-193: non-interactive by convention — when the committed config
        // has no project target yet, print the command instead of prompting.
        const cfg = readRemoteConfig(findScopeDir());
        const hint = cfg && !cfg.project
          ? '\n' + chalk.gray(`  target it for sync: scope remote set --project ${body.tenantId}`)
          : '';
        out(cmd, body, (b) =>
          chalk.green('✓') + ` created project ${chalk.bold(b.name)} (${b.key})\n` +
          chalk.gray(`  tenant: ${b.tenantId}`) + hint);
      } catch (e) { fail(e.message); }
    });

  /* ---------- alias: map local actor names to your account (SCP-184) ---------- */

  const alias = program
    .command('alias')
    .description('Claim local event-actor names (e.g. "bri") on a remote project so your local history syncs under your account.');

  // Resolve BOTH the hub url and the target project (alias ops are per-board).
  const resolveProjectOrDie = (opts) => {
    const r = resolveHubOrDie(opts);
    const project = opts.project || r.project;
    if (!project) fail('No project selected. Pass --project <tenantId> or run `scope remote set --project <tenantId>`.');
    return { url: r.url, project };
  };
  const aliasesUrl = (url, project, name = '') =>
    `${url.replace(/\/$/, '')}/api/projects/${encodeURIComponent(project)}/aliases${name ? `/${encodeURIComponent(name)}` : ''}`;

  alias
    .command('claim <name>')
    .description('Claim an actor name as yours on the project (first-come; owners can --force a reassignment).')
    .option('--remote <url>', 'remote hub base URL ($SCOPE_REMOTE, .scope/remote.json)')
    .option('--project <tenantId>', 'target project ($SCOPE_PROJECT, .scope/remote.json)')
    .option('--token <token>', 'API key / session ($SCOPE_API_KEY / $SCOPE_TOKEN)')
    .option('--force', 'owner only: reassign the alias even if someone else holds it', false)
    .action(async (name, opts, cmd) => {
      const { url, project } = resolveProjectOrDie(opts);
      try {
        const res = await fetch(aliasesUrl(url, project), {
          method: 'POST', headers: authHeaders(authCred(opts)),
          body: JSON.stringify({ alias: name, force: opts.force || undefined }),
        });
        if (res.status === 409) fail(`"${name}" is already claimed on this project (an owner can reassign with --force).`);
        if (!res.ok) fail(`claim failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
        out(cmd, await res.json(), (b) =>
          chalk.green('✓') + ` "${b.alias}" now syncs as your account on this project`);
      } catch (e) { fail(e.message); }
    });

  alias
    .command('list')
    .description('Show the actor-name → account map on the project.')
    .option('--remote <url>', 'remote hub base URL')
    .option('--project <tenantId>', 'target project')
    .option('--token <token>', 'API key / session')
    .action(async (opts, cmd) => {
      const { url, project } = resolveProjectOrDie(opts);
      try {
        const res = await fetch(aliasesUrl(url, project), { headers: authHeaders(authCred(opts)) });
        if (!res.ok) fail(`list failed: HTTP ${res.status}`);
        const rows = await res.json();
        out(cmd, rows, (rs) => rs.length
          ? rs.map((a) => `  ${a.alias}  →  ${a.account_id}`).join('\n')
          : '  (no aliases claimed)');
      } catch (e) { fail(e.message); }
    });

  alias
    .command('remove <name>')
    .description('Remove an alias mapping (yours, or any as owner).')
    .option('--remote <url>', 'remote hub base URL')
    .option('--project <tenantId>', 'target project')
    .option('--token <token>', 'API key / session')
    .action(async (name, opts, cmd) => {
      const { url, project } = resolveProjectOrDie(opts);
      try {
        const res = await fetch(aliasesUrl(url, project, name), {
          method: 'DELETE', headers: authHeaders(authCred(opts)),
        });
        if (!res.ok) fail(`remove failed: HTTP ${res.status}`);
        out(cmd, { ok: true, alias: name }, () => chalk.green('✓') + ` removed "${name}"`);
      } catch (e) { fail(e.message); }
    });

  /* ---------- board / ui ---------- */

  program
    .command('board')
    .description('Render a kanban board in the terminal.')
    .option('-p, --project <key>', '(deprecated) validated against workspace key')
    .option('--epic <id>', 'only tickets in a given epic')
    .action((opts, cmd) => {
      const { db } = openOrDie();
      if (opts.project) {
        const ws = getWorkspace(db);
        if (opts.project.toUpperCase() !== ws.key) {
          fail(`--project ${opts.project} doesn't match workspace key ${ws.key}.`);
        }
        process.stderr.write(
          chalk.yellow('! -p/--project is deprecated.\n')
        );
      }
      const tickets = listTickets(db, { parentId: opts.epic });
      out(cmd, tickets, boardView);
    });

  /* ---------- workspace (hub registration) ---------- */

  const workspace = program
    .command('workspace')
    .alias('ws')
    .description(
      'Show/edit the local workspace, or attach/detach/list workspaces on the running hub.'
    );

  workspace
    .command('show')
    .description('Show the local workspace (key, name, description, overview).')
    .action((opts, cmd) => {
      const { db } = openOrDie();
      const ws = getWorkspace(db);
      const tickets = listTickets(db);
      const epics = tickets.filter((t) => t.type === 'epic');
      out(cmd, { ...ws, tickets, epics }, (data) =>
        projectDetail(
          { ...data, id: data.key.toLowerCase() },
          { tickets: data.tickets, epics: data.epics }
        )
      );
    });

  workspace
    .command('set')
    .description('Set fields on the local workspace.')
    .option('--key <key>', 'workspace key (2-10 uppercase letters/digits)')
    .option('-n, --name <name>')
    .option('-d, --description <text>')
    .option('--overview <text>')
    .option('--overview-file <path>')
    .option('-e, --edit', 'edit overview in $EDITOR', false)
    .option('--by <author>', 'attribute the change in history')
    .action((opts, cmd) => {
      const { db } = openOrDie();
      const fields = {};
      if (opts.key) fields.key = opts.key.toUpperCase();
      if (opts.name) fields.name = opts.name;
      if (opts.description !== undefined) fields.description = opts.description;
      if (opts.overview !== undefined) fields.overview = opts.overview;
      if (opts.overviewFile) fields.overview = readFileSync(opts.overviewFile, 'utf8');
      if (opts.edit) fields.overview = editorPrompt(getWorkspace(db).overview ?? '');
      try {
        const updated = updateWorkspace(db, fields, opts.by, actingModel(cmd));
        out(cmd, updated, (u) => chalk.green('✓') + ` Updated ${chalk.bold(u.key)}`);
      } catch (e) {
        fail(e.message);
      }
    });

  workspace
    .command('rekey <newKey>')
    .description('Change the workspace key AND reprefix every existing ticket (KEY-N → NEWKEY-N).')
    .option('--by <author>')
    .action((newKey, opts, cmd) => {
      const { db } = openOrDie();
      try {
        const r = rekeyWorkspace(db, newKey.toUpperCase(), { actor: opts.by, model: actingModel(cmd) });
        out(cmd, r, (r) =>
          chalk.green('✓') + ` Rekeyed to ${chalk.bold(r.key)} — reprefixed ${r.reprefixed} tickets`
        );
      } catch (e) {
        fail(e.message);
      }
    });

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
      // trust anchor. -r trustRoot says "trust for SSL etc.", -k picks the
      // keychain to store the cert in. Without -d, trust is applied at the
      // user domain (no sudo); with -d it targets the admin domain (requires
      // sudo + System keychain).
      const args = opts.user
        ? ['add-trusted-cert', '-r', 'trustRoot', '-k', keychain, CA_CERT_PATH]
        : ['add-trusted-cert', '-d', '-r', 'trustRoot', '-k', keychain, CA_CERT_PATH];
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

  /* ---------- auth token ---------- */

  program
    .command('auth')
    .description('Show the bearer token used to authenticate API requests.')
    .action(() => {
      const tok = loadOrCreateToken();
      process.stdout.write(tok + '\n');
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
    .option('--gossip', 'gossip events directly with paired LAN peers (no central host, SCP-114)')
    .option('--gossip-peer <url...>', 'explicit peer base URL(s); default = mDNS discovery')
    .option('--gossip-cert <pem>', 'client cert for peer mTLS ($SCOPE_GOSSIP_CERT)')
    .option('--gossip-key <pem>', 'client key for peer mTLS ($SCOPE_GOSSIP_KEY)')
    .option('--gossip-ca <pem>', "peer hub's CA cert ($SCOPE_GOSSIP_CA)")
    .action(async (opts) => {
      const { db, scopeDir } = openOrDie();
      const preferredPort = Number.parseInt(opts.port, 10);

      const ensureOpts = {
        scopeDir,
        preferredPort,
        openBrowser: false, // we open the browser ourselves after the CA trust prompt
      };
      const res = await ensureHub(ensureOpts);

      // LAN peer gossip (SCP-114): push/pull the event log directly with
      // paired peer hubs over mTLS — realtime on a LAN with no central host.
      // The client credential is the device cert a `scope pair` flow against
      // the peer's CA produced.
      let gossip = null, disco = null;
      if (opts.gossip) {
        const certPath = opts.gossipCert || process.env.SCOPE_GOSSIP_CERT;
        const keyPath = opts.gossipKey || process.env.SCOPE_GOSSIP_KEY;
        const caPath = opts.gossipCa || process.env.SCOPE_GOSSIP_CA;
        if (!certPath || !keyPath || !caPath) {
          fail(
            '--gossip needs a peer-signed client credential: --gossip-cert/--gossip-key/--gossip-ca ' +
            '(or SCOPE_GOSSIP_CERT/KEY/CA). Pair this machine against the peer hub first (`scope pair`).'
          );
        }
        const { startGossip, discoverLanPeers } = await import('./gossip.js');
        const clientCert = {
          certPem: readFileSync(certPath, 'utf8'),
          keyPem: readFileSync(keyPath, 'utf8'),
          caPem: readFileSync(caPath, 'utf8'),
        };
        let getPeers;
        if (opts.gossipPeer?.length) {
          getPeers = () => opts.gossipPeer.map((url) => ({ url }));
        } else {
          disco = discoverLanPeers({ excludeUrls: [res.url] });
          getPeers = disco.getPeers;
        }
        gossip = startGossip({ scopeDir, db, getPeers, clientCert });
        process.stdout.write(chalk.green('✓') + ' gossip on — syncing with paired LAN peers\n');
        const stopGossip = async () => { try { await gossip.stop(); } catch {} try { disco?.stop(); } catch {} };
        process.on('SIGINT', stopGossip);
        process.on('SIGTERM', stopGossip);
      }
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
        await maybeOfferCaTrust();
        if (opts.open) {
          try { (await import('open')).default(`http://localhost:${res.port}`); } catch {}
        }
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

  /* ---------- preview ---------- */

  program
    .command('preview')
    .description(
      'Run a per-pane proxy to the scope hub. Designed for Claude Code\'s ' +
      '`.claude/launch.json` — each preview pane runs `scope preview --port <unique>` ' +
      'so `preview_start` (which keys its registry by port) doesn\'t make ' +
      'panes stop each other. All proxies forward to the single shared hub.'
    )
    .requiredOption('-p, --port <port>', 'unique port for this preview proxy (must differ from the hub port and from any other project\'s preview port)')
    .option('--hub-port <port>', 'hub port to forward to', String(DEFAULT_HUB_PORT))
    .action(async (opts) => {
      const { scopeDir } = openOrDie();
      const port = Number.parseInt(opts.port, 10);
      const hubPort = Number.parseInt(opts.hubPort, 10);
      if (!Number.isFinite(port)) fail(`--port must be a number, got ${opts.port}`);
      if (port === hubPort) {
        fail(
          `--port ${port} collides with the hub port. Pick a unique port per project ` +
          `(e.g. 4322, 4323, ...) — the hub stays on ${hubPort}.`
        );
      }

      const ensureOpts = {
        scopeDir,
        preferredPort: hubPort,
        openBrowser: false,
      };
      const res = await ensureHub(ensureOpts);
      startHubWatchdog(res, ensureOpts);

      const { startPreviewProxy } = await import('./preview.js');
      try {
        await startPreviewProxy({
          port,
          getUpstreamPort: () => res.port,
        });
      } catch (e) {
        if (e?.code === 'EADDRINUSE') {
          fail(
            `Port ${port} is already in use. Each project's preview proxy needs its own port — ` +
            `pick another number in your .claude/launch.json.`
          );
        }
        throw e;
      }

      process.stdout.write(
        chalk.green('✓') +
          ` scope preview proxy on ${chalk.bold(`http://localhost:${port}`)} → ${chalk.bold(res.url)}\n` +
        chalk.gray('  Ctrl-C to detach (the hub keeps running)') + '\n'
      );
      idleUntilSignaled();
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
