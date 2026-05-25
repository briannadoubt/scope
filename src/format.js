import chalk from 'chalk';

const STATUS_COLORS = {
  backlog: chalk.gray,
  todo: chalk.white,
  in_progress: chalk.yellow,
  in_review: chalk.cyan,
  done: chalk.green,
  cancelled: chalk.strikethrough.gray,
};

const TYPE_BADGES = {
  epic: chalk.magenta.bold('EPIC '),
  story: chalk.blue.bold('STORY'),
  bug: chalk.red.bold('BUG  '),
};

const PRIORITY_COLORS = {
  low: chalk.gray,
  medium: chalk.white,
  high: chalk.yellow,
  urgent: chalk.red.bold,
};

export function colorStatus(s) {
  const fn = STATUS_COLORS[s] ?? ((x) => x);
  return fn(s);
}

export function typeBadge(t) {
  return TYPE_BADGES[t] ?? t;
}

export function colorPriority(p) {
  const fn = PRIORITY_COLORS[p] ?? ((x) => x);
  return fn(p);
}

/**
 * Renders an array of objects as a table.
 * columns: [{ key, header, width?, align? }]
 */
export function table(rows, columns) {
  if (!rows.length) return chalk.gray('(none)');
  const widths = columns.map((c) => {
    const cellMax = Math.max(
      stripAnsi(c.header).length,
      ...rows.map((r) => stripAnsi(String(r[c.key] ?? '')).length)
    );
    return c.width ? Math.min(c.width, Math.max(cellMax, stripAnsi(c.header).length)) : cellMax;
  });

  const sep = '  ';
  const head = columns
    .map((c, i) => pad(chalk.bold(c.header), widths[i], c.align))
    .join(sep);
  const divider = columns
    .map((_, i) => chalk.gray('─'.repeat(widths[i])))
    .join(sep);
  const body = rows
    .map((r) =>
      columns
        .map((c, i) => pad(truncate(String(r[c.key] ?? ''), widths[i]), widths[i], c.align))
        .join(sep)
    )
    .join('\n');
  return [head, divider, body].join('\n');
}

function pad(s, w, align = 'left') {
  const visible = stripAnsi(s).length;
  if (visible >= w) return s;
  const padding = ' '.repeat(w - visible);
  return align === 'right' ? padding + s : s + padding;
}

function truncate(s, w) {
  const visible = stripAnsi(s).length;
  if (visible <= w) return s;
  return s.slice(0, Math.max(0, w - 1)) + '…';
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\[[0-9;]*m/g, '');
}

export function ticketRow(t) {
  return {
    id: chalk.bold(t.id),
    type: typeBadge(t.type),
    title: t.title,
    status: colorStatus(t.status),
    priority: colorPriority(t.priority),
    parent: t.parent_id ?? '',
    branch: t.branch ?? '',
    pr: t.pr_url ? short(t.pr_url) : '',
  };
}

