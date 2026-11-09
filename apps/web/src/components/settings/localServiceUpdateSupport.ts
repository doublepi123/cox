import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

export function localServiceUpdateSupported(
  environment: Pick<ExecutionEnvironmentDescriptor, "capabilities"> | undefined,
): boolean {
  return environment?.capabilities.localServiceUpdate === true;
}
