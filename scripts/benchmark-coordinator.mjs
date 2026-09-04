// Isolated synthetic fixture; never opens the caller's workspace.
import { createTempScope } from '../test/helpers.js';
import { createTicket } from '../src/repo.js';
import { claimTicket, createHandoff, parallelPlan, setContract } from '../src/agent-runtime.js';
import { coordinatorView } from '../src/coordinator-view.js';

const { db, cleanup } = createTempScope();
try {
  for (let i = 0; i < 12; i += 1) {
    const ticket = createTicket(db, { type: 'story', title: `Worker ${i}`, description: 'context '.repeat(1500) });
    setContract(db, ticket.id, { policy: { files: [`src/worker-${i}.cpp`] } });
    claimTicket(db, ticket.id, { agent: `worker-${i}`, files: [`src/worker-${i}.cpp`] });
    createHandoff(db, ticket.id, { agent: `worker-${i}`, summary: 'implementation evidence '.repeat(1200),
      remaining: ['Integrate commit and run acceptance'], blockers: [] });
  }
  const baselineModule = process.env.SCOPE_BENCHMARK_BASELINE;
  const fullPlan = baselineModule ? (await import(baselineModule)).parallelPlan(db) : parallelPlan(db);
  const full = JSON.stringify(fullPlan);
  const pages = [];
  let cursor;
  do {
    const page = coordinatorView(db, { cursor });
    pages.push(JSON.stringify(page));
    cursor = page.nextCursor;
  } while (cursor);
  const unchanged = JSON.stringify(coordinatorView(db, { since: JSON.parse(pages[0]).snapshot }));
  console.log(JSON.stringify({ fixture: '12 workers with large durable handoff summaries',
    fullBytes: Buffer.byteLength(full), fullApproxTokens: Math.ceil(full.length / 4),
    compactBytes: pages.reduce((sum, page) => sum + Buffer.byteLength(page), 0),
    compactApproxTokens: Math.ceil(pages.reduce((sum, page) => sum + page.length, 0) / 4),
    pages: pages.length, maximumPageBytes: Math.max(...pages.map((page) => Buffer.byteLength(page))),
    unchangedBytes: Buffer.byteLength(unchanged) }, null, 2));
} finally { cleanup(); }
