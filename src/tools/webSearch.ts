import { StringEnum, Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { renderRunning, text } from './rendering.js';
import {
  ensureWebSearchDelegate,
  getWebSearchDelegate,
  getWebSearchLoadError,
  PI_WEB_SEARCH_TOOL,
} from './webSearchDelegate.js';

const WEB_SEARCH_DESCRIPTION =
  'Search the web using Perplexity AI, Exa, or Gemini. Returns an AI-synthesized answer with source citations. For comprehensive research, prefer queries (plural) with 2-4 varied angles over a single query — each query gets its own synthesized answer, so varying phrasing and scope gives much broader coverage. When includeContent is true, full page content is fetched in the background. Searches auto-open the interactive browser curator and stream results live; set workflow to "none" to skip curation. Provider auto-selects: Exa (direct API with key, MCP fallback without), else Perplexity (needs key), else Gemini API (needs key), else Gemini Web (needs a supported Chromium-based browser login).';

const WebSearchParams = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        "Single search query. For research tasks, prefer 'queries' with multiple varied angles instead.",
    }),
  ),
  queries: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Multiple queries searched in sequence, each returning its own synthesized answer. Prefer this for research — vary phrasing, scope, and angle across 2-4 queries to maximize coverage.',
    }),
  ),
  numResults: Type.Optional(
    Type.Number({ description: 'Results per query (default: 5, max: 20)' }),
  ),
  includeContent: Type.Optional(Type.Boolean({ description: 'Fetch full page content (async)' })),
  recencyFilter: Type.Optional(
    StringEnum(['day', 'week', 'month', 'year'], { description: 'Filter by recency' }),
  ),
  domainFilter: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Limit to domains (prefix with - to exclude)',
    }),
  ),
  provider: Type.Optional(
    StringEnum(['auto', 'perplexity', 'gemini', 'exa'], {
      description: 'Search provider (default: auto)',
    }),
  ),
  workflow: Type.Optional(
    StringEnum(['none', 'summary-review'], {
      description:
        'Search workflow mode: none = no curator, summary-review = open curator with auto summary draft (default)',
    }),
  ),
});

function normalizeQueryList(raw: unknown[]): string[] {
  return raw
    .filter((q): q is string => typeof q === 'string')
    .map((q) => q.trim())
    .filter((q) => q.length > 0);
}

function queryListFromArgs(args: Record<string, unknown>) {
  const raw: unknown[] = Array.isArray(args.queries)
    ? args.queries
    : args.query !== undefined
      ? [args.query]
      : [];
  return normalizeQueryList(raw);
}

function missingDelegateMessage() {
  const reason =
    getWebSearchLoadError() ??
    'pi-web-access web_search delegate not available. Install with: pi install npm:pi-web-access';
  return {
    content: [
      {
        type: 'text' as const,
        text: `WebSearch requires pi-web-access: ${reason}`,
      },
    ],
    details: { error: reason },
  };
}

export function registerWebSearchTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'WebSearch',
    label: 'Web Search',
    description: WEB_SEARCH_DESCRIPTION,
    promptSnippet:
      'Use for web research questions. Prefer {queries:[...]} with 2-4 varied angles over a single query for broader coverage.',
    parameters: WebSearchParams,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      await ensureWebSearchDelegate(pi);
      const delegate = getWebSearchDelegate();
      if (!delegate) return missingDelegateMessage();
      const normalizedParams = { ...(params as Record<string, unknown>) };
      if (Array.isArray(normalizedParams.queries)) {
        normalizedParams.queries = normalizeQueryList(normalizedParams.queries);
      }
      if (typeof normalizedParams.query === 'string') {
        const query = normalizedParams.query.trim();
        if (query) normalizedParams.query = query;
        if (!query) delete normalizedParams.query;
      }
      return delegate(toolCallId, normalizedParams, signal, onUpdate, ctx);
    },

    renderCall(args, theme) {
      const queryList = queryListFromArgs(args as Record<string, unknown>);
      if (queryList.length === 0) {
        return text(
          theme.fg('toolTitle', theme.bold('WebSearch ')) + theme.fg('error', '(no query)'),
        );
      }
      if (queryList.length === 1) {
        const q = queryList[0];
        const display = q.length > 60 ? `${q.slice(0, 57)}...` : q;
        return text(
          theme.fg('toolTitle', theme.bold('WebSearch ')) + theme.fg('accent', `"${display}"`),
        );
      }
      const lines = [
        theme.fg('toolTitle', theme.bold('WebSearch ')) +
          theme.fg('accent', `${queryList.length} queries`),
      ];
      for (const q of queryList.slice(0, 5)) {
        const display = q.length > 50 ? `${q.slice(0, 47)}...` : q;
        lines.push(theme.fg('muted', `  "${display}"`));
      }
      if (queryList.length > 5) {
        lines.push(theme.fg('muted', `  ... and ${queryList.length - 5} more`));
      }
      return new Text(lines.join('\n'), 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const running = renderRunning(isPartial);
      if (running) return running;

      const details = result.details as { error?: string; totalResults?: number } | undefined;
      if (details?.error) {
        return text(theme.fg('error', `Error: ${details.error}`));
      }

      const summary =
        typeof details?.totalResults === 'number'
          ? theme.fg('success', `${details.totalResults} sources`)
          : theme.fg('success', 'search complete');

      if (!expanded) return text(summary);

      const textContent = result.content.find((c) => c.type === 'text')?.text ?? '';
      const preview = textContent.length > 800 ? `${textContent.slice(0, 800)}...` : textContent;
      return new Text(`${summary}\n${theme.fg('dim', preview)}`, 0, 0);
    },
  });

  pi.on('tool_call', (event, ctx) => {
    if (ctx.model?.provider !== 'grok-cli') return;
    if (event.toolName !== PI_WEB_SEARCH_TOOL) return;
    return {
      block: true,
      reason:
        'web_search is disabled for Grok CLI; use WebSearch instead (same behavior as pi-web-access web_search).',
    };
  });
}
