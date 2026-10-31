import { requestGuarded } from "../rpc/client.ts";

export function createPullRequestRouter() {
  return requestGuarded;
}