function short(url) {
  return url.replace(/^https?:\/\//, '').replace(/^github\.com\//, '');
}

export function ticketDetail(t, { children, relations, comments, progress } = {}) {
  const lines = [];
  lines.push(
    `${chalk.bold(t.id)}  ${typeBadge(t.type)}  ${chalk.bold(t.title)}`
  );
  lines.push(
    `${chalk.gray('status:')}   ${colorStatus(t.status)}   ${chalk.gray('priority:')} ${colorPriority(t.priority)}${
      t.assignee ? `   ${chalk.gray('assignee:')} ${t.assignee}` : ''
    }`
  );
  if (t.parent_id) lines.push(`${chalk.gray('epic:')}     ${t.parent_id}`);
  if (t.branch) lines.push(`${chalk.gray('branch:')}   ${t.branch}`);
  if (t.pr_url) lines.push(`${chalk.gray('pr:')}       ${t.pr_url}`);
  if (t.labels?.length) lines.push(`${chalk.gray('labels:')}   ${t.labels.join(', ')}`);
  lines.push(
    `${chalk.gray('created:')}  ${t.created_at}   ${chalk.gray('updated:')} ${t.updated_at}`
  );

  if (t.description?.trim()) {
    lines.push('');
    lines.push(chalk.bold.underline('Description'));
    lines.push(t.description);
  }

  if (progress) {
    lines.push('');
    lines.push(chalk.bold.underline('Progress'));
    lines.push(
      `${progress.done}/${progress.total} done  (${progress.percent}%)  ` +
        Object.entries(progress.counts)
          .filter(([, n]) => n > 0)
          .map(([s, n]) => `${colorStatus(s)}:${n}`)
          .join('  ')
    );
  }

  if (children?.length) {
    lines.push('');
    lines.push(chalk.bold.underline('Children'));
    lines.push(
      table(children.map(ticketRow), [
        { key: 'id', header: 'ID' },
        { key: 'type', header: 'TYPE' },
        { key: 'title', header: 'TITLE', width: 50 },
        { key: 'status', header: 'STATUS' },
        { key: 'priority', header: 'PRI' },
      ])
    );
  }

  if (relations?.length) {
    lines.push('');
    lines.push(chalk.bold.underline('Relations'));
    for (const r of relations) {
      lines.push(
        `  ${chalk.gray(r.type.padEnd(12))} ${chalk.bold(r.to_ticket_id)}  ${
          r.title ?? ''
        }  ${r.status ? colorStatus(r.status) : ''}`
      );
    }
  }

  if (comments?.length) {
    lines.push('');
    lines.push(chalk.bold.underline('Comments'));
    for (const c of comments) {
      lines.push(
        `  ${chalk.gray(c.created_at)} ${chalk.cyan(c.author ?? 'anon')}: ${c.body}`
      );
    }
  }
  return lines.join('\n');
}

export function projectDetail(p, { tickets, epics } = {}) {
  const lines = [];
  lines.push(`${chalk.bold(p.key)}  ${chalk.bold(p.name)}  ${chalk.gray(`(${p.id})`)}`);
  if (p.description) lines.push(p.description);
  lines.push(`${chalk.gray('created:')} ${p.created_at}`);
  if (p.overview?.trim()) {
    lines.push('');
    lines.push(chalk.bold.underline('Overview'));
    lines.push(p.overview);
  }
  if (epics?.length) {
    lines.push('');
    lines.push(chalk.bold.underline('Epics'));
    lines.push(
      table(epics.map(ticketRow), [
        { key: 'id', header: 'ID' },
        { key: 'title', header: 'TITLE', width: 50 },
        { key: 'status', header: 'STATUS' },
      ])
    );
  }
  if (tickets?.length) {
    lines.push('');
    lines.push(chalk.bold.underline('Tickets'));
    lines.push(
      table(tickets.map(ticketRow), [
        { key: 'id', header: 'ID' },
        { key: 'type', header: 'TYPE' },
        { key: 'title', header: 'TITLE', width: 50 },
        { key: 'status', header: 'STATUS' },
        { key: 'pr', header: 'PR' },
      ])
    );
  }
  return lines.join('\n');
}

export function boardView(tickets) {
  const cols = ['backlog', 'todo', 'in_progress', 'in_review', 'done'];
  const buckets = Object.fromEntries(cols.map((c) => [c, []]));
  for (const t of tickets) {
    if (buckets[t.status]) buckets[t.status].push(t);
  }
  const colWidth = 28;
  const headers = cols.map((c) =>
    pad(chalk.bold(colorStatus(c)) + ` (${buckets[c].length})`, colWidth)
  );
  const maxLen = Math.max(...cols.map((c) => buckets[c].length));
  const rows = [];
  for (let i = 0; i < maxLen; i++) {
    rows.push(
      cols
        .map((c) => {
          const t = buckets[c][i];
          if (!t) return pad('', colWidth);
          const line = `${chalk.bold(t.id)} ${typeBadge(t.type)} ${truncate(
            t.title,
            colWidth - 14
          )}`;
          return pad(line, colWidth);
        })
        .join(' │ ')
    );
  }
  return [headers.join(' │ '), chalk.gray('─'.repeat(colWidth * cols.length + 3 * (cols.length - 1))), ...rows].join('\n');
}
