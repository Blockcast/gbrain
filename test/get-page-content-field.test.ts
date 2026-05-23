/**
 * Regression: get_page response must include a raw-markdown `content` field
 * so callers expecting a put_page-shaped string (frontmatter + body) can
 * consume the response without reconstructing it themselves.
 *
 * Surfaced via paperclip's BLO-6388 server-side sweep-wake gate. The gate's
 * parseSweepWakeFramePage looks for `.content` or `.body` string on the
 * gbrain response; both were absent (only `.frontmatter` + `.compiled_truth`
 * were exposed), so the parser returned null → missing_or_invalid_frame →
 * the gate seeded the same page on every sweep, never producing `skip`.
 *
 * This test wires a stub engine that returns a fixed Page, invokes the
 * get_page operation directly, and asserts the response carries `content`
 * that round-trips back through parseMarkdown to the same frontmatter +
 * compiled_truth.
 */

import { describe, test, expect } from 'bun:test';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { parseMarkdown } from '../src/core/markdown.ts';

const STUB_LOGGER = { info: () => {}, warn: () => {}, error: () => {} };
const STUB_CONFIG = {} as unknown as Parameters<typeof operations[number]['handler']>[0]['config'];

function findOp(name: string) {
  const op = operations.find(o => o.name === name);
  if (!op) throw new Error(`operation ${name} not found`);
  return op;
}

interface StubPage {
  id: number;
  source_id: string;
  slug: string;
  type: string;
  title: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
  content_hash: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

function stubEngine(page: StubPage | null) {
  return {
    getPage: async () => page,
    getTags: async () => ['tag-a', 'tag-b'],
    resolveSlugs: async () => [],
  } as unknown as Parameters<typeof operations[number]['handler']>[0]['engine'];
}

function makeCtx(engine: ReturnType<typeof stubEngine>, remote = false): OperationContext {
  return {
    engine,
    config: STUB_CONFIG,
    logger: STUB_LOGGER,
    dryRun: false,
    remote,
    viaSubagent: false,
    jobId: 1,
  } as OperationContext;
}

describe('get_page — content field round-trip (BLO-6388)', () => {
  const get_page = findOp('get_page');

  const seedPage: StubPage = {
    id: 78659,
    source_id: 'default',
    slug: 'paperclip/decisions/co1/agent1/blo-3668',
    type: 'concept',
    title: 'BLO 3668',
    compiled_truth: '',
    timeline: '',
    frontmatter: {
      schemaVersion: 1,
      companyId: 'co1',
      agentId: 'agent1',
      issueIdentifier: 'BLO-3668',
      issueId: 'issue1',
      status: 'todo',
      consecutiveSkips: 0,
      blockedByIssueIds: ['blocker1', 'blocker2'],
      disposition: 'seed',
      nextRefreshTriggers: [],
      issueLastActivityAt: '2026-05-23T20:56:59.225Z',
      updatedAt: '2026-05-23T21:10:57.927Z',
      agentName: 'CEO',
    },
    content_hash: 'sha',
    created_at: new Date('2026-05-23T06:24:24.142Z'),
    updated_at: new Date('2026-05-23T21:10:57.950Z'),
    deleted_at: null,
  };

  test('response includes a content field with raw markdown', async () => {
    const res = (await get_page.handler(makeCtx(stubEngine(seedPage)), { slug: seedPage.slug })) as Record<string, unknown>;
    expect(typeof res.content).toBe('string');
    expect((res.content as string).startsWith('---\n')).toBe(true);
    expect(res.content as string).toContain('issueIdentifier: BLO-3668');
    expect(res.content as string).toContain('schemaVersion: 1');
  });

  test('content round-trips through parseMarkdown to the same frontmatter keys', async () => {
    const res = (await get_page.handler(makeCtx(stubEngine(seedPage)), { slug: seedPage.slug })) as Record<string, unknown>;
    const parsed = parseMarkdown(res.content as string, seedPage.slug + '.md');
    expect(parsed.frontmatter.issueIdentifier).toBe('BLO-3668');
    expect(parsed.frontmatter.schemaVersion).toBe(1);
    expect(parsed.frontmatter.companyId).toBe('co1');
    expect(parsed.frontmatter.agentId).toBe('agent1');
    expect(parsed.frontmatter.blockedByIssueIds).toEqual(['blocker1', 'blocker2']);
  });

  test('content reflects the privacy-stripped compiled_truth for remote callers', async () => {
    // Page body contains a takes fence row that the remote strip should drop.
    const withFence: StubPage = {
      ...seedPage,
      compiled_truth: [
        'preamble',
        '<!--- gbrain:takes:begin -->',
        '| holder | claim | weight |',
        '|---|---|---|',
        '| brain | PRIVATE_CLAIM | 0.9 |',
        '<!--- gbrain:takes:end -->',
        'postamble',
      ].join('\n'),
    };
    const res = (await get_page.handler(makeCtx(stubEngine(withFence), /* remote */ true), { slug: seedPage.slug })) as Record<string, unknown>;
    expect(res.content as string).not.toContain('PRIVATE_CLAIM');
    expect(res.content as string).toContain('preamble');
  });
});
