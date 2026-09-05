// Hermetic SCP-339 fixture: never opens the caller's workspace.
import { createTempScope } from '../test/helpers.js';
import { createTicket } from '../src/repo.js';
import { claimTicket, createHandoff, contextPack, setContract } from '../src/agent-runtime.js';

const { db, cleanup } = createTempScope();
try {
  const ticket = createTicket(db, { type: 'story', title: 'Context budget probe', description: 'context '.repeat(1500) });
  setContract(db, ticket.id, { policy: { files: ['src/probe.js'] } });
  claimTicket(db, ticket.id, { agent: 'budget-probe', files: ['src/probe.js'] });
  createHandoff(db, ticket.id, { agent: 'budget-probe', summary: 'implementation evidence '.repeat(1200), remaining: ['Run acceptance'], blockers: [] });
  const pages = [];
  let page = contextPack(db, ticket.id, { budget: 2000 });
  do {
    pages.push(page);
    if (!page.nextCursor) break;
    page = contextPack(db, ticket.id, { budget: 2000, cursor: page.nextCursor });
  } while (true);
  console.log(JSON.stringify({ fixture: 'SCP-339: one story, 12KB description, 28.8KB handoff', budget: 2000,
    firstPageBytes: pages[0].outputBytes, firstPageApproxTokens: pages[0].approximateTokens,
    indexBytes: pages.reduce((sum, item) => sum + item.outputBytes, 0), pages: pages.length,
    maximumPageBytes: Math.max(...pages.map((item) => item.outputBytes)),
    handoffPhraseOccurrences: JSON.stringify(pages).split('implementation evidence ').length - 1,
    complete: pages.at(-1).complete }, null, 2));
} finally { cleanup(); }
