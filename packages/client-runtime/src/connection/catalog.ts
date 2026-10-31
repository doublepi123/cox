import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { PrimaryConnectionTarget } from "./model.ts";

export interface ConnectionRoute {
  readonly target: PrimaryConnectionTarget;
  readonly profile: Option.Option<never>;
}

export interface ConnectionCatalogEntry extends ConnectionRoute {
  readonly enabled: boolean;
  readonly unsupportedReason?: string;
}

export class PrimaryConnectionRegistration extends Schema.TaggedClass<PrimaryConnectionRegistration>()(
  "PrimaryConnectionRegistration",
  { target: PrimaryConnectionTarget },
) {}

export type PlatformConnectionRegistration = PrimaryConnectionRegistration;

export function connectionRegistrationCatalogEntry(
  registration: PrimaryConnectionRegistration,
): ConnectionCatalogEntry {
  return { target: registration.target, profile: Option.none(), enabled: true };
}
