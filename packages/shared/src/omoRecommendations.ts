import { OmoReasoningLevel, type ModelServiceModel } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isOmoReasoningLevel = Schema.is(OmoReasoningLevel);

export function omoModelReasoningLevels(
  model: Pick<ModelServiceModel, "capabilities" | "supportsReasoning">,
): ReadonlyArray<OmoReasoningLevel> {
  if (model.supportsReasoning === false) return [];
  const descriptor = model.capabilities?.optionDescriptors?.find(
    (option) =>
      option.type === "select" && ["reasoningEffort", "effort", "thinking"].includes(option.id),
  );
  return descriptor?.type === "select"
    ? [
        ...new Set(
          descriptor.options.flatMap((option) => {
            const level = option.id === "none" ? "off" : option.id;
            return isOmoReasoningLevel(level) ? [level] : [];
          }),
        ),
      ]
    : [];
}
