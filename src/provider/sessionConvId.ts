import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

const SESSION_CONV_ENTRY = 'grok-cli-conv-id-v1';

function storedGeneration(
  entry: ReturnType<ExtensionContext['sessionManager']['getBranch']>[number],
) {
  if (entry.type !== 'custom' || entry.customType !== SESSION_CONV_ENTRY) return undefined;
  if (!entry.data || typeof entry.data !== 'object' || Array.isArray(entry.data)) return undefined;
  const generation = (entry.data as Record<string, unknown>).generation;
  return typeof generation === 'number' && Number.isSafeInteger(generation) && generation > 0
    ? generation
    : undefined;
}

export function registerSessionConvId(pi: ExtensionAPI) {
  const generations = new Map<string, number>();
  const convId = (sessionId: string) => {
    const generation = generations.get(sessionId);
    return generation ? `${sessionId}:${generation}` : sessionId;
  };
  const rotate = (sessionId: string) => {
    const generation = (generations.get(sessionId) ?? 0) + 1;
    pi.appendEntry(SESSION_CONV_ENTRY, { generation });
    generations.set(sessionId, generation);
    return convId(sessionId);
  };
  const restore = (ctx: Pick<ExtensionContext, 'sessionManager'>) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const generation = ctx.sessionManager
      .getBranch()
      .reduceRight<number | undefined>(
        (generation, entry) => generation ?? storedGeneration(entry),
        undefined,
      );
    if (generation) generations.set(sessionId, generation);
    else generations.delete(sessionId);
  };

  pi.on('session_start', (_event, ctx) => restore(ctx));
  pi.on('session_tree', (_event, ctx) => restore(ctx));
  pi.on('session_shutdown', (_event, ctx) => {
    generations.delete(ctx.sessionManager.getSessionId());
  });
  pi.registerCommand('grok-cli-conv', {
    description: 'Show or rotate the Grok CLI conversation ID',
    handler: async (args, ctx) => {
      const argument = args.trim().toLowerCase();
      if (argument && argument !== 'status' && argument !== 'rotate') {
        ctx.ui.notify('Usage: /grok-cli-conv [status|rotate]', 'error');
        return;
      }
      const sessionId = ctx.sessionManager.getSessionId();
      ctx.ui.notify(
        argument === 'rotate'
          ? `Grok CLI conversation ID rotated to ${rotate(sessionId)}`
          : `Grok CLI conversation ID: ${convId(sessionId)}`,
        'info',
      );
    },
  });
  return { convId, rotate };
}
