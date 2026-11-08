import { createServer, type Server } from "node:http";

type ResourceState = "ready" | "cors-blocked" | "unavailable";

const resources = new Map<string, { server: Server; state: ResourceState }>();

export async function startAnswerImageResources(image: string): Promise<string> {
  const png = Buffer.from(image.split(",")[1]!, "base64");
  const resource = {
    state: "cors-blocked" as ResourceState,
    server: createServer((request, response) => {
      response.setHeader("Cache-Control", "no-store");
      if (resource.state !== "cors-blocked") {
        response.setHeader("Access-Control-Allow-Origin", "*");
      }
      if (request.url?.split("?")[0] === "/redirect.png") {
        response.writeHead(302, { Location: "/image.png" });
        response.end();
      } else if (
        resource.state === "unavailable" &&
        request.headers["sec-fetch-dest"] !== "image"
      ) {
        response.writeHead(503, { "Content-Type": "text/plain" });
        response.end("Unavailable");
      } else {
        response.writeHead(200, { "Content-Type": "image/png" });
        response.end(png);
      }
    }),
  };
  await new Promise<void>((resolve, reject) => {
    resource.server.once("error", reject);
    resource.server.listen(0, "127.0.0.1", resolve);
  });
  const address = resource.server.address();
  if (!address || typeof address === "string") throw new Error("Missing resource server port");
  const origin = `http://127.0.0.1:${address.port}`;
  resources.set(origin, resource);
  return origin;
}

export function setAnswerImageResourceState(origin: string, state: ResourceState): void {
  const resource = resources.get(origin);
  if (!resource) throw new Error("Unknown resource server");
  resource.state = state;
}

export async function stopAnswerImageResources(origin: string): Promise<void> {
  const resource = resources.get(origin);
  if (!resource) return;
  resources.delete(origin);
  resource.server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    resource.server.close((error) => (error ? reject(error) : resolve()));
  });
}
