import type { RelaySignalArgs, ToolRegistry } from 'agentvault-mcp-server/tools';

function normalizeAcceptablePurposes(acceptablePurposes?: string[]): string[] {
  if (!acceptablePurposes?.length) return [];
  const normalized: string[] = [];
  for (const purpose of acceptablePurposes) {
    if (typeof purpose !== 'string' || normalized.includes(purpose)) continue;
    normalized.push(purpose);
  }
  return normalized;
}

export function applyScenarioPurposeDefaults(
  args: RelaySignalArgs,
  acceptablePurposes?: string[],
): RelaySignalArgs {
  const normalized = normalizeAcceptablePurposes(acceptablePurposes);
  if (!normalized.length || args.mode !== 'INITIATE') return args;
  if (args.contract || args.acceptable_contracts?.length || args.acceptable_purposes?.length) {
    return args;
  }

  const nextArgs: RelaySignalArgs = {
    ...args,
    acceptable_purposes: normalized,
  };

  if (typeof nextArgs.purpose === 'string' && normalized.includes(nextArgs.purpose)) {
    delete nextArgs.purpose;
  }

  return nextArgs;
}

export function withScenarioPurposeRegistry(
  registry: ToolRegistry,
  acceptablePurposes?: string[],
): ToolRegistry {
  return {
    ...registry,
    handleRelaySignal(args: RelaySignalArgs) {
      return registry.handleRelaySignal(applyScenarioPurposeDefaults(args, acceptablePurposes));
    },
    dispatch(toolName: string, args: Record<string, unknown>) {
      if (toolName !== 'agentvault.relay_signal') {
        return registry.dispatch(toolName, args);
      }
      return registry.handleRelaySignal(
        applyScenarioPurposeDefaults(args as RelaySignalArgs, acceptablePurposes),
      );
    },
  };
}
